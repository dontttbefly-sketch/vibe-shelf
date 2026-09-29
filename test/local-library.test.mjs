import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { createShelfServer } from "../lib/app.mjs";
import { createConfiguredModelClient } from "../lib/model-client.mjs";
import { makeTempDir } from "./helpers.mjs";
import { validBookHtml } from "./api-helpers.mjs";

async function serverFor(t, options = {}) {
  const root = options.root || makeTempDir(t);
  const server = createShelfServer({
    dataDir: root + "/data", publicDir: root + "/public",
    modelClient: { complete: async () => "受控回答" }, ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { root, base: "http://127.0.0.1:" + server.address().port };
}

async function request(base, route, method = "GET", body) {
  const response = await fetch(base + route, {
    method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = { raw }; }
  return { status: response.status, headers: response.headers, body: data };
}

async function seed(base, id = "library-demo") {
  const imported = await request(base, "/api/projects/import", "POST", {
    projectId: id, name: "资料测试", files: [{ path: "src/main.js", content: "export const saved = 42;" }],
    mainBook: { title: "资料测试主书", sourceHtml: validBookHtml },
  });
  assert.equal(imported.status, 201);
  const prefix = "/api/projects/" + id;
  await request(base, prefix + "/books/main/notes", "POST", { note: { id: "n-keep", body: "需要保留的旁注" } });
  const session = (await request(base, prefix + "/explorations", "POST", { originBookId: "main" })).body.session;
  await request(base, prefix + "/explorations/" + session.id + "/messages", "POST", { prompt: "需要保留的探索" });
  return { project: imported.body.project, session };
}

function reseal(backup) {
  const { checksum: ignored, ...payload } = backup;
  backup.checksum = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return backup;
}

test("status redacts credentials; connectivity check uses the existing configuration", async (t) => {
  const root = makeTempDir(t);
  const seen = [];
  const modelClient = createConfiguredModelClient({
    root, environment: { SHELF_API_URL: "https://user:password@models.example/v1?token=url-secret", SHELF_API_KEY: "private-key", SHELF_MODEL: "kept-model" },
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }) };
    },
  });
  const { base } = await serverFor(t, { root, modelClient });
  const status = await request(base, "/api/status");
  assert.equal(status.status, 200);
  assert.equal(status.body.app, "vibe-shelf");
  assert.ok(status.body.version);
  assert.equal(status.body.model.configured, true);
  assert.equal(status.body.model.model, "kept-model");
  assert.equal(status.body.model.url, "https://models.example");
  assert.equal(status.body.dataDir, root + "/data");
  assert.doesNotMatch(JSON.stringify(status.body), /private-key|password|url-secret/);
  assert.equal(seen.length, 0);
  const checked = await request(base, "/api/model/check", "POST");
  assert.equal(checked.status, 200);
  assert.equal(checked.body.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(JSON.parse(seen[0].init.body).model, "kept-model");
  assert.equal(seen[0].init.headers.authorization, "Bearer private-key");
  assert.ok(JSON.parse(seen[0].init.body).max_tokens <= 128);
});

test("model check errors never expose upstream text or a secret", async (t) => {
  const { base } = await serverFor(t, { modelClient: { complete: async () => { throw new Error("leaked private-key https://x/?token=secret"); } } });
  const result = await request(base, "/api/model/check", "POST");
  assert.equal(result.status, 502);
  assert.doesNotMatch(JSON.stringify(result.body), /private-key|token=secret|leaked/);
});

test("backup roundtrip keeps snapshots, books, compiled pages, notes, exploration and legacy data", async (t) => {
  const source = await serverFor(t);
  const seeded = await seed(source.base);
  fs.writeFileSync(source.root + "/data/.env", "SHOULD_NOT_LEAVE");
  fs.mkdirSync(source.root + "/data/tmp-import", { recursive: true });
  fs.writeFileSync(source.root + "/data/tmp-import/no.txt", "TEMP_SHOULD_NOT_LEAVE");
  fs.writeFileSync(source.root + "/data/library-demo.json", JSON.stringify([{ id: "legacy", body: "旧旁注" }]));
  const backup = await request(source.base, "/api/library/backup");
  assert.equal(backup.status, 200);
  assert.match(backup.headers.get("content-disposition"), /attachment/);
  assert.equal(backup.body.format, "vibe-shelf-library");
  assert.equal(backup.body.version, 1);
  assert.ok(backup.body.checksum);
  assert.doesNotMatch(JSON.stringify(backup.body), /SHOULD_NOT_LEAVE|tmp-import/);
  const destination = await serverFor(t);
  const restored = await request(destination.base, "/api/library/restore", "POST", backup.body);
  assert.equal(restored.status, 201);
  assert.deepEqual(restored.body.projectIds, ["library-demo"]);
  const prefix = "/api/projects/library-demo";
  const project = await request(destination.base, prefix);
  assert.equal(project.body.project.currentSnapshotId, seeded.project.currentSnapshotId);
  const snapshot = await request(destination.base, prefix + "/snapshots/" + seeded.project.currentSnapshotId + "/file?path=src/main.js");
  assert.equal(snapshot.body.content, "export const saved = 42;");
  assert.equal((await request(destination.base, prefix + "/books/main/notes")).body[0].body, "需要保留的旁注");
  assert.equal((await request(destination.base, prefix + "/explorations/" + seeded.session.id)).body.session.messages[0].content, "需要保留的探索");
  assert.equal((await fetch(destination.base + "/projects/library-demo/books/main/")).status, 200);
  assert.equal(fs.readFileSync(destination.root + "/data/projects/library-demo/books/main/source.html", "utf8"), validBookHtml);
  assert.equal(JSON.parse(fs.readFileSync(destination.root + "/data/library-demo.json", "utf8"))[0].body, "旧旁注");
  assert.equal((await request(destination.base, "/api/library/restore", "POST", backup.body)).status, 409);
});

