import assert from "node:assert/strict";
process.on("unhandledRejection", (e) => console.error("[UR]", e && e.stack || e));
import test from "node:test";
import { startTestServer, validBookHtml } from "./api-helpers.mjs";

function queueModel(responses) {
  const queue = [...responses];
  return {
    complete: async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error("no queued model response");
      return next;
    },
  };
}

async function requestJson(base, requestPath, method = "GET", body) {
  const response = await fetch(`${base}${requestPath}`, body === undefined
    ? { method }
    : {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
  let data = null;
  try { data = await response.json(); } catch {}
  return { response, body: data };
}

async function pollGeneration(base, projectId, { timeoutMs = 3000 } = {}) {
  const started = Date.now();
  for (;;) {
    const { body } = await requestJson(base, `/api/projects/${projectId}/generation`);
    if (body?.generation && body.generation.status !== "generating") return body.generation;
    if (Date.now() - started > timeoutMs) throw new Error("generation polling timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function importWithoutMainBook(base, projectId) {
  return requestJson(base, "/api/projects/import", "POST", {
    projectId,
    name: "Demo",
    files: [{ path: "src/app.mjs", content: "export const answer = 42;" }],
  });
}

test("import without a main book starts a background generation and lands a main book", async (t) => {
  const { base } = await startTestServer(t, { modelClient: queueModel([validBookHtml]) });
  const imported = await importWithoutMainBook(base, "demo-gen");
  assert.equal(imported.response.status, 201);
  assert.equal(imported.body.generation.status, "generating");
  assert.equal(imported.body.project.mainBookId, null);

  const generation = await pollGeneration(base, "demo-gen");
  assert.equal(generation.status, "ready");
  assert.equal(generation.bookId, "main");

  const view = await requestJson(base, "/api/projects/demo-gen");
  assert.equal(view.response.status, 200);
  assert.equal(view.body.books.length, 1);
  assert.equal(view.body.books[0].id, "main");
});

test("failed generation keeps the project and a retry can land the main book", async (t) => {
  const { base } = await startTestServer(t, { modelClient: queueModel([new Error("模型超时"), validBookHtml]) });
  const imported = await importWithoutMainBook(base, "demo-fail");
  assert.equal(imported.response.status, 201);

  const failed = await pollGeneration(base, "demo-fail");
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /模型超时/);

  const view = await requestJson(base, "/api/projects/demo-fail");
  assert.equal(view.response.status, 200);
  assert.equal(view.body.books.length, 0);

  const retried = await requestJson(base, "/api/projects/demo-fail/generation", "POST");
  assert.equal(retried.response.status, 200);
  const generation = await pollGeneration(base, "demo-fail");
  assert.equal(generation.status, "ready");
  assert.equal(generation.bookId, "main");
});

test("regenerating replaces the main book instead of duplicating it", async (t) => {
  const { base } = await startTestServer(t, { modelClient: queueModel([validBookHtml, validBookHtml]) });
  await importWithoutMainBook(base, "demo-replace");
  await pollGeneration(base, "demo-replace");

  const again = await requestJson(base, "/api/projects/demo-replace/generation", "POST");
  assert.equal(again.response.status, 200);
  const generation = await pollGeneration(base, "demo-replace");
  assert.equal(generation.status, "ready");

  const view = await requestJson(base, "/api/projects/demo-replace");
  assert.equal(view.body.books.length, 1);
});

test("generating twice at the same time is rejected", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { base } = await startTestServer(t, {
    modelClient: { complete: async () => { await gate; return validBookHtml; } },
  });
  const imported = await importWithoutMainBook(base, "demo-lock");
  assert.equal(imported.response.status, 201);

  const second = await requestJson(base, "/api/projects/demo-lock/generation", "POST");
  assert.equal(second.response.status, 409);
  release();
  const generation = await pollGeneration(base, "demo-lock");
  assert.equal(generation.status, "ready");
});

test("opening a book touches lastOpenedAt and the shelf sorts by it", async (t) => {
  const { base } = await startTestServer(t, { modelClient: queueModel([validBookHtml]) });
  await importWithoutMainBook(base, "demo-touch");
  await pollGeneration(base, "demo-touch");

  // 等到 lastOpenedAt 明显大于创建时间
  await new Promise((resolve) => setTimeout(resolve, 30));
  const notes = await requestJson(base, "/api/projects/demo-touch/books/main/notes");
  assert.equal(notes.response.status, 200);

  const list = await requestJson(base, "/api/projects");
  const project = list.body.projects.find((p) => p.id === "demo-touch");
  assert.ok(project.lastOpenedAt > project.createdAt, "lastOpenedAt should be touched");
  assert.equal(list.body.projects[0].id, "demo-touch");
  assert.equal(project.generationStatus, "ready");
});
