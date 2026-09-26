import assert from "node:assert/strict";
import test from "node:test";
import { makeTempDir } from "./helpers.mjs";
import { buildMainBookPrompt, extractStyleFingerprint, lintSkinTokens } from "../lib/prompts.mjs";
import { createBookStore } from "../lib/books.mjs";

test("extractStyleFingerprint collects colors and fonts from the style block", () => {
  const html = `<!doctype html><style>
    :root { --paper: #f7f3ea; --accent: #8B3A1F; }
    body { color: #2a2520; font-family: ui-serif, serif; }
    .mark { background: rgba(206, 123, 81, .16); }
  </style>`;
  const fingerprint = extractStyleFingerprint(html);
  assert.ok(fingerprint);
  assert.ok(fingerprint.colors.includes("#f7f3ea"));
  assert.ok(fingerprint.colors.includes("#8b3a1f"));
  assert.ok(fingerprint.colors.includes("rgba(206,123,81,.16)"));
  assert.deepEqual(fingerprint.fonts, ["ui-serif, serif"]);
});

test("extractStyleFingerprint returns null without a meaningful style block", () => {
  assert.equal(extractStyleFingerprint("<p>no style</p>"), null);
  assert.equal(extractStyleFingerprint("<style>/* only comments */</style>"), null);
  assert.equal(extractStyleFingerprint(null), null);
});

test("main book prompt fixes the skeleton and lists used styles to avoid", () => {
  const prompt = buildMainBookPrompt({
    name: "Demo",
    files: [{ path: "src/app.mjs", content: "export const answer = 42;" }],
    usedStyles: [
      { colors: ["#f7f3ea", "#8b3a1f"], fonts: ["ui-serif, serif"] },
      { colors: [], fonts: [] },
    ],
  });

  assert.match(prompt, /book-header/);
  assert.match(prompt, /book-toc/);
  assert.match(prompt, /eyebrow/);
  assert.match(prompt, /book-layout/);
  assert.match(prompt, /浅色纸面系/);
  assert.match(prompt, /不得与它们重合/);
  assert.match(prompt, /#f7f3ea/);
  assert.match(prompt, /ui-serif, serif/);
  assert.match(prompt, /主色：无记录/);
});

test("registerMainBook persists the style fingerprint into book.json", (t) => {
  const root = makeTempDir(t);
  const books = createBookStore({ dataDir: root, publicDir: `${root}/public` });
  const source = `<!doctype html><style>body{background:#fffdf7}</style><div class="progress"></div><main class="book-main"><section class="chapter" id="ch-1"><h2>主书</h2></section></main><script>void 0</script>`;

  const book = books.registerMainBook({
    projectId: "demo",
    title: "项目主书",
    sourceSnapshotId: "s-1",
    sourceHtml: source,
    styleFingerprint: { colors: ["#fffdf7"], fonts: ["ui-serif, serif"] },
  });

  assert.deepEqual(book.styleFingerprint, { colors: ["#fffdf7"], fonts: ["ui-serif, serif"] });
  const reread = books.getBook("demo", "main");
  assert.deepEqual(reread.styleFingerprint, { colors: ["#fffdf7"], fonts: ["ui-serif, serif"] });

  const withoutFingerprint = books.registerMainBook({
    projectId: "demo2",
    title: "另一本主书",
    sourceSnapshotId: "s-1",
    sourceHtml: source,
  });
  assert.equal(withoutFingerprint.styleFingerprint, null);
});

test("main book prompt requires verifiable file:line citations", () => {
  const prompt = buildMainBookPrompt({
    name: "Demo",
    files: [{ path: "agents/s01_agent_loop.py", content: "while True:\n    pass\n" }],
  });
  assert.match(prompt, /文件路径:行号/);
  assert.match(prompt, /agents\/s01_agent_loop\.py:42/);
  assert.match(prompt, /行号必须与源码一致/);
});

test("lintSkinTokens warns when the skin misses semantic tokens", () => {
  const good = `<style>:root { --paper: #fffdf7; --ink: #151b1e; --code-bg: #f5f1ea; --code-ink: #333; --line: #e5ddd0; }</style>`;
  assert.deepEqual(lintSkinTokens(good), { ok: true, missing: [] });

  // 缺 --line：夜间模式分隔线会被宿主样式渗色
  const noLine = `<style>:root { --paper: #fff; --ink: #111; --code-bg: #f5; --code-ink: #222; }</style>`;
  assert.deepEqual(lintSkinTokens(noLine), { ok: false, missing: ["--line"] });

  // 没有 style 块 / 没有 :root → 全缺
  assert.equal(lintSkinTokens("no style").ok, false);
  assert.equal(lintSkinTokens("<style>body{}</style>").ok, false);
});
