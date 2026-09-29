import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createConfiguredModelClient } from "../lib/model-client.mjs";
import { createShelfServer } from "../lib/app.mjs";
import { makeTempDir } from "./helpers.mjs";
import { validBookHtml } from "./api-helpers.mjs";

// Synthetic values only. Deliberately include more than the configured key:
// suppressing untrusted diagnostics must also protect URL credentials and tokens.
const KEY = "FAKE-QA-KEY-NOT-A-CREDENTIAL+/=";
const DIAGNOSTIC = `upstream-diagnostic-marker key=${KEY} encoded=${encodeURIComponent(KEY)} https://user:FAKE-URL-PASSWORD@models.example/?token=FAKE-QUERY-TOKEN`;

function assertSafe(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of [KEY, encodeURIComponent(KEY), "upstream-diagnostic-marker", "FAKE-URL-PASSWORD", "FAKE-QUERY-TOKEN"]) {
    assert.equal(serialized.includes(secret), false, "public errors must not contain untrusted upstream diagnostics");
  }
}

function clientFor(t, fetchImpl, root = makeTempDir(t)) {
  return createConfiguredModelClient({
    root,
    environment: { SHELF_API_URL: "https://models.example/v1/chat/completions", SHELF_API_KEY: KEY, SHELF_MODEL: "kept-model" },
    fetchImpl,
  });
}

function assertPublicError(error, pattern, statusCode = 502, kind = "upstream") {
  assertSafe(error.message);
  assertSafe(JSON.stringify(error));
  assert.equal(error.statusCode, statusCode);
  assert.equal(error.kind, kind);
  assert.match(error.message, pattern);
  return true;
}

for (const [status, guidance] of [
  [401, /API Key|密钥/],
  [403, /权限/],
  [400, /请求|配置/],
  [404, /地址|模型名称/],
  [413, /过大|长度/],
  [429, /频繁|额度/],
  [503, /暂时|稍后/],
  [302, /接口|配置/],
]) {
  test(`HTTP ${status} errors give safe guidance without echoing the model response`, async (t) => {
    let calls = 0;
    const client = clientFor(t, async (_url, init) => {
      calls += 1;
      assert.equal(init.headers.authorization, `Bearer ${KEY}`);
      assert.equal(JSON.parse(init.body).model, "kept-model");
      return new Response(DIAGNOSTIC, { status });
    });
    await assert.rejects(client.complete({ prompt: "safe synthetic question" }), (error) => {
      assertPublicError(error, guidance);
      assert.match(error.message, new RegExp(String(status)));
      return true;
    });
    assert.equal(calls, status === 429 || status >= 500 ? 3 : 1, "existing HTTP retry policy is preserved");
  });
}

test("network failures never expose the underlying exception message", async (t) => {
  const client = clientFor(t, async () => { throw new Error(DIAGNOSTIC); });
  await assert.rejects(client.complete({ prompt: "safe synthetic question" }), (error) => assertPublicError(error, /网络|连接/));
});

test("interrupted response bodies never expose the stream exception message", async (t) => {
  const client = clientFor(t, async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error(DIAGNOSTIC)); },
  }), { status: 200 }));
  await assert.rejects(client.complete({ prompt: "safe synthetic question" }), (error) => assertPublicError(error, /中断.*重试/));
});

test("timeout errors retain their timeout classification and safe retry guidance", async (t) => {
  const client = clientFor(t, async () => { throw Object.assign(new Error(DIAGNOSTIC), { name: "TimeoutError" }); });
  await assert.rejects(client.complete({ prompt: "safe synthetic question", timeoutMs: 8000 }), (error) => (
    assertPublicError(error, /8 秒.*重试/, 504, "upstream-timeout")
  ));
});

test("retryable transport failures still retry before returning a safe error", async (t) => {
  let calls = 0;
  const client = clientFor(t, async () => {
    calls += 1;
    throw Object.assign(new Error(DIAGNOSTIC), { cause: { code: "ECONNRESET" } });
  });
  await assert.rejects(client.complete({ prompt: "safe synthetic question" }), (error) => assertPublicError(error, /网络|连接/));
  assert.equal(calls, 3);
});

test("ordinary API errors and persisted exploration/generation failures keep upstream diagnostics private", async (t) => {
  const root = makeTempDir(t);
  let failure = "http";
  const modelClient = clientFor(t, async () => {
    if (failure === "network") throw new Error(DIAGNOSTIC);
    return new Response(DIAGNOSTIC, { status: 401 });
  }, root);
  const server = createShelfServer({ dataDir: root + "/data", publicDir: root + "/public", modelClient });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = "http://127.0.0.1:" + server.address().port;
  async function request(route, body) {
    const response = await fetch(base + route, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  const imported = await request("/api/projects/import", {
    projectId: "safe-model-error", name: "模型错误边界", files: [{ path: "src/main.js", content: "export const safe = true;" }],
    mainBook: { title: "受控主书", sourceHtml: validBookHtml },
  });
  assert.equal(imported.status, 201);
  const prefix = "/api/projects/safe-model-error";
  for (failure of ["http", "network"]) {
    for (const route of ["/api/explain", "/api/followup", "/api/search", prefix + "/books/main/explain", prefix + "/books/main/followup"]) {
      const result = await request(route, { question: "解释 safe", instruction: "解释 safe", selection: "safe" });
      assert.equal(result.status, 502, route);
      assert.equal(result.body.error.kind, "upstream", route);
      assertSafe(result.body);
    }

    const sessionResult = await request(prefix + "/explorations", { originBookId: "main" });
    assert.equal(sessionResult.status, 201);
    const sessionRoute = prefix + "/explorations/" + sessionResult.body.session.id;
    const answer = await request(sessionRoute + "/messages", { prompt: "解释 safe" });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.assistantMessage.status, "failed");
    assertSafe(answer.body);
    const session = await request(sessionRoute);
    assertSafe(session.body);
    assert.ok(session.body.session.messages.some((message) => message.status === "failed" && message.error));

    const generationId = "safe-generation-" + failure;
    const started = await request("/api/projects/import", {
      projectId: generationId, name: "生成错误边界", files: [{ path: "src/main.js", content: "export const safe = true;" }],
    });
    assert.equal(started.status, 201);
    let generation;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      generation = (await request("/api/projects/" + generationId + "/generation")).body.generation;
      if (generation.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(generation.status, "failed");
    assert.ok(generation.error);
    assertSafe(generation);
    assertSafe(fs.readFileSync(root + "/data/projects/" + generationId + "/generation.json", "utf8"));
  }

  // Backup reads persisted exploration records too; decoding prevents base64
  // from making a leaked error merely invisible to a plain JSON string search.
  const backup = await request("/api/library/backup");
  assert.equal(backup.status, 200);
  for (const file of backup.body.files) assertSafe(Buffer.from(file.data, "base64").toString("utf8"));
});
