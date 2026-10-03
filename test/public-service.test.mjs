import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createPublicShelfServer, PUBLIC_EXAMPLE_IDS } from "../lib/public-server.mjs";
import { makeTempDir } from "./helpers.mjs";
import { validBookHtml } from "./api-helpers.mjs";

const ORIGIN = "https://shelf.example";
const cookies = response => (response.headers.getSetCookie?.() || [response.headers.get("set-cookie")]).filter(Boolean).map(cookie => cookie.split(";")[0]);

async function start(t, options = {}) {
  const root = options.root || makeTempDir(t), publicDir = path.join(root, "public"), dataDir = path.join(root, "data");
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, "index.html"), '<html><head><script src="shelf.js"></script></head><body>官网</body></html>');
  fs.writeFileSync(path.join(publicDir, "shelf.js"), "window.example=true;");
  for (const id of PUBLIC_EXAMPLE_IDS) {
    const directory = path.join(publicDir, "projects", id, "books", "main");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "index.html"), validBookHtml.replace("<style>", `<title>${id}</title><style>`));
  }
  const oauthCalls = [];
  const environment = { SHELF_PUBLIC_ORIGIN: ORIGIN, GITHUB_CLIENT_ID: "client-test", GITHUB_CLIENT_SECRET: "secret-test", ...options.environment };
  const modelClient = options.modelClient || { getStatus: () => ({ configured: true }), complete: async () => validBookHtml };
  const server = createPublicShelfServer({ dataDir, publicDir, environment, modelClient, githubLoader: options.githubLoader,
    fetchImpl: async (url, init) => {
      oauthCalls.push({ url, init });
      if (url.endsWith("access_token")) return Response.json({ access_token: "provider-token-" + JSON.parse(init.body).code });
      const id = Number(init.headers.authorization.split("-").at(-1));
      return Response.json({ id, login: "user-" + id, name: "Reader " + id });
    },
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const pageOwners = new Map();
  const request = (url, { cookie, owner = pageOwners.get(cookie), method = "GET", body, origin = ORIGIN, ...rest } = {}) => fetch(base + url, {
    method, redirect: "manual", headers: { ...(cookie ? { cookie } : {}), ...(owner ? { "x-shelf-owner": owner } : {}), ...(method !== "GET" && origin ? { origin } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...rest,
  });
  async function login(id = 101, returnTo = "/#library") {
    const begin = await request("/auth/github?returnTo=" + encodeURIComponent(returnTo));
    const state = new URL(begin.headers.get("location")).searchParams.get("state");
    const result = await request("/auth/github/callback?code=" + id + "&state=" + state, { cookie: cookies(begin).join("; ") });
    assert.equal(result.status, 302);
    const cookie = cookies(result).find(cookie => cookie.startsWith("__Host-shelf-session="));
    pageOwners.set(cookie, "github-" + id);
    return { cookie, begin, result, state };
  }
  return { root, server, request, login, oauthCalls, dataDir, publicDir };
}

test("public guests see only three explicit examples; missing OAuth configuration is honestly unavailable", async t => {
  const app = await start(t, { environment: { GITHUB_CLIENT_SECRET: "" } });
  const account = await (await app.request("/api/account")).json();
  assert.equal(account.authenticated, false); assert.equal(account.login.configured, false); assert.match(account.login.reason, /尚未配置/);
  assert.equal((await app.request("/auth/github")).status, 503);
  const examples = await (await app.request("/api/examples")).json();
  assert.deepEqual(examples.projects.map(project => project.id), PUBLIC_EXAMPLE_IDS);
  assert.ok(examples.projects.every(project => project.mainBook.url.startsWith("/examples/")));
  assert.equal((await app.request("/api/examples/not-public/preview")).status, 404);
  for (const url of ["/api/library/backup", "/projects/pupkit/books/main/", "/data/pupkit.json", "/api/projects/private/preview"]) assert.equal((await app.request(url)).status, 401);
  assert.equal((await app.request("/api/projects/import", { method: "POST", body: {} })).status, 401);
  const page = await app.request("/examples/pupkit/books/main/");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(!html.includes('src="/notes.js"')); assert.ok(!html.includes('src="/explore.js"'));
  assert.match(page.headers.get("content-security-policy"), /strict-dynamic/);
});

test("OAuth uses state, PKCE, one-use challenge, secure cookie and revalidated numeric identity without persisting provider token", async t => {
  const app = await start(t);
  const login = await app.login(101, "//evil.example/");
  const authorize = new URL(login.begin.headers.get("location"));
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorize.searchParams.get("scope"), "read:user");
  assert.equal(login.result.headers.get("location"), "/#library");
  const headers = login.result.headers.getSetCookie().join(";");
  assert.match(headers, /HttpOnly/); assert.match(headers, /Secure/); assert.match(headers, /SameSite=Lax/);
  assert.ok(JSON.parse(app.oauthCalls[0].init.body).code_verifier);
  const account = await (await app.request("/api/account", { cookie: login.cookie })).json();
  assert.equal(account.user.id, "github-101"); assert.equal(account.usage.generation.remaining, 3);
  assert.equal((await app.request("/auth/github/callback?code=101&state=" + login.state, { cookie: cookies(login.begin).join("; ") })).status, 400);
  const sessions = path.join(app.dataDir, "public-service", "auth", "sessions");
  assert.ok(fs.readdirSync(sessions).every(name => !fs.readFileSync(path.join(sessions, name), "utf8").includes("provider-token")));
  const mismatch = await app.request("/auth/github");
  const state = new URL(mismatch.headers.get("location")).searchParams.get("state");
  assert.equal((await app.request("/auth/github/callback?code=101&state=" + state)).status, 400);
});

test("login rate does not trust forwarded headers unless a loopback proxy is explicitly configured", async t => {
  const direct = await start(t, { environment: { SHELF_LOGIN_RATE_LIMIT: "1" } });
  assert.equal((await direct.request("/auth/github", { headers: { "x-forwarded-for": "198.51.100.1" } })).status, 302);
  assert.equal((await direct.request("/auth/github", { headers: { "x-forwarded-for": "198.51.100.2" } })).status, 429);
  const proxy = await start(t, { environment: { SHELF_LOGIN_RATE_LIMIT: "1", SHELF_TRUST_PROXY: "loopback" } });
  assert.equal((await proxy.request("/auth/github", { headers: { "x-forwarded-for": "198.51.100.1" } })).status, 302);
  assert.equal((await proxy.request("/auth/github", { headers: { "x-forwarded-for": "198.51.100.2" } })).status, 302);
  assert.equal((await proxy.request("/auth/github", { headers: { "x-forwarded-for": "1.1.1.1, 198.51.100.1" } })).status, 429);
});

test("an invite list admits only listed numeric GitHub ids and closes sessions of everyone else", async t => {
  const open = await start(t);
  const outsider = await open.login(202);
  await new Promise(resolve => open.server.close(resolve));
  const invited = await start(t, { root: open.root, environment: { SHELF_ALLOWED_GITHUB_IDS: "101, user-303" } });
  assert.equal((await (await invited.request("/api/account", { cookie: outsider.cookie })).json()).authenticated, false);
  const begin = await invited.request("/auth/github");
  const state = new URL(begin.headers.get("location")).searchParams.get("state");
  const refused = await invited.request("/auth/github/callback?code=202&state=" + state, { cookie: cookies(begin).join("; ") });
  assert.equal(refused.status, 403);
  assert.ok(!cookies(refused).some(cookie => cookie.startsWith("__Host-shelf-session=") && cookie.length > "__Host-shelf-session=".length));
  const member = await invited.login(101);
  assert.equal((await (await invited.request("/api/account", { cookie: member.cookie })).json()).user.id, "github-101");
  const nobody = await start(t, { environment: { SHELF_ALLOWED_GITHUB_IDS: "not-a-number" } });
  const closedBegin = await nobody.request("/auth/github");
  const closedState = new URL(closedBegin.headers.get("location")).searchParams.get("state");
  assert.equal((await nobody.request("/auth/github/callback?code=101&state=" + closedState, { cookie: cookies(closedBegin).join("; ") })).status, 403);
});

test("two accounts can use the same project id without sharing source, notes, books or backups; mutation requires Origin", async t => {
  const app = await start(t), a = await app.login(101), b = await app.login(202);
  for (const [person, content] of [[a, "owner A"], [b, "owner B"]]) {
    const input = { projectId: "same-project", name: "Owned", files: [{ path: "src/main.js", content }] };
    assert.equal((await app.request("/api/projects/import", { method: "POST", cookie: person.cookie, body: input, origin: null })).status, 403);
    assert.equal((await app.request("/api/projects/import", { method: "POST", cookie: person.cookie, body: input, origin: "https://evil.example" })).status, 403);
    const result = await (await app.request("/api/projects/import", { method: "POST", cookie: person.cookie, body: input })).json();
    const file = await (await app.request(`/api/projects/same-project/snapshots/${result.project.currentSnapshotId}/file?path=src/main.js`, { cookie: person.cookie })).json();
    assert.equal(file.content, content);
    const backup = await (await app.request("/api/library/backup", { cookie: person.cookie })).json();
    assert.ok(backup.files.some(file => Buffer.from(file.data, "base64").toString() === content));
    assert.ok(!backup.files.some(file => Buffer.from(file.data, "base64").toString() === (content === "owner A" ? "owner B" : "owner A")));
  }
  const note = { id: "note-one", text: "Only A" };
  assert.equal((await app.request("/api/projects/same-project/books/main/notes", { cookie: a.cookie, method: "POST", body: { note } })).status, 200);
  assert.deepEqual(await (await app.request("/api/projects/same-project/books/main/notes", { cookie: b.cookie })).json(), []);
  const c = await app.login(303);
  assert.equal((await app.request("/projects/same-project/books/main/", { cookie: c.cookie })).status, 404);
  assert.equal((await app.request("/projects/same-project/books/main/data/main.json", { cookie: a.cookie })).status, 404);
  const status = await (await app.request("/api/status")).json();
  assert.equal(status.dataDir, undefined); assert.equal(status.model.url, undefined);
  const index = await (await app.request("/", { cookie: a.cookie })).text();
  assert.ok(index.indexOf('"userId":"github-101"') < index.indexOf('src="shelf.js"'));
});

test("generation quota reserves pending work, settles actual book delivery once, preserves idempotent imports, and releases failure", async t => {
  let finish, calls = 0;
  const app = await start(t, { environment: { SHELF_GENERATION_LIMIT: "1" }, modelClient: { complete: () => { calls++; return new Promise(resolve => { finish = resolve; }); } } });
  const { cookie } = await app.login();
  const input = { projectId: "first", name: "First", files: [{ path: "main.js", content: "source" }] };
  await app.request("/api/projects/import", { cookie, method: "POST", body: input });
  let account = await (await app.request("/api/account", { cookie })).json();
  assert.equal(account.usage.generation.reserved, 1); assert.equal(account.usage.generation.used, 0);
  assert.equal((await app.request("/api/projects/import", { cookie, method: "POST", body: { ...input, projectId: "second" } })).status, 429);
  assert.equal((await app.request("/api/projects/import", { cookie, method: "POST", body: input })).status, 200);
  assert.equal(calls, 1);
  finish(validBookHtml);
  for (let i = 0; i < 10; i++) {
    account = await (await app.request("/api/account", { cookie })).json();
    if (account.usage.generation.used) break;
  }
  assert.equal(account.usage.generation.used, 1); assert.equal(account.usage.generation.reserved, 0);
  assert.equal((await app.request("/api/projects/first/generation", { cookie, method: "POST", body: {} })).status, 429);
  const failure = await start(t, { environment: { SHELF_GENERATION_LIMIT: "1" }, modelClient: { complete: async () => { throw new Error("controlled failure"); } } });
  const login = await failure.login();
  await failure.request("/api/projects/import", { cookie: login.cookie, method: "POST", body: input });
  const failedAccount = await (await failure.request("/api/account", { cookie: login.cookie })).json();
  assert.deepEqual(failedAccount.usage.generation, { limit: 1, used: 0, reserved: 0, remaining: 1 });
  assert.equal(failedAccount.usage.model.used, 1);
});

test("all model endpoints share per-user daily call budget, sessions survive restart and logout invalidates them", async t => {
  const app = await start(t, { environment: { SHELF_DAILY_MODEL_LIMIT: "1" } });
  const { cookie } = await app.login();
  assert.equal((await app.request("/api/explain", { cookie, method: "POST", body: { question: "hello" } })).status, 200);
  assert.equal((await app.request("/api/followup", { cookie, method: "POST", body: { question: "again" } })).status, 429);
  await new Promise(resolve => app.server.close(resolve));
  const restarted = await start(t, { root: app.root });
  assert.equal((await (await restarted.request("/api/account", { cookie })).json()).user.id, "github-101");
  assert.equal((await restarted.request("/auth/logout", { cookie, owner: "github-101", method: "POST", body: {} })).status, 200);
  assert.equal((await (await restarted.request("/api/account", { cookie })).json()).authenticated, false);
});

test("an old account A page cannot read, write, generate or log out account B after another tab switches accounts", async t => {
  const app = await start(t), a = await app.login(101), b = await app.login(202);
  for (const person of [a, b]) await app.request("/api/projects/import", { cookie: person.cookie, method: "POST", body: { projectId: "same", name: "Own", files: [{ path: "main.js", content: "source" }] } });
  for (const [url, method, body] of [
    ["/api/projects/same/preview", "GET"],
    ["/projects/same/books/main/", "GET"],
    ["/api/projects/same/books/main/notes", "GET"],
    ["/api/library/backup", "GET"],
    ["/api/projects/same/books/main/notes", "POST", { note: { id: "a-draft", text: "A private draft" } }],
    ["/api/projects/same/generation", "POST", {}],
    ["/auth/logout", "POST", {}],
  ]) {
    const response = await app.request(url, { cookie: b.cookie, owner: "github-101", method, body });
    assert.equal(response.status, 409, url); assert.equal((await response.json()).error.kind, "account-changed");
  }
  assert.deepEqual(await (await app.request("/api/projects/same/books/main/notes", { cookie: b.cookie })).json(), []);
  assert.equal((await (await app.request("/api/account", { cookie: b.cookie })).json()).user.id, "github-202");
  assert.equal((await app.request("/api/projects", { cookie: b.cookie, owner: "guest" })).status, 409);
  assert.equal((await app.request("/api/projects", { owner: "github-101" })).status, 401);
  assert.equal((await app.request("/api/projects", { cookie: b.cookie, owner: "" })).status, 403);
});

test("a disconnected GitHub import releases its reservation when the server-side import fails", async t => {
  let failImport, started;
  const began = new Promise(resolve => { started = resolve; });
  const app = await start(t, { githubLoader: async () => {
    started(); return new Promise((resolve, reject) => { failImport = reject; });
  } });
  const { cookie } = await app.login();
  const controller = new AbortController();
  const pending = app.request("/api/projects/import-github", { cookie, method: "POST", body: { projectId: "disconnect", repo: "owner/repo" }, signal: controller.signal });
  await began;
  assert.equal((await (await app.request("/api/account", { cookie })).json()).usage.generation.reserved, 1);
  controller.abort(); await assert.rejects(pending, error => error.name === "AbortError");
  failImport(new Error("controlled repository failure"));
  let usage;
  for (let i = 0; i < 10; i++) {
    usage = (await (await app.request("/api/account", { cookie })).json()).usage;
    if (usage.generation.reserved === 0) break;
  }
  assert.equal(usage.generation.reserved, 0); assert.equal(usage.generation.used, 0); assert.equal(usage.model.used, 0);
});

test("private reader strips model executable markup and only grants nonces to trusted runtime scripts", async t => {
  const evil = validBookHtml.replace("<p>正文</p>", '<p onclick="steal()">正文<a href="javascript:steal()">点我</a><iframe src="/api/library/backup"></iframe><img src=x onerror=steal()></p>').replace("void 0", 'window.stolen=fetch("/api/library/backup")');
  const app = await start(t, { modelClient: { complete: async () => evil } });
  const { cookie } = await app.login();
  await app.request("/api/projects/import", { cookie, method: "POST", body: { projectId: "unsafe", name: "Unsafe", files: [{ path: "main.js", content: "text" }] } });
  const response = await app.request("/projects/unsafe/books/main/", { cookie }), html = await response.text();
  assert.equal(response.status, 200);
  for (const dangerous of ["onclick=", "onerror=", "javascript:", "<iframe", "window.stolen", "steal()"] ) assert.ok(!html.includes(dangerous), dangerous);
  assert.match(html, /src="\/notes.js"/);
  const nonce = response.headers.get("content-security-policy").match(/'nonce-([^']+)'/)[1];
  assert.ok([...html.matchAll(/<script\b([^>]*)>/g)].every(match => match[1].includes(`nonce="${nonce}"`)));
  assert.ok(!response.headers.get("content-security-policy").split(";").find(part => part.includes("script-src")).includes("unsafe-inline"));
});

test("public main book, source-backed notes, exploration retry and idempotent child book stay private and share truthful usage", async t => {
  const prompts = []; let failExploration = true;
  const app = await start(t, { modelClient: { complete: async ({ prompt, maxTokens }) => {
    prompts.push(prompt);
    if (maxTokens >= 16000) return validBookHtml;
    if (prompt.includes("只输出 JSON 数组")) return JSON.stringify([{ title: "greet 的参数", rationale: "src/main.js 包含参数与返回。" }, { title: "greet 的返回值", rationale: "src/main.js 展示完整返回路径。" }]);
    if (prompt.includes("沿着一本项目讲解书探索一个新方向") && failExploration) { failExploration = false; throw new Error("controlled exploration failure"); }
    return "greet 根据 src/main.js 返回传入的名字。";
  } } });
  const a = await app.login(101), b = await app.login(202), base = "/api/projects/chain";
  const imported = await (await app.request("/api/projects/import", { cookie: a.cookie, method: "POST", body: { projectId: "chain", name: "Chain", files: [{ path: "src/main.js", content: "export function greet(name) { return name; }" }] } })).json();
  assert.equal((await (await app.request(base + "/generation", { cookie: a.cookie })).json()).generation.status, "ready");
  const explanation = await (await app.request(base + "/books/main/explain", { cookie: a.cookie, method: "POST", body: { question: "greet 怎么工作？", selection: "greet" } })).json();
  assert.ok(explanation.sourceRefs.some(ref => ref.path === "src/main.js"));
  const followup = await (await app.request(base + "/books/main/followup", { cookie: a.cookie, method: "POST", body: { instruction: "说明返回值", currentText: explanation.content } })).json();
  await app.request(base + "/books/main/notes", { cookie: a.cookie, method: "POST", body: { note: { id: "chain-note", text: followup.content } } });
  const notes = await (await app.request(base + "/books/main/notes?revisions=1", { cookie: a.cookie })).json();
  assert.equal(notes[0].text, followup.content); assert.equal(notes[0].revision, 1);
  const session = (await (await app.request(base + "/explorations", { cookie: a.cookie, method: "POST", body: { originBookId: "main", sourceSnapshotId: imported.project.currentSnapshotId } })).json()).session;
  const sessionPath = base + "/explorations/" + session.id;
  const failed = (await (await app.request(sessionPath + "/messages", { cookie: a.cookie, method: "POST", body: { prompt: "深入解释 greet" } })).json()).assistantMessage;
  assert.equal(failed.status, "failed");
  const answer = (await (await app.request(sessionPath + "/messages/" + failed.id + "/retry", { cookie: a.cookie, method: "POST", body: {} })).json()).assistantMessage;
  assert.equal(answer.status, "complete"); assert.equal(answer.id, failed.id); assert.ok(answer.sourceRefs.length);
  const bookRequest = { cookie: a.cookie, method: "POST", body: { answerMessageId: answer.id, title: "greet 机制", parentBookId: "main" } };
  const first = (await (await app.request(sessionPath + "/books", bookRequest)).json()).book;
  const second = (await (await app.request(sessionPath + "/books", bookRequest)).json()).book;
  assert.equal(first.id, second.id); assert.equal(first.sourceSnapshotId, imported.project.currentSnapshotId);
  assert.equal(first.originAnswerMessageId, answer.id);
  const childPage = await app.request(first.url, { cookie: a.cookie });
  assert.equal(childPage.status, 200); assert.match(await childPage.text(), /greet.*src\/main.js/);
  assert.match(childPage.headers.get("content-security-policy"), /strict-dynamic/);
  const preview = await (await app.request(base + "/preview", { cookie: a.cookie })).json();
  assert.equal(preview.bookCount, 2); assert.equal(preview.books[0].originExplorationId, session.id);
  for (const endpoint of [base + "/books/main/notes", sessionPath, first.url]) assert.equal((await app.request(endpoint, { cookie: b.cookie })).status, 404);
  const stored = (await (await app.request(sessionPath, { cookie: a.cookie })).json()).session;
  assert.equal(stored.messages.length, 2); assert.equal(stored.messages[1].status, "complete");
  const usage = (await (await app.request("/api/account", { cookie: a.cookie })).json()).usage;
  assert.deepEqual(usage.generation, { limit: 3, used: 1, reserved: 0, remaining: 2 });
  assert.equal(usage.model.used, 5); assert.equal(prompts.length, 5);
  assert.ok(prompts.every(prompt => prompt.includes("src/main.js")));
});

test("public personal-data archive, export, backup and restore use only the authenticated tenant and preserve conflicts", async t => {
  const app = await start(t), a = await app.login(101), b = await app.login(202);
  for (const [person, id] of [[a, "personal"], [b, "other"]]) {
    assert.equal((await app.request("/api/projects/import", { cookie: person.cookie, method: "POST", body: { projectId: id, name: id, files: [{ path: "src/main.js", content: "source of " + id }] } })).status, 201);
  }
  const personal = "/api/projects/personal";
  await app.request(personal + "/books/main/notes", { cookie: a.cookie, method: "POST", body: { note: { id: "saved-note", text: "Saved personal note" } } });
  assert.equal((await app.request(personal + "/archive", { cookie: a.cookie, method: "POST", body: { archived: true } })).status, 200);
  const projectsA = (await (await app.request("/api/projects", { cookie: a.cookie })).json()).projects;
  assert.equal(projectsA.find(project => project.id === "personal").archived, true);
  assert.equal((await app.request(personal + "/archive", { cookie: b.cookie, method: "POST", body: { archived: false } })).status, 404);
  assert.equal((await app.request(personal + "/export", { cookie: b.cookie })).status, 404);
  assert.equal((await app.request(personal + "/archive", { cookie: a.cookie, method: "POST", body: { archived: false } })).status, 200);
  const backup = await (await app.request("/api/library/backup", { cookie: a.cookie })).json();
  const exported = await app.request(personal + "/export", { cookie: a.cookie });
  assert.equal(exported.status, 200); assert.match(exported.headers.get("content-disposition"), /attachment/);
  assert.deepEqual((await exported.json()).projectIds, ["personal"]);
  assert.deepEqual(backup.projectIds, ["personal"]);
  assert.ok(backup.files.some(file => file.path.endsWith("/main.json") && Buffer.from(file.data, "base64").toString().includes("Saved personal note")));
  assert.equal((await app.request("/api/library/restore", { method: "POST", body: backup })).status, 401);
  assert.equal((await app.request("/api/library/restore", { cookie: b.cookie, origin: "https://elsewhere.invalid", method: "POST", body: backup })).status, 403);
  assert.equal((await app.request("/api/library/restore", { cookie: b.cookie, owner: "github-101", method: "POST", body: backup })).status, 409);
  const conflict = await app.request("/api/library/restore", { cookie: a.cookie, method: "POST", body: backup });
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error.kind, "restore-conflict");
  assert.equal((await app.request("/api/library/restore", { cookie: b.cookie, method: "POST", body: backup })).status, 201);
  const restored = (await (await app.request("/api/projects", { cookie: b.cookie })).json()).projects;
  assert.deepEqual(restored.map(project => project.id).sort(), ["other", "personal"]);
  assert.equal((await app.request("/projects/personal/books/main/", { cookie: b.cookie })).status, 200);
  assert.equal((await (await app.request(personal + "/books/main/notes", { cookie: b.cookie })).json())[0].text, "Saved personal note");
  await app.request(personal + "/archive", { cookie: b.cookie, method: "POST", body: { archived: true } });
  assert.equal((await (await app.request("/api/projects", { cookie: a.cookie })).json()).projects[0].archived, false);
  const usage = (await (await app.request("/api/account", { cookie: b.cookie })).json()).usage;
  assert.equal(usage.generation.used, 1); assert.equal(usage.model.used, 1);
});
