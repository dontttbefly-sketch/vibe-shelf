import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("reader supports a project/book context without removing legacy fallback", () => {
  const source = fs.readFileSync("public/notes.js", "utf8");
  assert.match(source, /window\.SHELF_CONTEXT/);
  assert.match(source, /projectId/);
  assert.match(source, /projectNotesPath/);
  assert.match(source, /projectSnapshotPath/);
  assert.match(source, /projectBookPath/);
  assert.match(source, /projectBookPath\("explain"\)/);
  assert.match(source, /projectBookPath\("followup"\)/);
  assert.match(source, /window\.SHELF_BOOK \|\| "default"/);
  assert.match(source, /staticNotesUrl/);
});

test("reader includes the matured single-page annotation interactions", () => {
  const source = fs.readFileSync("public/notes.js", "utf8");
  const styles = fs.readFileSync("public/notes.css", "utf8");

  assert.match(source, /searchPanel/);
  assert.match(source, /openGlobalSearch/);
  assert.match(source, /playSearchInsertMotion/);
  assert.match(source, /nb-promoted-restore/);
  assert.match(source, /applyNotePlacement/);
  assert.match(source, /miniTimer/);
  assert.match(source, /markQuoteIn/);

  assert.match(styles, /\.nb-search-panel/);
  assert.match(styles, /\.nb-promoted-restore/);
  assert.match(styles, /@keyframes nbRestoreQuote/);
  assert.match(styles, /@keyframes nbPromotedInserted/);
  assert.match(styles, /@keyframes nbSearchCommit/);
});

test("reader allows long code selections to open annotation entry", () => {
  const source = fs.readFileSync("public/notes.js", "utf8");

  assert.match(source, /MAX_SELECTION_QUOTE_CHARS\s*=\s*4000/);
  assert.match(source, /quote\.length > MAX_SELECTION_QUOTE_CHARS/);
  assert.match(source, /text\.length > MAX_SELECTION_QUOTE_CHARS/);
  assert.doesNotMatch(source, /(?:quote|text)\.length > 300/);
});

test("reader keeps processing selections sharp and legible", () => {
  const styles = fs.readFileSync("public/notes.css", "utf8");
  const processingRule = styles.match(
    /\.book-main mark\.nb-quote\.nb-processing,[\s\S]*?\.book-main \.nb-block\.nb-processing[\s\S]*?\}/
  );

  assert.ok(processingRule, "expected processing selection styles to exist");
  assert.doesNotMatch(processingRule[0], /filter:\s*blur\(/);
  assert.doesNotMatch(processingRule[0], /opacity:\s*\.[0-9]+/);
});

