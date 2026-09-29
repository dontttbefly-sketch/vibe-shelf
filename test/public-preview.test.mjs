import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const realProjectIds = ["pupkit", "learn-claude-code", "llm-evolution-course"];

function fileHashes(root) {
  const hashes = {};
  function visit(directory, relative = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const key = path.join(relative, entry.name), full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full, key);
      else if (entry.isFile() && entry.name !== ".DS_Store") hashes[key] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
    }
  }
  visit(root);
  return hashes;
}

async function startPreview(t, args = [], environment = {}) {
  const script = fileURLToPath(new URL("../scripts/preview-public-product.mjs", import.meta.url));
  const child = spawn(process.execPath, [script, "--port", "0", ...args], { env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"] });
  const stopped = new Promise(resolve => child.once("exit", resolve));
  let fixture, output = "", errors = "";
  child.stderr.on("data", data => { errors += data; });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await stopped;
    if (fixture?.root && fixture.mode !== "live") fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  fixture = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`Preview exited before startup: ${code}; ${errors}`)));
    child.stdout.on("data", data => {
      output += data;
      if (output.includes("\n")) { try { resolve(JSON.parse(output.split("\n")[0])); } catch (error) { reject(error); } }
    });
  });
  return { ...fixture, stop: async () => { if (child.exitCode === null) child.kill("SIGTERM"); await stopped; }, get output() { return output; }, get errors() { return errors; } };
}

test("local acceptance harness preserves the three real books and offers explicit same-origin test login without generation", { timeout: 15000 }, async t => {
  const originals = realProjectIds.flatMap(id => ["data", "public"].map(area => ({
    id, area, hashes: fileHashes(path.join(repo, area, "projects", id)),
  })));
  const fixture = await startPreview(t);
  assert.match(fixture.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(fs.statSync(fixture.cookieFile).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(fixture.output.split("\n")[0])).sort(), ["backup", "cookieFile", "mode", "privateRoot", "root", "url"]);
  assert.equal(fixture.mode, "controlled");
  assert.equal(fixture.backup, null);
  const guest = await (await fetch(fixture.url + "/api/account")).json();
  assert.deepEqual(guest.preview, { local: true, live: false, sessionUrl: "/__acceptance/session" });

  const acceptance = await fetch(fixture.url + "/__acceptance");
  const html = await acceptance.text();
  assert.equal(acceptance.status, 200);
  assert.match(html, /不消耗真实账户额度/); assert.match(html, /不代表真实模型/);
  assert.match(html, /<form method="post" action="\/__acceptance\/session">/);
  assert.ok(acceptance.headers.get("content-security-policy").includes("form-action 'self'"));
  const login = await fetch(fixture.url + "/auth/github?returnTo=%2F%23upload", { redirect: "manual" });
  assert.equal(login.status, 302); assert.equal(login.headers.get("location"), "/__acceptance");
  assert.equal((await fetch(fixture.url + "/__acceptance/session", { redirect: "manual" })).status, 405);
  for (const headers of [{}, { Origin: "https://elsewhere.invalid" }, { Origin: fixture.url, "Sec-Fetch-Site": "cross-site" }]) {
    const denied = await fetch(fixture.url + "/__acceptance/session", { method: "POST", headers, redirect: "manual" });
    assert.equal(denied.status, 403); assert.equal(denied.headers.get("set-cookie"), null);
  }
  const established = await fetch(fixture.url + "/__acceptance/session", { method: "POST", headers: { Origin: fixture.url }, redirect: "manual" });
  assert.equal(established.status, 302); assert.equal(established.headers.get("location"), "/#upload");
  const rawCookie = established.headers.get("set-cookie");
  assert.match(rawCookie, /^shelf-session=[A-Za-z0-9_-]{43};/); assert.match(rawCookie, /HttpOnly; SameSite=Lax/);
  const account = await (await fetch(fixture.url + "/api/account", { headers: { Cookie: rawCookie.split(";")[0] } })).json();
  assert.equal(account.authenticated, true); assert.equal(account.user.name, "流程验收账户");
  assert.deepEqual(account.preview, guest.preview);
  assert.equal(account.usage.generation.used, 0);
  assert.equal(account.usage.generation.reserved, 0);
  assert.equal(account.usage.model.used, 0);
  const headers = { Cookie: rawCookie.split(";")[0], "x-shelf-owner": account.user.id };
  const catalog = await (await fetch(fixture.url + "/api/projects", { headers })).json();
  assert.deepEqual(catalog.projects.map(project => project.id).sort(), [...realProjectIds].sort());
  assert.ok(catalog.projects.every(project => project.mainBookId === "main" && project.bookCount === 1));
  for (const id of realProjectIds) {
    const reading = await fetch(fixture.url + `/projects/${id}/books/main/`, { headers });
    assert.equal(reading.status, 200);
    assert.match(await reading.text(), /data-shelf-reader/);
  }
  const tenantRoot = path.join(fixture.root, "data", "public-service", "users", account.user.id);
  for (const { id, area, hashes } of originals) {
    assert.deepEqual(fileHashes(path.join(tenantRoot, area === "public" ? "books" : "data", "projects", id)), hashes, `copied ${area}/${id} contents`);
    assert.deepEqual(fileHashes(path.join(repo, area, "projects", id)), hashes, `original ${area}/${id} remains unchanged`);
  }
  assert.ok(!fixture.output.includes("shelf-session=")); assert.equal(fixture.errors, "");
});

