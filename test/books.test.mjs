import assert from "node:assert/strict";
import test from "node:test";
import { makeTempDir } from "./helpers.mjs";
import { createBookStore } from "../lib/books.mjs";
import { createNotesStore } from "../lib/notes-store.mjs";

const mainSource = `<!doctype html><style>body{}</style><div class="progress"></div><main class="book-main"><section class="chapter" id="ch-1"><h2>主书</h2></section></main><script>void 0</script>`;

test("the same answer grows into exactly one exploration book", (t) => {
  const root = makeTempDir(t);
  const books = createBookStore({ dataDir: root, publicDir: `${root}/public` });
  const main = books.registerMainBook({
    projectId: "demo",
    title: "项目主书",
    sourceSnapshotId: "s-1",
    sourceHtml: mainSource,
  });
  assert.equal(main.id, "main");

  const first = books.growExplorationBook({
    projectId: "demo",
    sessionId: "e-1",
    answerMessageId: "m-2",
    title: "运行环境",
    answerMarkdown: "第一章",
    sourceSnapshotId: "s-1",
    sourceRefs: [],
  });
  const second = books.growExplorationBook({
    projectId: "demo",
    sessionId: "e-1",
    answerMessageId: "m-2",
    title: "运行环境",
    answerMarkdown: "第一章",
    sourceSnapshotId: "s-1",
    sourceRefs: [],
  });

  assert.equal(first.id, second.id);
  assert.equal(books.listBooks("demo").filter((book) => book.kind === "exploration").length, 1);
});

test("notes are isolated by project and book", (t) => {
  const root = makeTempDir(t);
  const notes = createNotesStore({ dataDir: root });
  notes.upsert("demo", "main", { id: "n-1", body: "主书旁注" });
  notes.upsert("demo", "child", { id: "n-1", body: "小书旁注" });

  assert.equal(notes.list("demo", "main")[0].body, "主书旁注");
  assert.equal(notes.list("demo", "child")[0].body, "小书旁注");
});

test("a failed child-book compilation leaves no visible book", (t) => {
  const root = makeTempDir(t);
  const books = createBookStore({
    dataDir: root,
    publicDir: `${root}/public`,
    compile: () => { throw new Error("compile failed"); },
  });

  assert.throws(
    () => books.growExplorationBook({
      projectId: "demo",
      sessionId: "e-1",
      answerMessageId: "m-9",
      title: "失败主题",
      answerMarkdown: "内容",
      sourceSnapshotId: "s-1",
      sourceRefs: [],
    }),
    /compile failed/,
  );
  assert.equal(books.listBooks("demo").some((book) => book.originAnswerMessageId === "m-9"), false);
});
