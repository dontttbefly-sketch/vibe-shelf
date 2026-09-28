import assert from "node:assert/strict";
import test from "node:test";
import { anchorCodeBlocks } from "../lib/source-link.mjs";

const SIX_LINES = [
  "const alpha = 1;",
  "const beta = 2;",
  "const gamma = 3;",
  "const delta = 4;",
  "const epsilon = 5;",
  "const zeta = 6;",
];

function block(lines) {
  return `<pre><code>${lines.join("\n")}</code></pre>`;
}

test("anchors a verbatim code block to its file and start line", () => {
  const files = [
    { path: "src/app.mjs", content: `// header\n\n${SIX_LINES.join("\n")}\n` },
    { path: "src/other.mjs", content: "export const nothing = true;\n" },
  ];
  const { html, stats } = anchorCodeBlocks(`<p>看代码：</p>${block(SIX_LINES.slice(0, 5))}`, files);
  assert.match(html, /<pre data-file="src\/app\.mjs" data-line="3">/);
  assert.deepEqual(stats, { blocks: 1, anchored: 1, ambiguous: 0 });
});

test("decodes html entities before matching", () => {
  const files = [{ path: "src/cond.mjs", content: SIX_LINES.map((line) => `if (a < b) { ${line} }`).join("\n") }];
  const escaped = SIX_LINES.slice(0, 5).map((line) => `if (a &lt; b) { ${line} }`);
  const { stats } = anchorCodeBlocks(block(escaped), files);
  assert.equal(stats.anchored, 1);
});

test("leaves blocks with an existing data-file attribute untouched", () => {
  const files = [{ path: "src/app.mjs", content: SIX_LINES.join("\n") }];
  const input = `<pre data-file="assets/styles.css" dropzone="file"><code>${SIX_LINES.slice(0, 5).join("\n")}</code></pre>`;
  const { html, stats } = anchorCodeBlocks(input, files);
  assert.equal(html, input);
  assert.equal(stats.anchored, 0);
});

test("does not anchor rewritten snippets", () => {
  const files = [{ path: "src/app.mjs", content: SIX_LINES.join("\n") }];
  const rewritten = SIX_LINES.slice(0, 5).map((line) => `${line} // 改写`);
  const { stats } = anchorCodeBlocks(block(rewritten), files);
  assert.deepEqual(stats, { blocks: 1, anchored: 0, ambiguous: 0 });
});

test("drops weak anchors below the run threshold", () => {
  const files = [{ path: "src/app.mjs", content: SIX_LINES.join("\n") }];
  const { stats } = anchorCodeBlocks(block(SIX_LINES.slice(0, 4)), files);
  assert.equal(stats.anchored, 0);
});

test("disambiguates identical boilerplate by the nearest preceding citation", () => {
  const files = [
    { path: "s01_loop/code.py", content: SIX_LINES.join("\n") },
    { path: "s12_cron/code.py", content: SIX_LINES.join("\n") },
  ];
  const content = block(SIX_LINES.slice(0, 5));
  const hinted = anchorCodeBlocks(`<p>s12_cron/code.py 里的循环：</p>${content}`, files);
  assert.match(hinted.html, /data-file="s12_cron\/code.py"/);

  const unhinted = anchorCodeBlocks(`<p>这段样板代码：</p>${content}`, files);
  assert.equal(unhinted.stats.anchored, 0);
  assert.equal(unhinted.stats.ambiguous, 1);
});

test("prefers code files over docs and chinese docs over other languages", () => {
  const files = [
    { path: "s03/README.md", content: SIX_LINES.join("\n") },
    { path: "s03/README.zh.md", content: SIX_LINES.join("\n") },
    { path: "s03/README.ja.md", content: SIX_LINES.join("\n") },
  ];
  const docOnly = anchorCodeBlocks(block(SIX_LINES.slice(0, 5)), files);
  assert.match(docOnly.html, /data-file="s03\/README.zh.md"/);

  const withCode = anchorCodeBlocks(block(SIX_LINES.slice(0, 5)), [
    ...files,
    { path: "s03/code.py", content: SIX_LINES.join("\n") },
  ]);
  assert.match(withCode.html, /data-file="s03\/code\.py"/);
});
