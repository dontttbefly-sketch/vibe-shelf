import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once, EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { acquireRuntimeLock, canonicalDataDir, openBrowser, probeShelf, runtimePort } from "../scripts/local-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shelf-startup-"));
  const dataDir = canonicalDataDir(path.join(directory, "data"));
  const publicDir = path.join(directory, "public");
  fs.mkdirSync(publicDir);
  fs.writeFileSync(path.join(publicDir, "index.html"), "<!doctype html><title>isolated shelf</title>");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, dataDir, publicDir };
}

function runServer(t, files, extra = {}) {
  const child = spawn(process.execPath, [path.join(root, "server.mjs")], {
    cwd: root,
    env: { ...process.env, SHELF_DATA_DIR: files.dataDir, SHELF_PUBLIC_DIR: files.publicDir, PORT: "0", SHELF_API_KEY: "", ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  return {
    child, exited,
    output: () => output,
    async ready() {
      const deadline = Date.now() + 12000;
      while (!output.includes("知识书架已启动：") && Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Server exited before ready: ${output}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.match(output, /知识书架已启动：/, output);
      return Number(output.match(/http:\/\/localhost:(\d+)/)?.[1]);
    },
  };
}

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return server.address().port;
}

test("startup honors .env PORT and environment override without loading model settings", (t) => {
  const files = fixture(t);
  fs.writeFileSync(path.join(files.directory, ".env"), "SHELF_API_KEY=do-not-output\nPORT='9123' # local\n");
  assert.equal(runtimePort(files.directory, {}), 9123);
  assert.equal(runtimePort(files.directory, { PORT: "0" }), 0);
  assert.throws(() => runtimePort(files.directory, { PORT: "NaN" }), /端口设置不正确/);
  assert.throws(() => runtimePort(files.directory, { PORT: "70000" }), /端口设置不正确/);
});

test("OS lock is exclusive across canonical paths and releases without deleting its inode", (t) => {
  const files = fixture(t);
  const alias = path.join(files.directory, "alias");
  fs.symlinkSync(files.dataDir, alias);
  assert.equal(canonicalDataDir(alias), files.dataDir);
  const first = acquireRuntimeLock(files.dataDir);
  assert.ok(first);
  t.after(() => first.release());
  assert.equal(acquireRuntimeLock(canonicalDataDir(alias)), null);
  const inode = fs.statSync(path.join(files.dataDir, ".shelf-runtime.lock")).ino;
  first.release();
  const next = acquireRuntimeLock(files.dataDir);
  assert.ok(next);
  next.release();
  assert.equal(fs.statSync(path.join(files.dataDir, ".shelf-runtime.lock")).ino, inode);
});

test("ready probe rejects unrelated servers, wrong libraries, partial replies and error responses", async (t) => {
  const files = fixture(t);
  let answer = { app: "other", dataDir: files.dataDir };
  let statusCode = 200;
  let finish = true;
  const port = await listen(t, (_req, res) => {
    res.writeHead(statusCode, { "content-type": "application/json" });
    if (finish) res.end(JSON.stringify(answer)); else res.write("{");
  });
  assert.equal(await probeShelf(port, files.dataDir), null);
  answer = { app: "vibe-shelf", dataDir: `${files.dataDir}-different` };
  assert.equal(await probeShelf(port, files.dataDir), null);
  answer.dataDir = files.dataDir;
  statusCode = 503;
  assert.equal(await probeShelf(port, files.dataDir), null);
  statusCode = 200;
  assert.deepEqual(await probeShelf(port, files.dataDir), answer);
  finish = false;
  assert.equal(await probeShelf(port, files.dataDir, 50), null);
});

test("a running library is reused across requested ports without a second writer", { timeout: 20000 }, async (t) => {
  const files = fixture(t);
  const first = runServer(t, files);
  const port = await first.ready();
  assert.equal((await probeShelf(port, files.dataDir)).app, "vibe-shelf");
  const infoBefore = fs.readFileSync(path.join(files.dataDir, ".shelf-runtime.json"), "utf8");
  const second = runServer(t, files, { PORT: String(port === 8899 ? 8900 : 8899) });
  const [code] = await second.exited;
  assert.equal(code, 0, second.output());
  assert.match(second.output(), /已在运行，继续使用/);
  assert.match(second.output(), new RegExp(`localhost:${port}`));
  assert.equal(fs.readFileSync(path.join(files.dataDir, ".shelf-runtime.json"), "utf8"), infoBefore);
  assert.equal(first.child.exitCode, null);
});

test("simultaneous starts elect one owner, and SIGKILL leaves no stale lock", { timeout: 25000 }, async (t) => {
  const files = fixture(t);
  const runners = [runServer(t, files), runServer(t, files)];
  const deadline = Date.now() + 12000;
  while (!runners.some((runner) => runner.child.exitCode === 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const running = runners.filter((runner) => runner.child.exitCode === null);
  assert.equal(running.length, 1, runners.map((runner) => runner.output()).join("\n"));
  assert.equal(runners.filter((runner) => runner.child.exitCode === 0).length, 1);
  const original = running[0];
  const port = await original.ready();
  original.child.kill("SIGKILL");
  await original.exited;
  assert.ok(fs.existsSync(path.join(files.dataDir, ".shelf-runtime.json")), "crash leaves realistic stale metadata");
  const replacement = runServer(t, files, { PORT: String(port) });
  assert.equal(await replacement.ready(), port);
  assert.equal(JSON.parse(fs.readFileSync(path.join(files.dataDir, ".shelf-runtime.json"))).pid, replacement.child.pid);
  replacement.child.kill("SIGTERM");
  assert.equal((await replacement.exited)[0], 0);
  assert.equal(fs.existsSync(path.join(files.dataDir, ".shelf-runtime.json")), false);
});

test("occupied port produces a useful error, does not reuse the wrong app and leaves its process intact", { timeout: 15000 }, async (t) => {
  const files = fixture(t);
  let requests = 0;
  const port = await listen(t, (_req, res) => { requests++; res.end("another application"); });
  const attempted = runServer(t, files, { PORT: String(port) });
  assert.equal((await attempted.exited)[0], 1, attempted.output());
  assert.match(attempted.output(), /端口.*占用/);
  assert.doesNotMatch(attempted.output(), /已启动|已在运行/);
  assert.equal(await probeShelf(port, files.dataDir), null);
  assert.ok(requests > 0);
  const next = acquireRuntimeLock(files.dataDir);
  assert.ok(next, "startup failure must release its lock");
  next.release();
});

test("browser launch passes the verified URL as an argument and reports open failure", async () => {
  const calls = [];
  const spawnImpl = (...args) => {
    calls.push(args);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", calls.length === 1 ? 0 : 1));
    return child;
  };
  assert.equal(await openBrowser("http://127.0.0.1:9123", { platform: "darwin", spawnImpl }), true);
  assert.deepEqual(calls[0].slice(0, 2), ["/usr/bin/open", ["http://127.0.0.1:9123"]]);
  assert.equal(await openBrowser("http://127.0.0.1:9123", { platform: "darwin", spawnImpl }), false);
});
