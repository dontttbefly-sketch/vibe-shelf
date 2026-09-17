// 构建脚本：把一本教学书 HTML 装进知识书架
// 提取书的 CSS + 正文 + 脚本，叠加旁注层，生成 public/index.html
// 不改动源书文件，源书只作只读输入。
//
// 用法：
//   node build.mjs <书HTML路径> [--out public/index.html] [--book <书名>] [--title <标题>]
//   --book 决定注释存到 data/<书名>.json（默认 default）
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith("--"));
if (!src) {
  console.error("用法: node build.mjs <书HTML路径> [--out public/index.html] [--book pupkit] [--title 书名]");
  process.exit(1);
}
function opt(name, def) {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
}
const OUT = path.resolve(opt("out", "public/index.html"));
const BOOK_KEY = opt("book", "default");
const TITLE = opt("title", "知识书架");

const html = fs.readFileSync(path.resolve(src), "utf8");

// 1. CSS
const styleM = html.match(/<style>([\s\S]*?)<\/style>/);
if (!styleM) throw new Error("找不到 <style>");
const bookCss = styleM[1];

// 2. body 内容（progress 到 footer 结束，去掉原 <script>）
const bodyStart = html.indexOf('<div class="progress"');
const scriptStart = html.indexOf("<script>");
if (bodyStart < 0 || scriptStart < 0 || scriptStart <= bodyStart) {
  throw new Error('定位 body 失败：书页需要包含 <div class="progress">（阅读进度条）和 <script>');
}
const bodyContent = enrichPreBlocks(html.slice(bodyStart, scriptStart)).replace(/\s+$/, "");

// 3. 原书脚本（进度条 / 目录高亮 / 语法高亮）
const scriptM = html.slice(scriptStart).match(/<script>([\s\S]*?)<\/script>/);
if (!scriptM) throw new Error("找不到原书 <script>");
const origJs = scriptM[1].trim();

// 给书里的 <pre> 块智能推断"对应哪个文件"：识别后加 data-file + dropzone 属性
// 旁注层 detectFiles() 会沿 DOM 向上找 data-file，找到即作为当前文件上下文
// 这样选中代码块时，AI 能自动拿到对应文件的完整内容
function enrichPreBlocks(s) {
  return s.replace(/<pre>(\s*<code[^>]*>)([\s\S]*?)(<\/code>\s*<\/pre>)/g, function (full, open, code, close) {
    const decoded = code
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    const lines = decoded.split("\n");
    const head = lines.slice(0, 3).join("\n");
    const first = lines[0].trim();
    let file = null;
    if (/^<!doctype\s+html/i.test(first) || /^<html/i.test(first)) file = "index.html";
    else if (/^<link\s+/i.test(first)) file = "index.html"; // <link rel="stylesheet" href="assets/styles.css?...">
    else if (/^<script/i.test(first)) file = "index.html";
    else if (/:root\s*\{/.test(head) || /^\/\*[\s\S]*?\*\//.test(head)) file = "assets/styles.css";
    if (!file) return full;
    return '<pre data-file="' + file + '" dropzone="file">' + open + code + close;
  });
}

const out = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE}</title>
<style>
${bookCss}
</style>
<link rel="stylesheet" href="notes.css">
</head>
<body>
${bodyContent}

<script>
${origJs}
</script>
<script>window.SHELF_BOOK = ${JSON.stringify(BOOK_KEY)};</script>
<script src="notes.js"></script>
</body>
</html>
`;

fs.writeFileSync(OUT, out);
// 同步示例注释：静态部署（GitHub Pages）时旁注层首次访问可读取
const noteSrc = path.join(process.cwd(), "data", BOOK_KEY + ".json");
if (fs.existsSync(noteSrc)) {
  const noteDst = path.join(path.dirname(OUT), "data");
  fs.mkdirSync(noteDst, { recursive: true });
  fs.copyFileSync(noteSrc, path.join(noteDst, BOOK_KEY + ".json"));
  console.log("  示例注释已同步 → " + path.join(path.dirname(OUT), "data", BOOK_KEY + ".json"));
}
console.log("已生成 " + OUT);
console.log("  书名(注释文件): data/" + BOOK_KEY + ".json");
console.log("  体积 " + (Buffer.byteLength(out) / 1024).toFixed(1) + " KB");
console.log("  CSS " + bookCss.length + " 字符 · 正文块 " + bodyContent.length + " 字符 · 原脚本 " + origJs.length + " 字符");
