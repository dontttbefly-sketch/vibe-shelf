import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("source drawer docks beside the article on wide screens", () => {
  const styles = fs.readFileSync("public/notes.css", "utf8");
  // 泊位：正文让位重排，不遮内容；窄屏退回覆盖式
  assert.match(styles, /@media \(min-width: 1081px\)[\s\S]*?nb-source-open \{ padding-right/);
  assert.match(styles, /@media \(min-width: 1081px\)[\s\S]*?\.nb-source-drawer \{ width: min\(680px, 46vw\)/);
  // 顶栏同步让位，控件不被抽屉盖住
  assert.match(styles, /nb-source-open \[data-shelf-reader-topbar\] \{ padding-right/);
});

test("source drawer animates with composite-only properties", () => {
  const styles = fs.readFileSync("public/notes.css", "utf8");
  const drawer = styles.match(/^\.nb-source-drawer \{[\s\S]*?\n\}/m)[0];
  assert.match(drawer, /transform: translateX/);
  assert.match(drawer, /transition:[\s\S]*?transform/);
  assert.match(styles, /\.nb-source-drawer\.nb-show \{ opacity: 1; transform: none; \}/);
});

test("source drawer links back to the chapters that cite it", () => {
  const js = fs.readFileSync("public/notes.js", "utf8");
  const styles = fs.readFileSync("public/notes.css", "utf8");
  assert.match(js, /buildSourceBackIndex/);
  assert.match(js, /renderSourceBack/);
  assert.match(js, /nb-back-chip/);
  assert.match(js, /data-back-chapter/);
  assert.match(js, /matchSourcePath/);
  // 窄屏覆盖式跳回正文前先收抽屉；宽屏泊位式保留同屏
  assert.match(js, /matchMedia\("\(min-width: 1081px\)"\)/);
  assert.match(styles, /\.nb-source-back\[hidden\] \{ display: none; \}/);
});

test("hover preview of source refs is a passive card", () => {
  const js = fs.readFileSync("public/notes.js", "utf8");
  const styles = fs.readFileSync("public/notes.css", "utf8");
  assert.match(js, /setupSourcePreview/);
  assert.match(js, /nb-src-preview/);
  // 抽屉已开（泊位同屏）时不再弹速览
  assert.match(js, /drawerOpen\(\)/);
  assert.match(styles, /\.nb-src-preview \{[\s\S]*?pointer-events: none/);
  // 速览复用抽屉的行渲染（行号 + 目标行高亮）
  assert.match(js, /nb-src-line-active/);
});
