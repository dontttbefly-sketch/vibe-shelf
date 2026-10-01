import fs from "node:fs";
import path from "node:path";
import { anchorCodeBlocks } from "./source-link.mjs";

function extractStyle(html) {
  const match = html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i);
  if (!match) throw new Error("找不到 <style>");
  return match[1];
}

function extractBody(html) {
  const progress = /<div\b[^>]*\bclass=(['"])[^'"]*\bprogress\b[^'"]*\1[^>]*>/i.exec(html);
  if (!progress || progress.index === undefined) {
    throw new Error('书页结构不完整：找不到 <div class="progress">（阅读进度条）。多半是模型输出被截断或跑题了，重新生成一次');
  }

  const scriptOffset = html.slice(progress.index).search(/<script\b/i);
  if (scriptOffset < 0) {
    throw new Error('书页结构不完整：<div class="progress"> 之后找不到 <script>。多半是模型输出被截断或跑题了，重新生成一次');
  }

  return html.slice(progress.index, progress.index + scriptOffset).trimEnd();
}

function extractOriginalScript(html) {
  const progress = /<div\b[^>]*\bclass=(['"])[^'"]*\bprogress\b[^'"]*\1[^>]*>/i.exec(html);
  if (!progress || progress.index === undefined) throw new Error("找不到原书 <script>");

  const afterProgress = html.slice(progress.index);
  const match = afterProgress.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error("找不到原书 <script>");
  return match[1].trim();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// 内联进 <script> 的 JSON：把 < 转义掉，否则书名里一个 </script> 就能提前闭合脚本标签
function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function enrichPreBlocks(html) {
  return html.replace(/<pre>(\s*<code[^>]*>)([\s\S]*?)(<\/code>\s*<\/pre>)/g, (full, open, code, close) => {
    const decoded = code
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&")
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'");
    const lines = decoded.split("\n");
    const head = lines.slice(0, 3).join("\n");
    const first = (lines[0] || "").trim();
    let file = null;

    if (/^<!doctype\s+html/i.test(first) || /^<html/i.test(first)) file = "index.html";
    else if (/^<link\s+/i.test(first) || /^<script/i.test(first)) file = "index.html";
    else if (/:root\s*\{/.test(head) || /^\/\*[\s\S]*?\*\//.test(head)) file = "assets/styles.css";

    if (!file) return full;
    return `<pre data-file="${file}" dropzone="file">${open}${code}${close}`;
  });
}

function assetPrefix(outDir, publicDir) {
  return path.relative(outDir, publicDir).split(path.sep).join("/") || ".";
}

export function validateBookSource(sourceHtml) {
  if (typeof sourceHtml !== "string") throw new Error("书页 HTML 必须是文本");
  return {
    style: extractStyle(sourceHtml),
    body: extractBody(sourceHtml),
    originalScript: extractOriginalScript(sourceHtml),
  };
}

export function compileBook({ sourceHtml, title, runtimeContext = {}, outFile, publicDir, staticNotesFile = null, sourceFiles = null }) {
  if (!outFile || !publicDir) throw new Error("缺少书页输出路径");

  const source = validateBookSource(sourceHtml);
  const outDir = path.dirname(outFile);
  const prefix = assetPrefix(outDir, publicDir);
  // 先按内容把"逐字摘自源码"的代码块锚定到真实文件+行号（模型的自述不可信），
  // 剩下没有 data-file 的交给 enrichPreBlocks 的启发式兜底
  let body = source.body;
  let sourceLinkStats = null;
  if (Array.isArray(sourceFiles) && sourceFiles.length) {
    const anchored = anchorCodeBlocks(body, sourceFiles);
    body = anchored.html;
    sourceLinkStats = anchored.stats;
    console.log(`[source-link] 代码块锚定 ${anchored.stats.anchored}/${anchored.stats.blocks}（歧义放弃 ${anchored.stats.ambiguous}）`);
  }
  const bodyContent = enrichPreBlocks(body);
  const originalScript = source.originalScript;
  const context = {
    projectId: null,
    bookId: "default",
    sourceSnapshotId: null,
    kind: "main",
    staticNotesUrl: "data/notes.json",
    ...runtimeContext,
  };
  const readerTopbar = context.projectId
    ? `<header class="shelf-topbar" data-shelf-reader-topbar aria-label="书架导航"><a data-shelf-back href="${prefix}/index.html#bookshelf" aria-label="返回书架"><span aria-hidden="true">←</span><span>书架</span></a><span data-shelf-book-title>${escapeHtml(title)}</span></header>`
    : "";
  const output = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="${prefix}/favicon.ico" sizes="32x32">
<link rel="icon" href="${prefix}/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="${prefix}/apple-touch-icon.png">
<script src="${prefix}/theme.js"></script>
<style>${source.style}</style>
<link rel="stylesheet" href="${prefix}/notes.css">
<link rel="stylesheet" href="${prefix}/explore.css">
</head>
<body data-shelf-reader>
${readerTopbar}
${bodyContent}
<section data-shelf-explore></section>
<script>${originalScript}</script>
<script>window.SHELF_CONTEXT = ${jsonForScript(context)}; window.SHELF_BOOK = ${jsonForScript(context.bookId)};</script>
<script src="${prefix}/reader-core.js"></script>
<script src="${prefix}/notes.js"></script>
<script src="${prefix}/explore.js"></script>
</body>
</html>
`;

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, output, "utf8");

  if (staticNotesFile && fs.existsSync(staticNotesFile)) {
    const staticDir = path.join(outDir, "data");
    fs.mkdirSync(staticDir, { recursive: true });
    fs.copyFileSync(staticNotesFile, path.join(staticDir, path.basename(context.staticNotesUrl)));
  }

  return { outFile, output, sourceLinkStats };
}
