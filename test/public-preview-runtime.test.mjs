import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePreviewArgs, prepareLivePreview, migratePublicPreview, snapshotPublicPreview } from "../scripts/public-preview-runtime.mjs";
import { acquireRuntimeLock } from "../scripts/local-runtime.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shelf-live-runtime-"));
  fs.mkdirSync(path.join(directory, "public"));
  const source = path.join(directory, "old", "data", "public-service");
  for (const relative of ["auth/sessions", "auth/states", "users/github-900001/data/projects/first", "users/github-900001/books/projects/first"]) fs.mkdirSync(path.join(source, relative), { recursive: true });
  fs.writeFileSync(path.join(source, "auth/sessions/session.json"), '{"private":"session preserved"}');
  fs.writeFileSync(path.join(source, "users/github-900001/usage.json"), '{"generations":[{"status":"settled"}],"modelDays":{"2026-09-29":2}}');
  fs.writeFileSync(path.join(source, "users/github-900001/data/projects/first/generation.json"), '{"status":"ready"}');
  fs.writeFileSync(path.join(source, "users/github-900001/books/projects/first/index.html"), "<h1>saved book</h1>");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, source, target: path.join(directory, "live"), environment: { SHELF_PUBLIC_DATA_DIR: path.join(directory, "live") } };
}

test("preview mode parsing keeps controlled default, live, and performance mutually explicit", () => {
  assert.deepEqual(parsePreviewArgs([]), { live: false, performance: false, migrateFrom: null, port: 8911 });
  assert.equal(parsePreviewArgs(["--performance"]).port, 0);
  assert.equal(parsePreviewArgs(["--live", "--port", "0"]).live, true);
  for (const args of [["--live", "--performance"], ["--migrate-from", "/tmp/old"], ["--port", "65536"], ["--live", "--live"], ["--port", "no"]]) assert.throws(() => parsePreviewArgs(args));
});

test("live runtime locks one canonical persistent root and releases across restarts", t => {
  const files = fixture(t);
  const first = prepareLivePreview({ repo: files.directory, environment: files.environment });
  try {
    assert.equal(first.fresh, true);
    assert.equal(fs.statSync(first.root).mode & 0o777, 0o700);
    assert.throws(() => prepareLivePreview({ repo: files.directory, environment: files.environment }), /已在运行/);
    assert.equal(acquireRuntimeLock(first.root), null, "the production server must share the same data lock");
    fs.writeFileSync(path.join(first.root, "preserved.txt"), "do not replace");
  } finally { first.lock.release(); }
  const second = prepareLivePreview({ repo: files.directory, environment: files.environment });
  try { assert.equal(second.fresh, false); assert.equal(fs.readFileSync(path.join(second.root, "preserved.txt"), "utf8"), "do not replace"); }
  finally { second.lock.release(); }
});

test("migration backs up and hash verifies auth, source, books and usage without changing the old copy", t => {
  const files = fixture(t), before = snapshotPublicPreview(files.source);
  const runtime = prepareLivePreview({ repo: files.directory, environment: files.environment, migrateFrom: files.source });
  try {
    assert.equal(runtime.fresh, false);
    assert.equal(runtime.migration.fileCount, 4);
    for (const root of [files.source, runtime.root, runtime.migration.backup]) assert.deepEqual(snapshotPublicPreview(root).files, before.files);
    assert.equal(fs.statSync(runtime.migration.backup).mode & 0o777, 0o700);
    const manifest = fs.readFileSync(path.join(runtime.migration.backup, "migration-manifest.json"), "utf8");
    assert.ok(!manifest.includes("session preserved"));
  } finally { runtime.lock.release(); }
});

test("migration refuses an existing destination and keeps both libraries untouched", t => {
  const files = fixture(t), before = snapshotPublicPreview(files.source);
  fs.mkdirSync(files.target); fs.writeFileSync(path.join(files.target, "keep.txt"), "existing data");
  assert.throws(() => migratePublicPreview(files.source, files.target), /目标已有资料/);
  assert.equal(fs.readFileSync(path.join(files.target, "keep.txt"), "utf8"), "existing data");
  assert.deepEqual(snapshotPublicPreview(files.source).files, before.files);
});

test("migration refuses active generation, usage reservations and pending exploration", t => {
  const files = fixture(t);
  const generation = path.join(files.source, "users/github-900001/data/projects/first/generation.json");
  fs.writeFileSync(generation, '{"status":"generating"}');
  assert.throws(() => migratePublicPreview(files.source, files.target), /进行中/);
  assert.equal(fs.existsSync(files.target), false);
  fs.writeFileSync(generation, '{"status":"ready"}');
  const usage = path.join(files.source, "users/github-900001/usage.json");
  fs.writeFileSync(usage, '{"generations":[{"status":"reserved"}]}');
  assert.throws(() => migratePublicPreview(files.source, files.target), /进行中/);
  fs.writeFileSync(usage, '{"generations":[]}');
  const exploration = path.join(files.source, "users/github-900001/data/projects/first/explorations");
  fs.mkdirSync(exploration); fs.writeFileSync(path.join(exploration, "first.json"), '{"messages":[{"status":"pending"}]}');
  assert.throws(() => migratePublicPreview(files.source, files.target), /进行中/);
});

test("migration refuses symlinks and performance identities; live root cannot be publicly served", t => {
  const files = fixture(t);
  fs.symlinkSync(path.join(files.source, "auth"), path.join(files.source, "users", "linked"));
  assert.throws(() => migratePublicPreview(files.source, files.target), /链接/);
  fs.unlinkSync(path.join(files.source, "users", "linked"));
  fs.mkdirSync(path.join(files.source, "users", "github-900002"));
  assert.throws(() => migratePublicPreview(files.source, files.target), /性能样本/);
  assert.throws(() => prepareLivePreview({ repo: files.directory, environment: { SHELF_PUBLIC_DATA_DIR: path.join(files.directory, "public", "private") } }), /不能位于 public/);
});
