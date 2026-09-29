import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createShelfServer } from "../lib/app.mjs";
import { buildExplorationPrompt, EXPLORATION_HISTORY_CHAR_LIMIT } from "../lib/prompts.mjs";
import { validBookHtml } from "./api-helpers.mjs";
import { makeTempDir } from "./helpers.mjs";

// These tests intentionally use isolated data and a controlled model. They
// verify continuity and failure recovery, not the quality of real model output.
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function startServer(t, root, modelClient) {
  const server = createShelfServer({
    dataDir: path.join(root, "data"),
    publicDir: path.join(root, "public"),
    modelClient,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = () => new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
  t.after(close);
  return { base: `http://127.0.0.1:${server.address().port}`, close };
}

async function request(base, url, method = "GET", body) {
  const response = await fetch(`${base}${url}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  return { status: response.status, body: await response.json() };
}

async function importProject(base, { withBook = true } = {}) {
  const result = await request(base, "/api/projects/import", "POST", {
    projectId: "continuity",
    name: "Continuity",
    files: [{ path: "src/server.mjs", content: "export const port = process.env.PORT || 3000;" }],
    ...(withBook ? { mainBook: { title: "Continuity 主书", sourceHtml: validBookHtml } } : {}),
  });
  assert.equal(result.status, 201);
  return result.body;
}

async function createSession(base) {
  const result = await request(base, "/api/projects/continuity/explorations", "POST", { originBookId: "main" });
  assert.equal(result.status, 201);
  return result.body.session;
}

const sessionUrl = (session) => `/api/projects/continuity/explorations/${session.id}`;
const messagesUrl = (session) => `${sessionUrl(session)}/messages`;

async function generationUntilSettled(base) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const result = await request(base, "/api/projects/continuity/generation");
    assert.equal(result.status, 200);
    if (result.body.generation.status !== "generating") return result.body.generation;
    if (Date.now() > deadline) throw new Error("controlled generation did not finish");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("exploration prompt includes prior question and answer without repeating the current question", () => {
  const question = "它为什么在这里使用环境变量？";
  const prompt = buildExplorationPrompt({
    question,
    session: { messages: [
      { id: "m-1", role: "user", content: "项目入口在哪里？" },
      { id: "m-2", role: "assistant", status: "complete", content: "入口是 src/server.mjs，端口读取 PORT。" },
      { id: "m-3", role: "user", content: question },
      { id: "m-4", role: "assistant", status: "pending", content: "" },
    ] },
    chunks: [{ path: "src/server.mjs", startLine: 1, endLine: 1, text: "export const port = process.env.PORT || 3000;" }],
  });
  assert.ok(prompt.includes("项目入口在哪里？"), "the earlier user question must reach the model");
  assert.ok(prompt.includes("入口是 src/server.mjs，端口读取 PORT。"), "the earlier answer must reach the model");
  assert.equal(prompt.split(question).length - 1, 1, "the current question should occur once");
});

test("exploration history has a fixed total budget and retains the latest completed exchange", () => {
  const messages = [];
  for (let index = 0; index < 20; index += 1) {
    messages.push(
      { role: "user", content: `历史问题-${index}` },
      { role: "assistant", status: "complete", content: `历史回答-${index}：${"资料".repeat(2000)}` },
    );
  }
  const base = buildExplorationPrompt({ question: "继续解释", chunks: [] });
  const prompt = buildExplorationPrompt({ question: "继续解释", session: { messages }, chunks: [] });
  assert.ok(prompt.length <= base.length + EXPLORATION_HISTORY_CHAR_LIMIT, "history must have a total budget, not only a per-message limit");
  assert.ok(prompt.includes("历史问题-19"));
  assert.ok(prompt.includes("历史回答-19"));
  assert.ok(!prompt.includes("历史问题-0"));
  assert.ok(prompt.includes("省略"), "the model should know when older context was omitted");

  const oversized = buildExplorationPrompt({
    question: "继续解释", chunks: [], session: { messages: [
      { role: "user", content: "最近的关键问题" },
      { role: "assistant", status: "complete", content: "最近的关键回答" + "资料".repeat(20000) },
    ] },
  });
  assert.ok(oversized.length <= base.length + EXPLORATION_HISTORY_CHAR_LIMIT);
  assert.ok(oversized.includes("最近的关键问题"));
  assert.ok(oversized.includes("最近的关键回答"));
  assert.ok(oversized.includes("截短"));
});

test("retrying an earlier question excludes failed drafts and later conversation from its history", () => {
  const prompt = buildExplorationPrompt({
    question: "重试旧问题", currentMessageId: "m-retry", chunks: [],
    session: { messages: [
      { role: "user", content: "已经回答的问题" },
      { role: "assistant", status: "complete", content: "已完成的可信历史" },
      { role: "user", content: "失败的问题" },
      { role: "assistant", status: "failed", content: "不应发送的失败草稿" },
      { role: "user", content: "重试旧问题" },
      { id: "m-retry", role: "assistant", status: "pending", content: "" },
      { role: "user", content: "后来才提出的问题" },
      { role: "assistant", status: "complete", content: "后来才生成的回答" },
    ] },
  });
  assert.ok(prompt.includes("已完成的可信历史"));
  assert.ok(!prompt.includes("不应发送的失败草稿"));
  assert.ok(!prompt.includes("后来才提出的问题"));
  assert.ok(!prompt.includes("后来才生成的回答"));
  assert.equal(prompt.split("重试旧问题").length - 1, 1);
});

test("a real second exploration request forwards the saved conversation to the controlled model", async (t) => {
  const root = makeTempDir(t);
  const seen = [];
  const { base } = await startServer(t, root, {
    complete: async ({ prompt }) => {
      seen.push(prompt);
      return seen.length === 1 ? "启动时会读取 PORT 环境变量。" : "它让运行环境可以配置端口。";
    },
  });
  await importProject(base);
  const session = await createSession(base);
  const first = await request(base, messagesUrl(session), "POST", { prompt: "项目如何启动？" });
  assert.equal(first.status, 200);
  const second = await request(base, messagesUrl(session), "POST", { prompt: "上面的配置为什么放在环境变量中？" });
  assert.equal(second.status, 200);
  assert.equal(seen.length, 2);
  assert.ok(seen[1].includes("项目如何启动？"), "the API must pass earlier user content");
  assert.ok(seen[1].includes(first.body.assistantMessage.content), "the API must pass the actual saved answer");
  assert.equal(seen[1].split("上面的配置为什么放在环境变量中？").length - 1, 1);
});

test("concurrent exploration questions are explicitly rejected while the active answer is preserved", async (t) => {
  const root = makeTempDir(t);
  const entered = deferred();
  const release = deferred();
  let modelCalls = 0;
  const { base } = await startServer(t, root, {
    complete: async () => {
      modelCalls += 1;
      if (modelCalls === 1) {
        entered.resolve();
        await release.promise;
        return "第一条完整回答";
      }
      return "并发请求不应到达模型";
    },
  });
  await importProject(base);
  const session = await createSession(base);
  const firstPromise = request(base, messagesUrl(session), "POST", { prompt: "第一个问题" });
  await entered.promise;
  let second;
  let during;
  try {
    during = await request(base, sessionUrl(session));
    second = await request(base, messagesUrl(session), "POST", { prompt: "第二个并发问题" });
  } finally {
    release.resolve();
  }
  const first = await firstPromise;
  const stored = await request(base, sessionUrl(session));
  t.diagnostic(`concurrent response=${second.status}; stored messages=${JSON.stringify(stored.body.session.messages.map((message) => message.content))}`);
  assert.equal(during.body.session.messages.at(-1).status, "pending", "a live request must not be marked interrupted");
  assert.equal(second.status, 409, "the caller must know its concurrent question was not accepted");
  assert.equal(first.status, 200);
  assert.equal(modelCalls, 1);
  assert.deepEqual(stored.body.session.messages.map((message) => message.content), ["第一个问题", "第一条完整回答"]);
  assert.equal(stored.body.session.messages[1].status, "complete");
});

test("a new server instance marks an orphaned exploration answer failed and retries the same message", async (t) => {
  const root = makeTempDir(t);
  const previous = await startServer(t, root, { complete: async () => "unused" });
  await importProject(previous.base);
  const session = await createSession(previous.base);
  await previous.close();

  // Persist exactly the state left after accepting a question but before a
  // model reply. There is deliberately no live promise in the replacement server.
  session.messages = [
    { id: "m-interrupted-user", role: "user", content: "中断前的问题", createdAt: Date.now() },
    { id: "m-interrupted-answer", role: "assistant", status: "pending", content: "", sourceRefs: [], createdAt: Date.now() },
  ];
  const storedFile = path.join(root, "data/projects/continuity/explorations", `${session.id}.json`);
  fs.writeFileSync(storedFile, JSON.stringify(session));
  const replacement = await startServer(t, root, { complete: async () => "恢复后的回答" });
  const list = await request(replacement.base, "/api/projects/continuity/explorations");
  const recovered = await request(replacement.base, sessionUrl(session));
  assert.equal(list.body.sessions[0].messages[1].status, "failed", "history must not display an orphan as still running");
  assert.equal(recovered.body.session.messages[1].status, "failed");
  assert.ok(recovered.body.session.messages[1].error, "the interrupted state needs an actionable explanation");
  assert.equal(JSON.parse(fs.readFileSync(storedFile, "utf8")).messages[1].status, "failed", "recovery should persist");
  const retried = await request(replacement.base, `${messagesUrl(session)}/m-interrupted-answer/retry`, "POST");
  assert.equal(retried.status, 200);
  assert.equal(retried.body.assistantMessage.id, "m-interrupted-answer");
  assert.equal(retried.body.assistantMessage.status, "complete");
  const final = await request(replacement.base, sessionUrl(session));
  assert.deepEqual(final.body.session.messages.map((message) => message.content), ["中断前的问题", "恢复后的回答"]);
});

test("a duplicate retry receives 409 while the first retry is actively running", async (t) => {
  const root = makeTempDir(t);
  const entered = deferred();
  const release = deferred();
  let modelCalls = 0;
  const { base } = await startServer(t, root, {
    complete: async () => {
      modelCalls += 1;
      if (modelCalls === 1) throw new Error("controlled offline failure");
      entered.resolve();
      await release.promise;
      return "重试成功";
    },
  });
  await importProject(base);
  const session = await createSession(base);
  const failed = await request(base, messagesUrl(session), "POST", { prompt: "需要重试的问题" });
  assert.equal(failed.body.assistantMessage.status, "failed");
  const retryUrl = `${messagesUrl(session)}/${failed.body.assistantMessage.id}/retry`;
  const firstPromise = request(base, retryUrl, "POST");
  await entered.promise;
  let duplicate;
  try {
    duplicate = await request(base, retryUrl, "POST");
  } finally {
    release.resolve();
  }
  const retried = await firstPromise;
  assert.equal(duplicate.status, 409);
  assert.equal(retried.body.assistantMessage.status, "complete");
  assert.equal(modelCalls, 2);
});

test("a new server instance recovers an orphaned main-book generation instead of permanently rejecting retry", async (t) => {
  const root = makeTempDir(t);
  const previous = await startServer(t, root, { complete: async () => "unused" });
  await importProject(previous.base);
  await previous.close();
  fs.writeFileSync(path.join(root, "data/projects/continuity/generation.json"), JSON.stringify({
    status: "generating", stage: "writing", error: null, bookId: null,
    startedAt: Date.now() - 1000, updatedAt: Date.now() - 1000,
  }));
  const replacement = await startServer(t, root, { complete: async () => validBookHtml });
  const state = await request(replacement.base, "/api/projects/continuity/generation");
  assert.equal(state.body.generation.status, "failed", "an orphaned generation must not appear to be live");
  assert.ok(state.body.generation.error);
  const retried = await request(replacement.base, "/api/projects/continuity/generation", "POST");
  assert.equal(retried.status, 200, "a restarted process must permit a new generation");
  const complete = await generationUntilSettled(replacement.base);
  assert.equal(complete.status, "ready");
  assert.equal(complete.bookId, "main");
});

test("live main-book generation remains generating and rejects a duplicate start", async (t) => {
  const root = makeTempDir(t);
  const entered = deferred();
  const release = deferred();
  let modelCalls = 0;
  const { base } = await startServer(t, root, {
    complete: async () => {
      modelCalls += 1;
      entered.resolve();
      await release.promise;
      return validBookHtml;
    },
  });
  await importProject(base, { withBook: false });
  await entered.promise;
  let state;
  let duplicate;
  try {
    state = await request(base, "/api/projects/continuity/generation");
    duplicate = await request(base, "/api/projects/continuity/generation", "POST");
  } finally {
    release.resolve();
  }
  const complete = await generationUntilSettled(base);
  assert.equal(state.body.generation.status, "generating");
  assert.equal(duplicate.status, 409);
  assert.equal(complete.status, "ready");
  assert.equal(modelCalls, 1);
});
