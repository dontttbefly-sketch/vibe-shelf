import assert from "node:assert/strict";
import test from "node:test";
import { fakeModel, startTestServer, validBookHtml } from "./api-helpers.mjs";

async function requestJson(base, requestPath, method = "GET", body) {
  const response = await fetch(`${base}${requestPath}`, body === undefined
    ? { method }
    : {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { status: response.status, body: await response.json() };
}

async function createDemoProjectAndSession(base) {
  await requestJson(base, "/api/projects/import", "POST", {
    projectId: "demo",
    name: "Demo",
    files: [{ path: "server.mjs", content: "export const environment = process.env.PORT;" }],
    mainBook: { title: "Demo 主书", sourceHtml: validBookHtml },
  });
  return (await requestJson(base, "/api/projects/demo/explorations", "POST", { originBookId: "main" })).body.session;
}

async function postMessage(base, sessionId, prompt) {
  return (await requestJson(base, `/api/projects/demo/explorations/${sessionId}/messages`, "POST", { prompt })).body;
}

async function retryMessage(base, sessionId, messageId) {
  return (await requestJson(base, `/api/projects/demo/explorations/${sessionId}/messages/${messageId}/retry`, "POST")).body;
}

async function growBook(base, sessionId, answerMessageId) {
  return (await requestJson(base, `/api/projects/demo/explorations/${sessionId}/books`, "POST", { answerMessageId })).body;
}

test("failed answers remain retryable and approved answers grow one child book", async (t) => {
  const model = fakeModel([
    new Error("offline"),
    "部署依赖环境变量。",
    '[{"title":"环境变量","rationale":"server.mjs 读取配置"},{"title":"启动流程","rationale":"server.mjs 暴露运行入口"}]',
  ]);
  const { base } = await startTestServer(t, { modelClient: model });
  const session = await createDemoProjectAndSession(base);
  const failed = await postMessage(base, session.id, "部署如何工作？");

  assert.equal(failed.assistantMessage.status, "failed");
  const retried = await retryMessage(base, session.id, failed.assistantMessage.id);
  assert.equal(retried.assistantMessage.status, "complete");
  assert.ok(retried.assistantMessage.sourceRefs.length > 0);

  const resumed = await requestJson(base, `/api/projects/demo/explorations/${session.id}`);
  assert.equal(resumed.body.session.messages.length, 2);
  assert.equal(resumed.body.session.messages[1].id, retried.assistantMessage.id);
  const projectView = await requestJson(base, "/api/projects/demo");
  assert.equal(projectView.body.recentExplorations[0].id, session.id);

  const first = await growBook(base, session.id, retried.assistantMessage.id);
  const second = await growBook(base, session.id, retried.assistantMessage.id);
  assert.equal(first.book.id, second.book.id);

  const suggestions = await requestJson(base, "/api/projects/demo/exploration-suggestions");
  assert.equal(suggestions.body.suggestions.length, 2);
  assert.ok(suggestions.body.suggestions.every((suggestion) => suggestion.sourceRefs.length > 0));
});
