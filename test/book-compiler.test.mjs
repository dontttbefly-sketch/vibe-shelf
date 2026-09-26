import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTempDir } from "./helpers.mjs";
import { compileBook } from "../lib/book-compiler.mjs";
import { createExplorationBookSource } from "../lib/exploration-book-source.mjs";

const source = `<!doctype html>
<html lang="zh-CN">
<head><style>body{color:#111}</style></head>
<body>
  <div class="progress"></div>
  <main class="book-main"><section class="chapter" id="ch-1"><h2>主章</h2><p>正文</p></section></main>
  <script>window.addEventListener("scroll", () => {});</script>
</body>
</html>`;

test("compiler injects project context and relative reader assets", (t) => {
  const root = makeTempDir(t);
  const publicDir = path.join(root, "public");
  const outFile = path.join(publicDir, "projects", "demo", "books", "main", "index.html");

  compileBook({
    sourceHtml: source,
    title: "Demo",
    runtimeContext: {
      projectId: "demo",
      bookId: "main",
      sourceSnapshotId: "s-1",
      kind: "main",
      staticNotesUrl: "data/main.json",
    },
    outFile,
    publicDir,
  });

  const html = fs.readFileSync(outFile, "utf8");
  assert.match(html, /window\.SHELF_CONTEXT = \{"projectId":"demo","bookId":"main"/);
  assert.match(html, /href="\.\.\/\.\.\/\.\.\/\.\.\/notes\.css"/);
  assert.match(html, /src="\.\.\/\.\.\/\.\.\/\.\.\/explore\.js"/);
  assert.match(html, /data-shelf-reader-topbar/);
  assert.match(html, /href="\.\.\/\.\.\/\.\.\/\.\.\/index\.html#bookshelf"/);
  assert.match(html, /返回书架/);
  assert.doesNotMatch(html, /project\.html\?id/);
  assert.match(html, /data-shelf-explore/);
});

test("exploration source satisfies the book DOM contract and escapes raw HTML", () => {
  const html = createExplorationBookSource({
    title: "运行环境 <script>",
    answerMarkdown: "### 为什么\n因为配置在启动时读取。\n\n<script>alert(1)</script>",
    sourceRefs: [{ path: "server.mjs", startLine: 1, endLine: 4 }],
  });

  assert.match(html, /<div class="progress">/);
  assert.match(html, /<main class="book-main">/);
  assert.match(html, /<section class="chapter" id="ch-1">/);
  assert.match(html, /<script>/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
