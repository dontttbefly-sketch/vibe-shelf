import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createConfiguredModelClient } from "../lib/model-client.mjs";

function emptyRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "shelf-model-"));
}

function env(apiUrl) {
  return { SHELF_API_URL: apiUrl, SHELF_API_KEY: "k", SHELF_MODEL: "m" };
}

function okResponse(payload) {
  return { status: 200, ok: true, text: async () => JSON.stringify(payload), headers: new Map() };
}

test("every request carries an abort signal so a hung model cannot block forever", async () => {
  const seen = [];
  const client = createConfiguredModelClient({
    root: emptyRoot(),
    environment: env("https://api.openai.com/v1/chat/completions"),
    fetchImpl: async (url, init) => {
      seen.push(init);
      return okResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    },
  });

  await client.complete({ prompt: "hi" });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].signal, "请求必须带 AbortSignal");
});

test("reasoning_split only goes to MiniMax endpoints", async () => {
  async function bodyFor(apiUrl, environment) {
    let body = null;
    const client = createConfiguredModelClient({
      root: emptyRoot(),
      environment: environment || env(apiUrl),
      fetchImpl: async (url, init) => {
        body = JSON.parse(init.body);
        return okResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
      },
    });
    await client.complete({ prompt: "hi" });
    return body;
  }

  // 严格端点收到未知顶层参数会 400，而 README 承诺"任何 OpenAI 兼容接口"
  assert.equal("reasoning_split" in (await bodyFor("https://api.openai.com/v1/chat/completions")), false);
  assert.equal((await bodyFor("https://api.minimax.chat/v1/text/chatcompletion_v2")).reasoning_split, true);
  // 走代理、域名里没有 minimax 的，用环境变量显式打开
  assert.equal(
    (await bodyFor("https://proxy.internal/v1/chat/completions", { ...env("https://proxy.internal/v1/chat/completions"), SHELF_REASONING_SPLIT: "1" })).reasoning_split,
    true,
  );
});

test("a length-truncated answer fails loudly instead of shipping half a book", async () => {
  const client = createConfiguredModelClient({
    root: emptyRoot(),
    environment: env("https://api.openai.com/v1/chat/completions"),
    fetchImpl: async () => okResponse({
      choices: [{ message: { content: "<!doctype html><style>body{}" }, finish_reason: "length" }],
    }),
  });

  await assert.rejects(() => client.complete({ prompt: "hi" }), /截断/);
});

test("a missing model config reports model-unavailable instead of a generic 500", async () => {
  const client = createConfiguredModelClient({
    root: emptyRoot(),
    environment: {},
    fetchImpl: async () => okResponse({ choices: [] }),
  });

  await assert.rejects(() => client.complete({ prompt: "hi" }), (error) => error.statusCode === 503);
});