test("restore rejects tampering and traversal before writing any project", async (t) => {
  const source = await serverFor(t);
  await seed(source.base);
  const backup = await request(source.base, "/api/library/backup");
  assert.equal(backup.status, 200);
  const destination = await serverFor(t);
  const tampered = structuredClone(backup.body);
  tampered.files[0].data = Buffer.from("tampered").toString("base64");
  assert.equal((await request(destination.base, "/api/library/restore", "POST", tampered)).status, 400);
  const traversal = structuredClone(backup.body);
  traversal.files[0].path = "projects/library-demo/../../escape.json";
  reseal(traversal);
  assert.equal((await request(destination.base, "/api/library/restore", "POST", traversal)).status, 400);
  const wrongType = structuredClone(backup.body);
  wrongType.files[0].type = "symlink";
  reseal(wrongType);
  assert.equal((await request(destination.base, "/api/library/restore", "POST", wrongType)).status, 400);
  assert.equal(fs.existsSync(destination.root + "/data/projects/library-demo"), false);
});

test("restore rolls back published data when publishing the reading page fails", async (t) => {
  const source = await serverFor(t);
  await seed(source.base);
  const backup = await request(source.base, "/api/library/backup");
  assert.equal(backup.status, 200);
  const destination = await serverFor(t);
  const originalRename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (String(to) === destination.root + "/public/projects/library-demo") throw new Error("controlled disk failure");
    return originalRename(from, to);
  });
  assert.equal((await request(destination.base, "/api/library/restore", "POST", backup.body)).status, 500);
  assert.equal(fs.existsSync(destination.root + "/data/projects/library-demo"), false);
  assert.equal(fs.existsSync(destination.root + "/public/projects/library-demo"), false);
  assert.deepEqual((await request(destination.base, "/api/projects")).body.projects, []);
});

test("archive is reversible and export is a complete single-project backup", async (t) => {
  const { base } = await serverFor(t);
  await seed(base);
  const archived = await request(base, "/api/projects/library-demo/archive", "POST", { archived: true });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.project.archived, true);
  assert.equal((await request(base, "/api/projects")).body.projects[0].archived, true);
  assert.equal((await request(base, "/api/projects/library-demo")).status, 200);
  const exported = await request(base, "/api/projects/library-demo/export");
  assert.equal(exported.status, 200);
  assert.deepEqual(exported.body.projectIds, ["library-demo"]);
  assert.ok(exported.body.files.some((file) => file.path.endsWith("source.html")));
  assert.equal((await request(base, "/api/projects/library-demo/archive", "POST", { archived: false })).body.project.archived, false);
  assert.equal((await request(base, "/api/projects/library-demo/archive", "POST", { archived: "false" })).status, 400);
});

test("github retries reuse a client import id only for the same repository", async (t) => {
  let calls = 0;
  const { base } = await serverFor(t, {
    githubLoader: async (repo) => { calls += 1; return { repo, files: [{ path: "src/main.js", content: "export {};" }] }; },
    modelClient: { complete: async () => validBookHtml },
  });
  const first = await request(base, "/api/projects/import-github", "POST", { projectId: "github-retry", repo: "owner/repo" });
  assert.equal(first.status, 201);
  assert.equal(first.body.project.id, "github-retry");
  const second = await request(base, "/api/projects/import-github", "POST", { projectId: "github-retry", repo: "https://github.com/owner/repo" });
  assert.equal(second.status, 200);
  assert.equal(second.body.project.id, "github-retry");
  assert.equal(calls, 1);
  assert.equal((await request(base, "/api/projects/import-github", "POST", { projectId: "github-retry", repo: "owner/other" })).status, 409);
  assert.equal(calls, 1);
});

