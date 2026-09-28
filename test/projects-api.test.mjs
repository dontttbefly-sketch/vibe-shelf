import assert from "node:assert/strict";
import test from "node:test";
import { startTestServer, validBookHtml } from "./api-helpers.mjs";

async function requestJson(base, requestPath, method = "GET", body) {
  const response = await fetch(`${base}${requestPath}`, body === undefined
    ? { method }
    : {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { response, body: await response.json() };
}

test("import creates a project, a main book, and isolated note endpoints", async (t) => {
  const { base } = await startTestServer(t);
  const imported = await requestJson(base, "/api/projects/import", "POST", {
    projectId: "demo",
    name: "Demo",
    files: [{ path: "src/app.mjs", content: "export const answer = 42;" }],
    mainBook: { title: "Demo 主书", sourceHtml: validBookHtml },
  });

  assert.equal(imported.response.status, 201);
  assert.equal(imported.body.project.mainBookId, "main");
  const summaries = await requestJson(base, "/api/projects");
  assert.equal(summaries.response.status, 200);
  assert.equal(summaries.body.projects[0].bookCount, 1);
  const view = await requestJson(base, "/api/projects/demo");
  assert.equal(view.body.books[0].url, "/projects/demo/books/main/");

  const invalidFile = await fetch(
    `${base}/api/projects/demo/snapshots/${imported.body.project.currentSnapshotId}/file?path=../secret`,
  );
  assert.equal(invalidFile.status, 404);

  // 文件清单必须带真实体积：主书生成的体积预算和阅读器的文件勾选都靠它
  const listed = await requestJson(
    base,
    `/api/projects/demo/snapshots/${imported.body.project.currentSnapshotId}/files`,
  );
  assert.deepEqual(listed.body.files, [{ path: "src/app.mjs", size: 25 }]);

  const createdNote = await requestJson(base, "/api/projects/demo/books/main/notes", "POST", {
    note: { id: "n-1", body: "项目主书旁注" },
  });
  assert.equal(createdNote.response.status, 200);
  const listedNotes = await requestJson(base, "/api/projects/demo/books/main/notes");
  assert.deepEqual(listedNotes.body, [{ id: "n-1", body: "项目主书旁注" }]);
});

test("published book directory URLs serve the reader HTML", async (t) => {
  const { base } = await startTestServer(t);
  await requestJson(base, "/api/projects/import", "POST", {
    projectId: "demo",
    name: "Demo",
    files: [{ path: "src/app.mjs", content: "export const answer = 42;" }],
    mainBook: { title: "Demo 主书", sourceHtml: validBookHtml },
  });
  const view = await requestJson(base, "/api/projects/demo");
  const response = await fetch(`${base}${view.body.books[0].url}`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /window\.SHELF_CONTEXT/);
  assert.match(html, /Demo 主书/);
});

test("invalid main-book HTML leaves no imported project", async (t) => {
  const { base } = await startTestServer(t);
  const imported = await requestJson(base, "/api/projects/import", "POST", {
    projectId: "broken",
    name: "Broken",
    files: [{ path: "src/app.mjs", content: "export {}" }],
    mainBook: { title: "坏书", sourceHtml: "<html>not a teaching book</html>" },
  });

  assert.equal(imported.response.status, 400);
  assert.equal((await fetch(`${base}/api/projects/broken`)).status, 404);
});

test("manual source refresh creates a new snapshot without changing the main book", async (t) => {
  const { base } = await startTestServer(t);
  const imported = await requestJson(base, "/api/projects/import", "POST", {
    projectId: "demo",
    name: "Demo",
    files: [{ path: "src/app.mjs", content: "export const version = 1;" }],
    mainBook: { title: "Demo 主书", sourceHtml: validBookHtml },
  });
  const firstSnapshot = imported.body.project.currentSnapshotId;
  const refreshed = await requestJson(base, "/api/projects/demo/snapshots", "POST", {
    files: [{ path: "src/app.mjs", content: "export const version = 2;" }],
  });

  assert.equal(refreshed.response.status, 201);
  assert.notEqual(refreshed.body.project.currentSnapshotId, firstSnapshot);
  assert.equal((await requestJson(base, "/api/projects/demo")).body.books[0].sourceSnapshotId, firstSnapshot);
});
