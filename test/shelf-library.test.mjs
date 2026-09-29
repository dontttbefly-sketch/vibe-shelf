import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { startTestServer } from "./api-helpers.mjs";

const sourceHtml = `<!doctype html><style>body{color:#394d4b}</style><div class="progress"></div>
<header class="book-header"><h1>真实书名</h1><span class="sub">从入口理解 &amp; 看清边界</span></header>
<nav class="book-toc"><a href="#entry">不要重复目录</a></nav>
<main class="book-main"><section class="chapter" id="entry"><h2>01 <em>入口与流程</em></h2>
<p>第一段真实介绍，不需要调用模型。</p><pre><code>SOURCE_SECRET_DO_NOT_PREVIEW</code></pre></section>
<section class="chapter" id="state"><h2>02 状态 &amp; 存储</h2><p>理解数据流。</p></section></main>
<script>throw new Error('SCRIPT_SECRET_DO_NOT_PREVIEW')</script>`;

async function json(base, route, method = "GET", body) {
  const response = await fetch(base + route, { method, ...(body === undefined ? {} : {
    headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }) });
  return { status: response.status, body: await response.json() };
}

async function setup(t) {
  let modelCalls = 0;
  const env = await startTestServer(t, { modelClient: { complete: async () => { modelCalls++; throw new Error("preview must not call model"); } } });
  const imported = await json(env.base, "/api/projects/import", "POST", {
    projectId: "preview-demo", name: "源码项目名", files: [{ path: ".env", content: "SNAPSHOT_SECRET_DO_NOT_PREVIEW=1" }],
    mainBook: { title: "真实主书标题", sourceHtml },
  });
  assert.equal(imported.status, 201);
  const bookDir = env.root + "/data/projects/preview-demo/books/main";
  const metaFile = bookDir + "/book.json";
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  const styleFingerprint = { colors: ["#394d4b", "#fffdf7"], fonts: ["Georgia, serif"] };
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, styleFingerprint }));
  return { ...env, bookDir, project: imported.body.project, styleFingerprint, modelCalls: () => modelCalls };
}

test("shelf list adds real book metadata only on request without reading any source HTML", async (t) => {
  const env = await setup(t);
  const before = (await json(env.base, "/api/projects")).body;
  fs.renameSync(env.bookDir + "/source.html", env.bookDir + "/source.saved");
  fs.mkdirSync(env.bookDir + "/source.html");
  const list = await json(env.base, "/api/projects?view=shelf");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.projects[0].mainBook, {
    id: "main", title: "真实主书标题", url: "/projects/preview-demo/books/main/", styleFingerprint: env.styleFingerprint,
  });
  assert.equal(list.body.projects[0].bookCount, 1);
  assert.equal(list.body.projects[0].status, "ready");
  assert.deepEqual(list.body.projects[0].books.map(({ id, title, kind, url }) => ({ id, title, kind, url })), [
    { id: "main", title: "真实主书标题", kind: "main", url: "/projects/preview-demo/books/main/" },
  ]);
  assert.equal(list.body.projects[0].updatedAt >= before.projects[0].updatedAt, true);
  assert.deepEqual((await json(env.base, "/api/projects")).body, before);
  assert.equal(env.modelCalls(), 0);
});

test("preview returns real plain text, chapter links and exploration origins without changing reading history", async (t) => {
  const env = await setup(t);
  const prefix = env.root + "/data/projects/preview-demo";
  const main = JSON.parse(fs.readFileSync(env.bookDir + "/book.json", "utf8"));
  const exploration = { ...main, id: "routing", kind: "exploration", title: "路由是如何工作的", parentBookId: "main",
    originExplorationId: "exp-routing", originAnswerMessageId: "answer-routing", updatedAt: main.createdAt + 1000 };
  fs.mkdirSync(prefix + "/books/routing");
  fs.writeFileSync(prefix + "/books/routing/book.json", JSON.stringify(exploration));
  const before = fs.readFileSync(prefix + "/project.json", "utf8");
  const preview = await json(env.base, "/api/projects/preview-demo/preview");
  assert.equal(preview.status, 200);
  assert.equal(preview.body.projectId, "preview-demo");
  assert.equal(preview.body.title, "真实主书标题");
  assert.equal(preview.body.summary, "从入口理解 & 看清边界");
  assert.equal(preview.body.readingUrl, "/projects/preview-demo/books/main/");
  assert.equal(preview.body.ready, true);
  assert.equal(preview.body.previewStatus, "ready");
  assert.deepEqual(preview.body.styleFingerprint, env.styleFingerprint);
  assert.deepEqual(preview.body.chapters, [
    { id: "entry", title: "01 入口与流程", href: "/projects/preview-demo/books/main/#entry" },
    { id: "state", title: "02 状态 & 存储", href: "/projects/preview-demo/books/main/#state" },
  ]);
  assert.equal(preview.body.bookCount, 2);
  assert.equal(preview.body.books[0].id, "routing");
  assert.equal(preview.body.books[0].originExplorationId, "exp-routing");
  assert.equal(preview.body.books[0].originAnswerMessageId, "answer-routing");
  assert.equal(preview.body.updatedAt, exploration.updatedAt);
  const list = await json(env.base, "/api/projects?view=shelf");
  assert.equal(list.body.projects[0].books[1].title, "路由是如何工作的");
  assert.equal(list.body.projects[0].books[1].url, "/projects/preview-demo/books/routing/");
  assert.doesNotMatch(JSON.stringify(preview.body), /SOURCE_SECRET|SCRIPT_SECRET|SNAPSHOT_SECRET|<script|sourceHtml/);
  assert.equal(fs.readFileSync(prefix + "/project.json", "utf8"), before);
  assert.equal(JSON.parse(fs.readFileSync(env.bookDir + "/book.json", "utf8")).lastOpenedAt, undefined);
  assert.equal(env.modelCalls(), 0);
});