test("local retries reuse an import only when its name and normalized file contents match", async (t) => {
  const { base } = await serverFor(t);
  const body = { projectId: "local-retry", name: "Same", files: [{ path: "src/a.js", content: "one" }], mainBook: { title: "Same", sourceHtml: validBookHtml } };
  assert.equal((await request(base, "/api/projects/import", "POST", body)).status, 201);
  const repeat = await request(base, "/api/projects/import", "POST", body);
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.reused, true);
  assert.equal((await request(base, "/api/projects/import", "POST", { ...body, files: [{ path: "src/a.js", content: "two" }] })).status, 409);
  assert.equal((await request(base, "/api/projects")).body.projects.length, 1);
});

test("restore validates file size, duplicate paths and structural completeness independently of checksum", async (t) => {
  const source = await serverFor(t);
  await seed(source.base);
  const backup = (await request(source.base, "/api/library/backup")).body;
  const destination = await serverFor(t);
  const oversized = structuredClone(backup);
  oversized.files[0].size = 32 * 1024 * 1024 + 1;
  assert.equal((await request(destination.base, "/api/library/restore", "POST", reseal(oversized))).status, 413);
  const duplicate = structuredClone(backup);
  duplicate.files.push({ ...duplicate.files[0] });
  assert.equal((await request(destination.base, "/api/library/restore", "POST", reseal(duplicate))).status, 400);
  const incomplete = structuredClone(backup);
  incomplete.files = incomplete.files.filter((entry) => !entry.path.endsWith("/source.html"));
  assert.equal((await request(destination.base, "/api/library/restore", "POST", reseal(incomplete))).status, 400);
  assert.deepEqual((await request(destination.base, "/api/projects")).body.projects, []);
});

test("a new server rolls back an interrupted restore before serving the library", async (t) => {
  const root = makeTempDir(t);
  const token = ".restore-" + crypto.randomUUID();
  const restoredProject = root + "/data/projects/interrupted";
  fs.mkdirSync(restoredProject, { recursive: true });
  fs.writeFileSync(restoredProject + "/project.json", JSON.stringify({ id: "interrupted", name: "Uncommitted" }));
  fs.writeFileSync(root + "/data/projects.json", JSON.stringify([{ id: "interrupted", name: "Uncommitted" }]));
  fs.mkdirSync(root + "/data/" + token, { recursive: true });
  fs.writeFileSync(root + "/data/" + token + "/transaction.json", JSON.stringify({
    version: 1, token, status: "publishing", indexBefore: null,
    published: [{ area: "data", path: "projects/interrupted" }, { area: "public", path: "projects/interrupted" }],
  }));
  const { base } = await serverFor(t, { root });
  assert.equal(fs.existsSync(restoredProject), false);
  assert.equal(fs.existsSync(root + "/data/" + token), false);
  assert.deepEqual((await request(base, "/api/projects")).body.projects, []);
});

test("backup preserves both the current snapshot and the older snapshot referenced by the main book", async (t) => {
  const source = await serverFor(t);
  const original = await seed(source.base);
  const refreshed = await request(source.base, "/api/projects/library-demo/snapshots", "POST", { files: [{ path: "src/main.js", content: "export const saved = 99;" }] });
  assert.equal(refreshed.status, 201);
  const backup = await request(source.base, "/api/library/backup");
  assert.equal(backup.status, 200);
  const destination = await serverFor(t);
  assert.equal((await request(destination.base, "/api/library/restore", "POST", backup.body)).status, 201);
  const view = (await request(destination.base, "/api/projects/library-demo")).body;
  assert.equal(view.project.currentSnapshotId, refreshed.body.project.currentSnapshotId);
  assert.equal(view.books[0].sourceSnapshotId, original.project.currentSnapshotId);
  assert.equal((await request(destination.base, "/api/projects/library-demo/snapshots/" + original.project.currentSnapshotId + "/file?path=src/main.js")).body.content, "export const saved = 42;");
});

test("backup and restore reject symlinks, including dangling destination links, without removing them", async (t) => {
  const source = await serverFor(t);
  const seeded = await seed(source.base);
  const backup = (await request(source.base, "/api/library/backup")).body;
  const destination = await serverFor(t);
  fs.mkdirSync(destination.root + "/data/projects", { recursive: true });
  const link = destination.root + "/data/projects/library-demo";
  fs.symlinkSync(destination.root + "/outside-missing", link);
  assert.equal((await request(destination.base, "/api/library/restore", "POST", backup)).status, 400);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  fs.writeFileSync(source.root + "/private.txt", "should stay outside");
  fs.symlinkSync(source.root + "/private.txt", source.root + "/data/projects/library-demo/source/" + seeded.project.currentSnapshotId + "/link.txt");
  assert.equal((await request(source.base, "/api/library/backup")).status, 400);
});

