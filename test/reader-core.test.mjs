import assert from "node:assert/strict";
import test from "node:test";
import Core from "../public/reader-core.js";

test("tokenDiff cleans up fragmented chinese diffs", () => {
  // 踩坑回归：纯 LCS 会把「很危险」切成 删:很危 / 增:存在注入风 / 留:险
  const ops = Core.tokenDiff("这很危险", "这存在注入风险");
  for (const op of ops) {
    if (op.t === "same") assert.ok(op.text.length > 2, `碎块残留: ${JSON.stringify(op)}`);
  }
  const kinds = ops.map((o) => o.t);
  assert.ok(kinds.includes("del") && kinds.includes("add"));
});

test("tokenDiff keeps del-before-add reading order", () => {
  const ops = Core.tokenDiff("old text", "new text");
  const firstChange = ops.findIndex((o) => o.t !== "same");
  assert.equal(ops[firstChange].t, "del", "同一处增删必须先删后增");
});

test("tokenDiff falls back to whole-block diff beyond token limit", () => {
  const big = "x".repeat(1300);
  const ops = Core.tokenDiff(big, big + "y");
  assert.deepEqual(ops, [
    { t: "del", text: big },
    { t: "add", text: big + "y" },
  ]);
});

test("markMd wraps ops with paired control marks", () => {
  const md = Core.markMd([
    { t: "same", text: "a" },
    { t: "del", text: "b" },
    { t: "add", text: "c" },
  ]);
  // 控制标记本身不可见，逐字符校验配对标记
  assert.equal(md.replace(/[\u0000-\u0008]/g, ""), "abc");
  assert.equal([...md].filter((ch) => ch.charCodeAt(0) > 0 && ch.charCodeAt(0) < 9).length, 4);
  assert.deepEqual(Core.countMarkOps(Core.tokenDiff("a", "b")), { adds: 1, dels: 1 });
});

test("clipSelection reveals exactly three chars plus ellipsis", () => {
  assert.equal(Core.clipSelection("  多  个 空 白 字 符  "), "多 个…");
  assert.equal(Core.clipSelection("三字"), "三字");
  assert.equal(Core.clipSelection(""), "");
  assert.equal(Core.clipSelection(null), "");
});

test("matchFilesByText distinguishes full-path hits from ambiguous basenames", () => {
  const files = [
    { path: "ch01/code.py" },
    { path: "ch02/code.py" },
    { path: "assets/styles.css" },
  ];
  // 完整路径命中 → 确定
  assert.deepEqual(Core.matchFilesByText("见 assets/styles.css 的定义", files), {
    full: ["assets/styles.css"],
    base: [],
  });
  // 仅 basename 命中且同名歧义 → 只列出，不敢默认勾
  const ambiguous = Core.matchFilesByText("看 code.py 里的循环", files);
  assert.deepEqual(ambiguous.full, []);
  assert.deepEqual(ambiguous.base, ["ch01/code.py", "ch02/code.py"]);
  // 唯一 basename 命中 → 也是可默认的候选
  assert.deepEqual(Core.matchFilesByText("改 styles.css", files).base, ["assets/styles.css"]);
  assert.deepEqual(Core.matchFilesByText("", files), { full: [], base: [] });
  assert.deepEqual(Core.matchFilesByText("x", []), { full: [], base: [] });
});