test("script lookalike closing tags cannot leak script text into a preview paragraph", async (t) => {
  const env = await setup(t);
  fs.writeFileSync(env.bookDir + "/source.html", `<main class="book-main"><script>const hidden = '</script-not-real><p>SCRIPT_PRIVATE</p>';</script><p>用户可以阅读的介绍</p></main>`);
  const preview = await json(env.base, "/api/projects/preview-demo/preview");
  assert.equal(preview.status, 200);
  assert.equal(preview.body.summary, "用户可以阅读的介绍");
});

test("preview uses visible prose when no subtitle exists and bounds long summaries and chapter lists", async (t) => {
  const env = await setup(t);
  const chapters = Array.from({ length: 30 }, (_, i) => `<section class="chapter" id="ch-${i}"><h2>章节 ${i}</h2><p>${"实际说明".repeat(120)}</p></section>`).join("");
  fs.writeFileSync(env.bookDir + "/source.html", `<style>CSS_SECRET</style><script>JS_SECRET</script><main class="book-main"><pre><code>CODE_SECRET</code></pre><p hidden>HIDDEN_SECRET</p>${chapters}</main>`);
  const preview = await json(env.base, "/api/projects/preview-demo/preview");
  assert.equal(preview.status, 200);
  assert.match(preview.body.summary, /^实际说明/);
  assert.ok(preview.body.summary.length <= 320);
  assert.equal(preview.body.chapters.length, 24);
  assert.equal(preview.body.chaptersTruncated, true);
  assert.doesNotMatch(JSON.stringify(preview.body), /CSS_SECRET|JS_SECRET|CODE_SECRET|HIDDEN_SECRET/);
});

test("missing or oversized previews degrade without disabling the book; paths and absent projects cannot expose files", async (t) => {
  const env = await setup(t);
  fs.writeFileSync(env.root + "/outside.html", "<p>OUTSIDE_SECRET</p>");
  fs.rmSync(env.bookDir + "/source.html");
  fs.symlinkSync(env.root + "/outside.html", env.bookDir + "/source.html");
  const blocked = await json(env.base, "/api/projects/preview-demo/preview");
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.previewStatus, "unavailable");
  assert.equal(blocked.body.ready, true);
  assert.equal(blocked.body.summary, "");
  fs.rmSync(env.bookDir + "/source.html");
  fs.writeFileSync(env.bookDir + "/source.html", "x".repeat(1024 * 1024 + 1));
  const oversized = await json(env.base, "/api/projects/preview-demo/preview");
  assert.equal(oversized.body.previewStatus, "too-large");
  assert.equal(oversized.body.summary, "");
  assert.equal((await json(env.base, "/api/projects/not-here/preview")).status, 404);
  assert.equal((await json(env.base, "/api/projects/..%2Foutside/preview")).status, 404);
  assert.equal(env.modelCalls(), 0);
});

test("saved projects without a main book have an explicit empty preview and no invented cover", async (t) => {
  const env = await setup(t);
  fs.rmSync(env.bookDir, { recursive: true });
  const manifestPath = env.root + "/data/projects/preview-demo/project.json";
  fs.writeFileSync(manifestPath, JSON.stringify({ ...env.project, mainBookId: null }));
  const preview = await json(env.base, "/api/projects/preview-demo/preview");
  assert.equal(preview.status, 200);
  assert.equal(preview.body.ready, false);
  assert.equal(preview.body.status, "pending");
  assert.equal(preview.body.previewStatus, "no-book");
  assert.equal(preview.body.readingUrl, null);
  assert.equal(preview.body.styleFingerprint, null);
  assert.equal(preview.body.summary, "");
  assert.deepEqual(preview.body.chapters, []);
});