test("deleted-note tombstones survive backup and keep a stale offline note from reappearing after restore", async (t) => {
  const source = await serverFor(t);
  await seed(source.base);
  const notes = await request(source.base, "/api/projects/library-demo/books/main/notes?revisions=1");
  const saved = notes.body[0];
  assert.equal((await request(source.base, "/api/projects/library-demo/books/main/notes?id=n-keep&revision=" + saved.revision, "DELETE")).status, 200);
  const backup = await request(source.base, "/api/library/backup");
  assert.equal(backup.status, 200);
  const destination = await serverFor(t);
  assert.equal((await request(destination.base, "/api/library/restore", "POST", backup.body)).status, 201);
  assert.deepEqual((await request(destination.base, "/api/projects/library-demo/books/main/notes")).body, []);
  const stale = await request(destination.base, "/api/projects/library-demo/books/main/notes", "POST", { note: { id: "n-keep", body: saved.body } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.kind, "note-conflict");
});

test("backup preserves user snapshot env files exactly while application configuration stays excluded", async (t) => {
  const source = await serverFor(t);
  const files = [
    { path: ".env", content: "USER_SOURCE_SETTING=original\n" },
    { path: "config/.env.production", content: "USER_SOURCE_SETTING=production\n" },
    { path: "src/main.js", content: "export const value = 1;" },
  ];
  const imported = await request(source.base, "/api/projects/import", "POST", {
    projectId: "env-snapshot", name: "配置源码", files,
    mainBook: { title: "配置源码主书", sourceHtml: validBookHtml },
  });
  assert.equal(imported.status, 201);
  const snapshotId = imported.body.project.currentSnapshotId;
  const sourcePrefix = "projects/env-snapshot/source/" + snapshotId + "/";
  const indexPath = "/data/projects/env-snapshot/file-index/" + snapshotId + ".json";
  const originalIndex = fs.readFileSync(source.root + indexPath, "utf8");
  fs.writeFileSync(source.root + "/.env", "APPLICATION_MODEL_KEY=never-export\n");
  fs.writeFileSync(source.root + "/data/projects/env-snapshot/.env", "APPLICATION_SIDE_SETTING=never-export\n");
  const backup = await request(source.base, "/api/library/backup");
  assert.equal(backup.status, 200, JSON.stringify(backup.body));
  assert.equal(backup.body.files.some((entry) => entry.path === "projects/env-snapshot/.env"), false);
  for (const file of files) {
    const entry = backup.body.files.find((item) => item.area === "data" && item.path === sourcePrefix + file.path);
    assert.ok(entry, file.path + " must be included in the immutable snapshot");
    assert.equal(Buffer.from(entry.data, "base64").toString("utf8"), file.content);
    assert.equal(fs.readFileSync(source.root + "/data/" + sourcePrefix + file.path, "utf8"), file.content);
  }
  assert.equal(backup.body.files.some((entry) => Buffer.from(entry.data, "base64").includes("never-export")), false);
  assert.equal(fs.readFileSync(source.root + indexPath, "utf8"), originalIndex);
  const destination = await serverFor(t);
  fs.writeFileSync(destination.root + "/.env", "DESTINATION_MODEL_KEY=unchanged\n");
  assert.equal((await request(destination.base, "/api/library/restore", "POST", backup.body)).status, 201);
  for (const file of files) {
    const restored = await request(destination.base, "/api/projects/env-snapshot/snapshots/" + snapshotId + "/file?path=" + encodeURIComponent(file.path));
    assert.equal(restored.status, 200);
    assert.equal(restored.body.content, file.content);
  }
  assert.equal(fs.readFileSync(destination.root + indexPath, "utf8"), originalIndex);
  assert.equal(fs.readFileSync(source.root + "/.env", "utf8"), "APPLICATION_MODEL_KEY=never-export\n");
  assert.equal(fs.readFileSync(destination.root + "/.env", "utf8"), "DESTINATION_MODEL_KEY=unchanged\n");
  assert.equal(fs.existsSync(destination.root + "/data/projects/env-snapshot/.env"), false);

  const malicious = structuredClone(backup.body);
  const env = malicious.files.find((entry) => entry.path === sourcePrefix + ".env");
  malicious.files.push({ ...env, path: "projects/env-snapshot/.env" });
  const empty = await serverFor(t);
  assert.equal((await request(empty.base, "/api/library/restore", "POST", reseal(malicious))).status, 400);
  assert.deepEqual((await request(empty.base, "/api/projects")).body.projects, []);
});