test("reader follow-up uses an inline bottom composer and applies changes without diff review", () => {
  const source = fs.readFileSync("public/notes.js", "utf8");
  const askFollowup = source.match(/async function askFollowup[\s\S]*?\n  \}/);

  assert.match(source, /openInlineAsk\("append"/);
  assert.match(source, /openInlineAsk\("edit"/);
  assert.match(source, /function scrollInlineAskIntoView/);
  assert.match(source, /function applyFollowupInline/);
  assert.ok(askFollowup, "expected askFollowup function");
  assert.doesNotMatch(askFollowup[0], /paintDiff\(\)/);
  assert.doesNotMatch(askFollowup[0], /__diffOriginal/);
});

test("reader follow-up folds changes into the note body instead of a diff card", () => {
  const source = fs.readFileSync("public/notes.js", "utf8");
  const styles = fs.readFileSync("public/notes.css", "utf8");

  // 审阅卡体系（对照/左右对比/确认覆盖/返回上一句话）整体退场
  assert.doesNotMatch(source, /paintDiff|renderDiffFlow|renderDiffSplit|diffBlockHtml|applyDiffInPlace|revertDiff|isDiffMode/);
  assert.doesNotMatch(styles, /\.nb-diff/);

  // 改动以字级标记直接落在原文里：划线=删去，底色高亮=新增
  assert.match(source, /function tokenDiff/);
  assert.match(source, /function markedToHtml/);
  assert.match(source, /function renderChangeHtml/);
  assert.match(source, /class="nb-w-del"/);
  assert.match(source, /class="nb-w-add"/);
  assert.match(styles, /\.nb-w-del[\s\S]*text-decoration:\s*line-through/);
  assert.match(styles, /\.nb-w-add[\s\S]*background:/);

  // 哪次追问改的由问句痕承担（问句列表 = 对话记录 = 版本历史），正文里只留字级标记
  assert.match(source, /nb-ask-trail/);
  assert.match(source, /__versions/);
  assert.doesNotMatch(source, /确认覆盖|返回上一句话/);
});

test("reader token diff marks the exact words that changed", () => {
  const source = fs.readFileSync("public/notes.js", "utf8");
  const block = source.match(
    /\/\/ ---- 字词级 diff 单测区（纯函数，勿依赖 DOM） ----([\s\S]*?)\/\/ ---- 字词级 diff 单测区结束 ----/,
  );
  assert.ok(block, "expected the pure token-diff block to exist");
  const api = new Function(block[1] + "; return { tokenDiff, markMd, countMarkOps, DIFF_TOKEN_LIMIT };")();

  const shapes = (ops) => ops.map((o) => o.t + ":" + o.text);

  assert.deepEqual(shapes(api.tokenDiff("小猫在窗台上睡觉", "小猫在阳台上睡觉")), [
    "same:小猫在",
    "del:窗",
    "add:阳",
    "same:台上睡觉",
  ]);
  assert.deepEqual(shapes(api.tokenDiff("你好", "你好世界")), ["same:你好", "add:世界"]);
  assert.deepEqual(shapes(api.tokenDiff("你好世界", "你好")), ["same:你好", "del:世界"]);
  assert.deepEqual(shapes(api.tokenDiff("use the foo bar", "use the baz bar")), [
    "same:use the ",
    "del:foo",
    "add:baz",
    "same: bar",
  ]);
  assert.deepEqual(shapes(api.tokenDiff("一模一样", "一模一样")), ["same:一模一样"]);

  // 增删相邻时保持"先删后增"的阅读顺序
  assert.deepEqual(shapes(api.tokenDiff("旧的写法", "新的写法")), ["del:旧", "add:新", "same:的写法"]);

  // 夹在增删之间的零星同字要并进增删块，不能留下"划掉 X / 高亮 Y / 留着 Z"的碎片
  assert.deepEqual(shapes(api.tokenDiff("所以很危险。", "所以存在注入风险。")), [
    "same:所以",
    "del:很危",
    "add:存在注入风",
    "same:险。",
  ]);

  // 标记成对出现，渲染后可直接替换成 <del>/<ins>
  const marked = api.markMd(api.tokenDiff("小猫在窗台上睡觉", "小猫在阳台上睡觉"));
  assert.equal((marked.match(/\u0002/g) || []).length, 1);
  assert.equal((marked.match(/\u0003/g) || []).length, 1);
  assert.equal((marked.match(/\u0004/g) || []).length, 1);
  assert.equal((marked.match(/\u0005/g) || []).length, 1);

  // 超长文本降级为整块增删，不做 O(n·m) 回溯
  const huge = "字".repeat(api.DIFF_TOKEN_LIMIT + 10);
  assert.deepEqual(shapes(api.tokenDiff(huge, huge + "新")), ["del:" + huge, "add:" + huge + "新"]);
  assert.deepEqual(api.countMarkOps(api.tokenDiff("你好", "你好世界")), { adds: 1, dels: 0 });
});

test("reader follow-up thinking shows a Claude-style shimmer", () => {
  const source = fs.readFileSync("public/notes.js", "utf8");
  const styles = fs.readFileSync("public/notes.css", "utf8");

  assert.match(source, /nb-shimmer/);
  assert.match(source, /THINK_LINES_FOLLOWUP/);
  assert.match(styles, /\.nb-shimmer/);
  assert.match(styles, /@keyframes nbShimmerSweep/);
  assert.match(styles, /\.nb-shimmer-band[\s\S]*will-change:\s*transform/);
  // 扫光只用 transform 位移，不靠 background-position 重绘
  const sweep = styles.match(/@keyframes nbShimmerSweep[\s\S]*?\n\}/);
  assert.ok(sweep, "expected the shimmer keyframes");
  assert.doesNotMatch(sweep[0], /background-position|mask-position/);
  assert.match(sweep[0], /translateX/);
});

test("reader follow-up composer and inline change marks have the requested visual language", () => {
  const styles = fs.readFileSync("public/notes.css", "utf8");

  assert.match(styles, /\.nb-inline-ask/);
  assert.match(styles, /\.nb-inline-ask\.nb-show/);
  assert.match(styles, /\.nb-inline-textarea[\s\S]*min-height:\s*calc\(2em/);
  assert.match(styles, /\.nb-inline-textarea[\s\S]*background:\s*rgba\(/);
  assert.match(styles, /\.nb-inline-go[\s\S]*right:/);
  assert.match(styles, /\.nb-inline-think/);
  assert.match(styles, /\.nb-w-del[\s\S]*text-decoration:\s*line-through/);
  assert.match(styles, /\.nb-w-add[\s\S]*background:/);
});

test("reader follow-up composer badges the selected text with a clipped label", () => {
  const source = fs.readFileSync("public/notes.js", "utf8");
  const styles = fs.readFileSync("public/notes.css", "utf8");
  const block = source.match(
    /\/\/ ---- 字词级 diff 单测区（纯函数，勿依赖 DOM） ----([\s\S]*?)\/\/ ---- 字词级 diff 单测区结束 ----/,
  );
  assert.ok(block, "expected the pure token-diff block to exist");
  const api = new Function(block[1] + "; return { clipSelection };")();

  // 只露前三个字，其余用省略号收掉——用户一眼确认"我选中的是这段"
  assert.equal(api.clipSelection("小猫在窗台上睡觉"), "小猫在…");
  assert.equal(api.clipSelection("所以很危险。"), "所以很…");
  // 空白先归一，避免选中跨行时标签里出现换行
  assert.equal(api.clipSelection("  \n 你好世界  "), "你好世…");
  assert.equal(api.clipSelection("React 的 useState"), "Rea…");
  // 本身就不超过三个字时不加省略号，免得谎报"后面还有"
  assert.equal(api.clipSelection("好"), "好");
  assert.equal(api.clipSelection("你好世"), "你好世");
  assert.equal(api.clipSelection(""), "");
  assert.equal(api.clipSelection(null), "");

  assert.match(source, /nb-inline-sel/);
  assert.match(styles, /\.nb-inline-sel[\s\S]*background:/);
  assert.match(styles, /html\[data-theme="dark"\]\s+\.nb-inline-sel/);
});
