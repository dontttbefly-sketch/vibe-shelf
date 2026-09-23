function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function markdownToBookHtml(markdown) {
  const lines = String(markdown || "").replaceAll("\r\n", "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let list = [];
  let code = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${paragraph.map(escapeHtml).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    blocks.push(`<ul>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`);
    list = [];
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      flushParagraph();
      flushList();
      if (code === null) code = [];
      else {
        blocks.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = null;
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length + 1;
      blocks.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`);
      continue;
    }
    const item = /^[-*]\s+(.+)$/.exec(line);
    if (item) {
      flushParagraph();
      list.push(item[1]);
      continue;
    }
    flushList();
    paragraph.push(line);
  }

  if (code !== null) blocks.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  flushParagraph();
  flushList();
  return blocks.join("\n");
}

export function createExplorationBookSource({ title, answerMarkdown, sourceRefs = [] }) {
  const refs = sourceRefs
    .map((ref) => `<li><code>${escapeHtml(ref.path)}:${Number(ref.startLine)}-${Number(ref.endLine)}</code></li>`)
    .join("");
  const body = markdownToBookHtml(answerMarkdown);

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
