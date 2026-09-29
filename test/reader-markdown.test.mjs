import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createExplorationBookSource } from '../lib/exploration-book-source.mjs';
const require = createRequire(import.meta.url);
const core = require('../public/reader-core.js');
const actualAnswer = "直接回答：`greet('')` 返回 `'Hello'`。\n\n- `src/main.js` 第 2–4 行：\n  ```javascript\n  const title = 'Hello';\n  const message = title + name;\n  return message;\n  ```\n  当 `name` 为空字符串时，结果是 `Hello`。\n\n## 边界\n源码没有参数校验。";
test('actual model answer keeps its indented fenced code and following prose separate', () => {
  const html = core.renderMarkdown(actualAnswer);
  assert.match(html, /<li>[\s\S]*<pre><code class="lang-javascript">const title = 'Hello';\nconst message = title \+ name;\nreturn message;<\/code><\/pre>/);
  assert.match(html, /<\/pre>\s*<p>当 <code>name<\/code>/);
  assert.match(html, /<h3>边界<\/h3>/);
  assert.doesNotMatch(html, /```|`javascript/);
});
test('growing the same answer into a book preserves its displayed structure', () => {
  const html = createExplorationBookSource({ title: '空参数返回什么', answerMarkdown: actualAnswer });
  assert.ok(html.includes(core.renderMarkdown(actualAnswer)));
  assert.match(html, /<code>greet\(''\)<\/code>/);
});
test('adjacent paragraphs, lists, nested lists, tables and quoted blocks keep their boundaries', () => {
  const html = core.renderMarkdown('介绍\n## 接口\n- 第一项\n  - 子项\n- 第二项\n\n| 参数 | 类型 |\n| --- | --- |\n| name | `string` |\n\n> 一点说明\n> 下一行\n\n~~~js\nconst value = "```";\n~~~');
  assert.match(html, /<p>介绍<\/p>\s*<h3>接口/);
  assert.match(html, /<li>第一项\s*<ul><li>子项<\/li><\/ul><\/li>/);
  assert.match(html, /<td><code>string<\/code><\/td>/);
  assert.match(html, /<blockquote><p>一点说明 下一行<\/p><\/blockquote>/);
  assert.match(html, /<pre><code class="lang-js">const value = "```";<\/code><\/pre>/);
});
test('model text cannot turn language names or markdown links into executable markup', () => {
  const html = core.renderMarkdown('```js" onmouseover="bad()\n<img src=x onerror=bad()>\n```\n\n[运行](javascript:bad()) [链接](https://example.test/?q="bad")\n\n**重点**与`a < b`');
  assert.doesNotMatch(html, /<img|href="javascript:| onmouseover=/);
  assert.match(html, /&lt;img/);
  assert.match(html, /href="https:\/\/example.test\/\?q=&quot;bad&quot;"/);
  assert.match(html, /<strong>重点<\/strong>/);
  assert.match(html, /<code>a &lt; b<\/code>/);
  assert.match(core.markdownInline('[`source.js`](https://example.test/source)'), /<a [^>]+><code>source\.js<\/code><\/a>/);
});
