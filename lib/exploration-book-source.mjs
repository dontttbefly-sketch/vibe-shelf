import readerCore from "../public/reader-core.js";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function createExplorationBookSource({ title, answerMarkdown, sourceRefs = [] }) {
  const refs = sourceRefs
    .map((ref) => `<li><code>${escapeHtml(ref.path)}:${Number(ref.startLine)}-${Number(ref.endLine)}</code></li>`)
    .join("");
  const body = readerCore.renderMarkdown(answerMarkdown);

  return `<!doctype html>
<html lang="zh-CN">
<head>
<style>
:root{--ink:#151b1e;--paper:#fffdf7;--clay:#ce7b51}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.8 system-ui}
.book-main{max-width:760px;margin:0 auto;padding:64px 24px}.chapter{scroll-margin-top:24px}
.source-refs{color:#68645e;font-size:13px}
</style>
</head>
<body>
<div class="progress"></div>
<main class="book-main"><section class="chapter" id="ch-1"><h2>${escapeHtml(title)}</h2>${body}<h3>这次探索依据</h3><ul class="source-refs">${refs}</ul></section></main>
<script>window.addEventListener("scroll", function () { const p=document.querySelector(".progress"); if (p) p.style.transform="scaleX(" + (window.scrollY / Math.max(1, document.documentElement.scrollHeight-window.innerHeight)) + ")"; });</script>
</body>
</html>`;
}
