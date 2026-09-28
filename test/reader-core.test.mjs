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

test("makeSrcRefRe matches paths with or without line numbers", () => {
  const re = Core.makeSrcRefRe();
  // 带行号：裸文件名也认（旧契约行为不变）
  let match = re.exec("见 code.py:42 的实现");
  assert.equal(match[1], "code.py");
  assert.equal(match[2], "42");
  // 无行号：完整路径照收
  re.lastIndex = 0;
  match = re.exec("打开 s01_agent_loop/code.py 看看");
  assert.equal(match[1], "s01_agent_loop/code.py");
  assert.equal(match[2], undefined);
  // tsx 不能被截成 ts
  re.lastIndex = 0;
  match = re.exec("组件 src/app.tsx 里");
  assert.equal(match[1], "src/app.tsx");
  // 每次调用都是新实例，lastIndex 不互相踩
  const a = Core.makeSrcRefRe();
  const b = Core.makeSrcRefRe();
  a.exec("x/y.py");
  assert.equal(b.lastIndex, 0);
});

test("resolveSourcePath only resolves unique hits", () => {
  const files = [
    { path: "s01_agent_loop/code.py" },
    { path: "s12_cron_scheduler/code.py" },
    { path: "agents/s01_agent_loop.py" },
    { path: "docs/zh/guide.md" },
  ];
  // 精确
  assert.equal(Core.resolveSourcePath("s12_cron_scheduler/code.py", files), "s12_cron_scheduler/code.py");
  // 唯一后缀
  assert.equal(Core.resolveSourcePath("guide.md", files), "docs/zh/guide.md");
  // 编号近邻：书里目录编号整批错位时纠回来（同头同尾、只有数字不同）
  assert.equal(Core.resolveSourcePath("s09_cron_scheduler/code.py", files), "s12_cron_scheduler/code.py");
  // 歧义（多份同名 basename）→ 不解析
  assert.equal(Core.resolveSourcePath("code.py", files), null);
  // 不存在 → null
  assert.equal(Core.resolveSourcePath("nope/missing.py", files), null);
  assert.equal(Core.resolveSourcePath("", files), null);
  // 编号近邻也不唯一 → null
  const twins = [{ path: "s02_thing/a.py" }, { path: "s05_thing/a.py" }];
  assert.equal(Core.resolveSourcePath("s09_thing/a.py", twins), null);
});