test("performance acceptance keeps its 120 synthetic books separate from real books", { timeout: 15000 }, async t => {
  const fixture = await startPreview(t, ["--performance"]);
  const stored = JSON.parse(fs.readFileSync(fixture.cookieFile, "utf8"));
  const headers = { Cookie: stored.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; "), "x-shelf-owner": "github-900002" };
  const catalog = await (await fetch(fixture.url + "/api/projects", { headers })).json();
  assert.equal(catalog.projects.length, 120);
  assert.ok(catalog.projects.every(project => /^perf-\d{3}$/.test(project.id)));
  const account = await (await fetch(fixture.url + "/api/account", { headers })).json();
  assert.equal(account.user.id, "github-900002");
  assert.equal(account.usage.generation.used, 0);
  assert.equal(account.usage.model.used, 0);
  const examples = await (await fetch(fixture.url + "/api/examples")).json();
  assert.deepEqual(examples.projects.map(project => project.id).sort(), [...realProjectIds].sort());
  assert.ok(!fs.existsSync(path.join(fixture.root, "data", "public-service", "users", "github-900001")));
  assert.equal(fixture.errors, "");
});

test("live preview migrates existing sessions and books, then preserves changes across restart without model requests", { timeout: 15000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shelf-live-preview-test-"));
  // Every model setting is explicitly overridden: this test cannot use .env
  // credentials, and startup/reading/archive never call complete().
  const environment = { SHELF_PUBLIC_DATA_DIR: path.join(directory, "live"), SHELF_API_URL: "", SHELF_API_KEY: "", SHELF_MODEL: "" };
  let live, restarted;
  t.after(async () => { await live?.stop(); await restarted?.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  const original = await startPreview(t);
  const cookie = JSON.parse(fs.readFileSync(original.cookieFile, "utf8")).cookies.map(item => `${item.name}=${item.value}`).join("; ");
  await original.stop();
  const before = fileHashes(original.privateRoot);
  live = await startPreview(t, ["--live", "--migrate-from", original.privateRoot], environment);
  assert.equal(live.mode, "live"); assert.ok(live.backup);
  assert.equal(live.root, fs.realpathSync(environment.SHELF_PUBLIC_DATA_DIR));
  assert.deepEqual(fileHashes(original.privateRoot), before);
  const headers = { Cookie: cookie, "x-shelf-owner": "github-900001" };
  const account = await (await fetch(live.url + "/api/account", { headers })).json();
  assert.equal(account.authenticated, true);
  assert.equal(account.user.name, "本机体验账户");
  assert.deepEqual(account.preview, { local: true, live: true, sessionUrl: "/__acceptance/session" });
  assert.equal(account.usage.model.used, 0);
  const status = await (await fetch(live.url + "/api/status")).json();
  assert.equal(status.model.configured, false);
  const acceptance = await (await fetch(live.url + "/__acceptance")).text();
  assert.match(acceptance, /真实公开源码/); assert.match(acceptance, /实际用量/); assert.doesNotMatch(acceptance, /等待约 6 秒/);
  const archived = await fetch(live.url + "/api/projects/pupkit/archive", { method: "POST", headers: { ...headers, Origin: live.url, "Content-Type": "application/json" }, body: JSON.stringify({ archived: true }) });
  assert.equal(archived.status, 200);
  await live.stop();
  restarted = await startPreview(t, ["--live"], environment);
  assert.equal(restarted.backup, null);
  const catalog = await (await fetch(restarted.url + "/api/projects", { headers })).json();
  assert.deepEqual(catalog.projects.map(project => project.id).sort(), [...realProjectIds].sort());
  assert.equal(catalog.projects.find(project => project.id === "pupkit").archived, true);
  const retained = await (await fetch(restarted.url + "/api/account", { headers })).json();
  assert.equal(retained.authenticated, true); assert.equal(retained.usage.model.used, 0);
  for (const id of realProjectIds) assert.equal((await fetch(restarted.url + `/projects/${id}/books/main/`, { headers })).status, 200);
  assert.equal(live.errors, ""); assert.equal(restarted.errors, "");
});
