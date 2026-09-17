# 教学书 HTML 骨架

可直接复制后替换内容。整份文件自包含，无 CDN 依赖，离线可读。

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>《书名》 · 副标题</title>
    <meta name="description" content="一句话说明这本书讲什么。">
    <style>
      /* 把源项目 :root 里的设计令牌原样搬过来，让书和站点是一套配色 */
      :root {
        --ink: #151b1e;
        --muted: #63706e;
        --faint: #8b9694;
        --paper: #fbf7ed;
        --paper-strong: #fffdf7;
        --mist: #e8f0ed;
        --line: rgba(21, 27, 30, 0.14);
        --line-strong: rgba(21, 27, 30, 0.3);
        --accent: #f2553c;   /* 主强调色（进度条 / 目录高亮） */
        --know: #2f7b5f;     /* 知识点卡片 */
        --limit: #f2553c;    /* 局限卡片 */
        --look: #55b8d6;     /* "你看到的"卡片 */
        --code-bar: #8875e6; /* 代码块左侧色条 */
        --radius: 10px;
        --header-h: 58px;
        --toc-w: 252px;
        --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      }

      * { box-sizing: border-box; }

      html { background: var(--paper); scroll-behavior: smooth; }

      body {
        margin: 0;
        color: var(--ink);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
          "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
        font-size: 15px;
        line-height: 1.85;
        -webkit-font-smoothing: antialiased;
      }

      .progress {
        position: fixed; top: 0; left: 0;
        height: 3px; width: 0;
        background: var(--accent); z-index: 50;
        transition: width .1s linear;
      }

      .book-header {
        position: sticky; top: 0; z-index: 40;
        height: var(--header-h);
        display: flex; align-items: center; gap: 14px;
        padding: 0 28px;
        background: rgba(251, 247, 237, .92);
        border-bottom: 1px solid var(--line);
        backdrop-filter: blur(10px);
      }
      .book-header .glyph {
        width: 26px; height: 26px; flex: none;
        border: 1.5px solid var(--ink); border-radius: 50%;
        display: grid; place-items: center;
        font-size: 13px; font-weight: 500;
      }
      .book-header h1 { margin: 0; font-size: 15px; font-weight: 500; }
      .book-header .sub { margin-left: auto; font-size: 12px; color: var(--faint); }

      .book-layout {
        display: flex; align-items: flex-start; gap: 46px;
        max-width: 1200px; margin: 0 auto; padding: 0 28px;
      }

      .book-toc {
        flex: 0 0 var(--toc-w);
        position: sticky; top: calc(var(--header-h) + 26px);
        max-height: calc(100vh - var(--header-h) - 52px);
        overflow-y: auto; padding: 26px 0 40px; font-size: 13px;
      }
      .book-toc .toc-label {
        font-size: 11px; letter-spacing: .1em; text-transform: uppercase;
        color: var(--faint); margin-bottom: 12px;
      }
      .book-toc .toc-part {
        margin: 20px 0 8px; font-size: 11px; letter-spacing: .06em; color: #ce7b51;
      }
      .book-toc a {
        display: block; padding: 5px 10px; border-radius: 6px;
        color: var(--muted); text-decoration: none; line-height: 1.5;
        border-left: 2px solid transparent;
      }
      .book-toc a:hover { background: var(--mist); color: var(--ink); }
      .book-toc a.active {
        color: var(--ink); background: var(--paper-strong);
        border-left-color: var(--accent);
      }
      .book-toc a.todo { color: var(--faint); }
      .book-toc a.todo::after {
        content: "待写"; float: right; font-size: 10px; opacity: .8;
      }

      .book-main { flex: 1; min-width: 0; max-width: 760px; padding: 34px 0 140px; }

      .chapter { margin-bottom: 96px; scroll-margin-top: calc(var(--header-h) + 24px); }
      .chapter .eyebrow {
        font-size: 11px; letter-spacing: .12em; text-transform: uppercase;
        color: #ce7b51; margin-bottom: 10px;
      }
      .chapter h2 { margin: 0 0 6px; font-size: 27px; font-weight: 500; line-height: 1.35; }
      .chapter .lede { margin: 0 0 30px; color: var(--muted); }
      .chapter h3 { margin: 42px 0 14px; font-size: 17px; font-weight: 500; }
      .chapter h3 .num { color: var(--faint); font-family: var(--mono); font-size: 13px; margin-right: 8px; }
      .chapter h4 { margin: 28px 0 8px; font-size: 15px; font-weight: 500; }
      .chapter p { margin: 0 0 15px; }
      .chapter ul, .chapter ol { margin: 0 0 16px; padding-left: 22px; }
      .chapter li { margin-bottom: 7px; }

      p code, li code, td code, th code {
        font-family: var(--mono); font-size: .88em;
        background: rgba(136, 117, 230, .11); color: #534ab7;
        padding: 1.5px 5px; border-radius: 4px;
      }

      pre {
        margin: 18px 0; padding: 16px 18px;
        background: var(--paper-strong);
        border: 1px solid var(--line);
        border-left: 3px solid var(--code-bar);
        border-radius: 8px; overflow-x: auto; line-height: 1.72;
      }
      pre code {
        font-family: var(--mono); font-size: 12.5px;
        background: none; color: var(--ink); padding: 0;
        border-radius: 0; white-space: pre;
      }
      .c-cm { color: #849690; font-style: italic; }
      .c-st { color: #a8471f; }

      table { width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 13.5px; line-height: 1.65; }
      th { text-align: left; padding: 9px 11px; border-bottom: 2px solid var(--line-strong); font-weight: 500; white-space: nowrap; }
      td { padding: 9px 11px; border-bottom: 1px solid var(--line); vertical-align: top; }
      tbody tr:last-child td { border-bottom: none; }

      /* 表格：交给浏览器自动分配列宽。不要用 table-layout: fixed + 百分比列宽 ——
         表格形态一多（2/3/4/6 列混排）就会把某个长列挤成 15%。详见 SKILL.md 配方 3 */
      .kv { font-size: 13.5px; width: 100%; table-layout: auto; }
      .kv th, .kv td { white-space: normal; word-break: break-word; vertical-align: top; padding-right: 10px; }
      .kv th:last-child, .kv td:last-child { padding-right: 0; }
      /* 首列是编号或 2~3 字短标签的表格：加 class="kv numcol"，避免"步骤"被拆成两行 */
      .kv.numcol th:first-child, .kv.numcol td:first-child { white-space: nowrap; word-break: keep-all; }
      /* 单个单元格不想折行：加 class="nowrap" */
      .kv .nowrap { white-space: nowrap; word-break: keep-all; }

      .card {
        margin: 22px 0; padding: 17px 20px;
        background: var(--paper-strong);
        border: 1px solid var(--line);
        border-left: 3px solid var(--faint);
        border-radius: 8px;
      }
      .card > .card-tag { display: block; font-size: 11px; letter-spacing: .09em; margin-bottom: 8px; color: var(--muted); }
      .card.look { border-left-color: var(--look); }
      .card.look > .card-tag { color: #2c7f9c; }
      .card.know { border-left-color: var(--know); }
      .card.know > .card-tag { color: var(--know); }
      .card.limit { border-left-color: var(--limit); }
      .card.limit > .card-tag { color: var(--limit); }
      .card.goal { background: var(--mist); border-left-color: #f6cc3f; }
      .card.goal > .card-tag { color: #8a6d15; }
      .card p:last-child, .card ul:last-child { margin-bottom: 0; }
      .card h4 { margin-top: 0; }

      .callout-num {
        display: inline-grid; place-items: center;
        width: 19px; height: 19px; margin-right: 7px;
        border-radius: 50%; background: var(--ink); color: var(--paper);
        font-size: 11px; font-family: var(--mono); vertical-align: 1px;
      }

      .rule { height: 1px; background: var(--line); margin: 40px 0; border: 0; }

      .book-footer {
        max-width: 1200px; margin: 0 auto; padding: 30px 28px 80px;
        border-top: 1px solid var(--line); font-size: 12.5px; color: var(--faint);
      }

      @media (max-width: 940px) {
        .book-layout { flex-direction: column; gap: 0; padding: 0 20px; }
        .book-toc {
          position: static; flex: none; width: 100%;
          max-height: none; padding: 22px 0 8px;
          border-bottom: 1px solid var(--line);
        }
        .book-main { max-width: none; padding-top: 26px; }
        .chapter h2 { font-size: 23px; }
        .book-header .sub { display: none; }
      }
    </style>
  </head>
  <body>
    <div class="progress" id="progress"></div>

    <header class="book-header">
      <span class="glyph">P</span>
      <h1>《书名》</h1>
      <span class="sub">从页面效果倒推每一行代码 · 共 N 章</span>
    </header>

    <div class="book-layout">
      <nav class="book-toc" id="toc">
        <div class="toc-label">目录</div>
        <a href="#preface">前言 · 怎么读这本书</a>

        <div class="toc-part">第一篇 · 地基</div>
        <a href="#ch1">1 · 章节名</a>
        <!-- 未写的章节保留链接并加 class="todo"，读者能看到全貌 -->
        <a href="#ch2" class="todo">2 · 章节名</a>
      </nav>

      <main class="book-main">
        <section class="chapter" id="preface">
          <div class="eyebrow">前言</div>
          <h2>怎么读这本书</h2>
          <p class="lede">一句话目标。</p>
          <!-- 一、为什么拿这个项目当教材 / 二、项目速览（用 .kv 表格）/ 三、每章固定结构 / 四、提醒 -->
        </section>

        <section class="chapter" id="ch1">
          <div class="eyebrow">第 1 章</div>
          <h2>章节标题</h2>
          <p class="lede">一句话点题。</p>

          <div class="card goal">
            <span class="card-tag">读完这章你会知道</span>
            <p>…</p>
          </div>

          <h3><span class="num">1.1</span>你在浏览器里看到的</h3>
          <p>…</p>

          <h3><span class="num">1.2</span>代码长什么样</h3>
<pre><code>这里放真实源码（HTML 标签必须写成 &amp;lt; &amp;gt;）</code></pre>

          <h3><span class="num">1.3</span>逐块拆解</h3>
          <h4>① 第一块</h4>
          <p>…</p>

          <div class="card know">
            <span class="card-tag">知识点 · 概念名</span>
            <p>…</p>
          </div>

          <div class="card limit">
            <span class="card-tag">局限</span>
            <h4>它在哪会顶不住</h4>
            <p>…</p>
          </div>

          <hr class="rule">

          <h3><span class="num">1.4</span>本章小结</h3>
          <ul><li>…</li></ul>
        </section>
      </main>
    </div>

    <footer class="book-footer">书名 · 教材项目：xxx · 代码引用均来自项目真实源码</footer>

    <script>
      const progress = document.getElementById("progress");
      const onScroll = () => {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        progress.style.width = (max > 0 ? (window.scrollY / max) * 100 : 0) + "%";
      };
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onScroll);
      onScroll();

      const tocLinks = Array.from(document.querySelectorAll(".book-toc a"));
      const chapters = Array.from(document.querySelectorAll(".chapter"));
      const setActive = (id) => {
        tocLinks.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + id));
      };
      const io = new IntersectionObserver(
        (entries) => {
          const visible = entries
            .filter((e) => e.isIntersecting)
            .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
          if (visible[0]) setActive(visible[0].target.id);
        },
        { rootMargin: "-72px 0px -70% 0px", threshold: 0 }
      );
      chapters.forEach((c) => io.observe(c));

      // 轻量高亮：单遍扫描，同时处理注释与字符串（不可拆成两遍！）
      document.querySelectorAll("pre code").forEach((block) => {
        let text = block.textContent
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        text = text.replace(
          /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|&lt;!--[\s\S]*?--&gt;)|("[^"\n]*"|'[^'\n]*')/g,
          (m, c, s) => (s ? '<span class="c-st">' + s + "</span>" : '<span class="c-cm">' + m + "</span>")
        );
        block.innerHTML = text;
      });
    </script>
  </body>
</html>
```
