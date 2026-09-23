import assert from "node:assert/strict";
import test from "node:test";
import { makeTempDir } from "./helpers.mjs";
import { createShelfServer } from "../lib/app.mjs";
import { safeStaticPath } from "../lib/http.mjs";

test("server rejects static traversal and preserves legacy note CRUD", async (t) => {
  const root = makeTempDir(t);
  const server = createShelfServer({
    dataDir: `${root}/data`,
    publicDir: `${root}/public`,
    modelClient: { complete: async () => "answer" },
  });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.equal(safeStaticPath(`${root}/public`, "/../outside.html"), null);
  assert.equal((await fetch(`${base}/missing.html`)).status, 404);

  const created = await fetch(`${base}/api/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ book: "legacy", note: { id: "n-1", body: "kept" } }),
  });
  assert.equal(created.status, 200);
  assert.deepEqual(
    await (await fetch(`${base}/api/notes?book=legacy`)).json(),
    [{ id: "n-1", body: "kept" }],
  );
});

test("malformed JSON receives a client error instead of a server error", async (t) => {
  const root = makeTempDir(t);
  const server = createShelfServer({
    dataDir: `${root}/data`,
    publicDir: `${root}/public`,
    modelClient: { complete: async () => "answer" },
  });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${base}/api/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });
  assert.equal(response.status, 400);
});

test("legacy explanation and follow-up routes keep their response shape", async (t) => {
  const root = makeTempDir(t);
  const prompts = [];
  const server = createShelfServer({
    dataDir: `${root}/data`,
    publicDir: `${root}/public`,
    modelClient: {
      complete: async ({ prompt }) => {
        prompts.push(prompt);
        return prompts.length === 1 ? "第一段旁注" : "修改后的旁注";
      },
    },
  });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const explain = await fetch(`${base}/api/explain`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "这是什么", quote: "代码" }),
  });
  const followup = await fetch(`${base}/api/followup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction: "再简单一点", context: "第一段旁注" }),
  });

  assert.deepEqual(await explain.json(), { content: "第一段旁注" });
  assert.deepEqual(await followup.json(), { content: "修改后的旁注" });
  assert.equal(prompts.length, 2);
});

test("global search route returns a parsed search result", async (t) => {
  const root = makeTempDir(t);
  const prompts = [];
  const server = createShelfServer({
    dataDir: `${root}/data`,
    publicDir: `${root}/public`,
    modelClient: {
      complete: async ({ prompt }) => {
        prompts.push(prompt);
        return '{"matchType":"partial","jumpIndex":0,"jumpTitle":"入口","answer":"这里可以补一张卡。"}';
      },
    },
  });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${base}/api/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      question: "入口在哪里",
      matches: [{ sectionTitle: "入口", text: "从 index.html 开始" }],
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    matchType: "partial",
    jumpIndex: 0,
    jumpTitle: "入口",
    answer: "这里可以补一张卡。",
  });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /全书问答|全局问答助手/);
});
