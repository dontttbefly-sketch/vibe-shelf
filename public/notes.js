/* 知识书架 · 旁注层逻辑（叠加在原书脚本之上，不改变原书正文结构） */
(function () {
  "use strict";
  var main = document.querySelector(".book-main");
  if (!main) return;

  var BOOK = window.SHELF_BOOK || "default"; // 由 build.mjs 注入；书名决定注释存到 data/<书名>.json
  var STATIC_MODE = false; // GitHub Pages 等纯静态部署：阅读+本地批注可用，AI 生成不可用
  var notes = [];
  var blocks = [];
  var anchorMap = [];
  var activeId = null;
  var pending = null;   // { section, sectionTitle, blockText, quote }
  var thinkTimer = null;
  var closeTimer = null;
  var explainSeq = 0;
  // ---- 文件上下文（追问时勾选注入 prompt） ----
  var bookFiles = null;          // { path, size }[] 全本书候选（懒加载，供 size 查询）
  var fileContents = Object.create(null); // path -> { path, content, tooLarge? } 已读取缓存
  var pendingCandidates = [];    // 本次提问相关的候选文件（选中文字/代码块命中）
  var pendingFiles = [];         // path[] 用户实际勾选的文件
  var explainCtrl = null;
  var resultState = null;        // 当前结果视图 { existingId, question, body, editing, promoted, quote, sectionTitle }
  var resultReachedBottom = false;
  var subchip = null;
  var subchipRange = null;
  // "追问这段"chip 跟随文字：滚动时按活 range 重算（末行末字右缘下方）
  function positionSubchip() {
    if (!subchip || !subchipRange) return;
    try {
      var rs = subchipRange.getClientRects();
      var lr = rs[rs.length - 1];
      if (!lr || lr.height === 0) return;
      var w = subchip.offsetWidth || 90;
      subchip.style.left = Math.max(12, Math.min(lr.right - w / 2, window.innerWidth - w - 12)) + "px";
      subchip.style.top = Math.min(lr.bottom + 6, window.innerHeight - 40) + "px";
    } catch (e) {}
  }
  var viewToken = 0;             // 视图切换 token，防过期的 loading 过渡覆盖新内容

  // ================= Markdown 渲染器（旁注专用，精简） =================
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function mdInline(s) {
    var keep = [], P = "\u0001";
    function mark(t, v) { keep.push({ t: t, v: v }); return P + (keep.length - 1) + P; }
    s = s.replace(/``\s?([\s\S]*?)\s?``|`([^`]*)`/g, function (m, a, b) { return mark("code", a !== undefined ? a : b); });
    s = esc(s);
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    s = s.replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*\*/g, ""); // 容错：清掉 AI 偶发的不成对双星号（如“**网页的导演。”）
    s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    s = s.replace(new RegExp(P + "(\\d+)" + P, "g"), function (m, i) { var k = keep[+i]; return "<code>" + esc(k.v) + "</code>"; });
    return s;
  }
  function splitRow(line) {
    var inner = line.trim();
    if (inner.charAt(0) === "|") inner = inner.slice(1);
    if (inner.charAt(inner.length - 1) === "|") inner = inner.slice(0, -1);
    var cells = [], cur = "", i = 0;
    while (i < inner.length) {
      var ch = inner.charAt(i);
      if (ch === "\\" && inner.charAt(i + 1) === "|") { cur += "|"; i += 2; continue; }
      if (ch === "|") { cells.push(cur.trim()); cur = ""; i++; continue; }
      cur += ch; i++;
    }
    cells.push(cur.trim());
    return cells;
  }
  function renderMarkdown(md) {
    var lines = md.replace(/\r/g, "").split("\n");
    var out = [], i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (/^```/.test(line)) {
        var lang = line.slice(3).trim();
        var buf = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push('<pre><code class="lang-' + lang + '">' + esc(buf.join("\n")) + "</code></pre>");
        continue;
      }
      if (/^####\s/.test(line)) { out.push("<h4>" + mdInline(line.slice(5)) + "</h4>"); i++; continue; }
      if (/^###\s/.test(line)) { out.push("<h3>" + mdInline(line.slice(4)) + "</h3>"); i++; continue; }
      if (/^##\s/.test(line)) { out.push("<h3>" + mdInline(line.slice(3)) + "</h3>"); i++; continue; }
      if (/^>\s?/.test(line)) { out.push("<blockquote>" + mdInline(line.replace(/^>\s?/, "")) + "</blockquote>"); i++; continue; }
      if (/^\|/.test(line)) {
        var rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
        var head = splitRow(rows[0]);
        var body = rows.slice(2).map(splitRow);
        out.push("<table><thead><tr>" + head.map(function (h) { return "<th>" + mdInline(h) + "</th>"; }).join("") +
          "</tr></thead><tbody>" + body.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + mdInline(c) + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody></table>");
        continue;
      }
      if (/^[-*]\s/.test(line)) {
        var items = [];
        while (i < lines.length && /^[-*]\s/.test(lines[i])) { items.push(lines[i].replace(/^[-*]\s/, "")); i++; }
        out.push("<ul>" + items.map(function (x) { return "<li>" + mdInline(x) + "</li>"; }).join("") + "</ul>");
        continue;
      }
      if (/^\d+\.\s/.test(line)) {
        var oi = [];
        while (i < lines.length && /^\d+\.\s/.test(lines[i])) { oi.push(lines[i].replace(/^\d+\.\s/, "")); i++; }
        out.push("<ol>" + oi.map(function (x) { return "<li>" + mdInline(x) + "</li>"; }).join("") + "</ol>");
        continue;
      }
      if (line.trim() === "") { i++; continue; }
      var para = [];
      while (i < lines.length && lines[i].trim() !== "" && !/^(#{2,4}\s|```|\||[-*]\s|\d+\.\s|>) /.test(lines[i])) { para.push(lines[i]); i++; }
      if (para.length) out.push("<p>" + mdInline(para.join(" ")) + "</p>");
      else i++;
    }
    return out.join("\n");
  }

  // ================= 工具 =================
  function norm(s) { return (s || "").replace(/\s+/g, " ").trim(); }
  function esc2(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function cut(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + "…" : s; }
  function sectionTitle(el) {
    var ch = el.closest(".chapter");
    if (!ch) return "";
    var h2 = ch.querySelector("h2");
    return h2 ? h2.textContent.trim() : "";
  }
  function toast(msg) {
    var old = document.querySelector(".nb-toast");
    if (old) old.remove();
    var d = document.createElement("div");
    d.className = "nb-toast";
    d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(function () { d.style.opacity = "0"; }, 2200);
    setTimeout(function () { d.remove(); }, 2500);
  }
  function today() { return Math.floor(Date.now() / 1000); }

  // ================= 锚定与标记 =================
  var BLOCK_SEL = ".chapter p, .chapter li, .chapter h3, .chapter h4, .chapter td, .chapter th, .chapter pre";
  function collectBlocks() {
    blocks = Array.from(main.querySelectorAll(BLOCK_SEL)).filter(function (b) {
      return !b.closest(".nb-promoted") && norm(b.textContent).length >= 2;
    });
  }
  function findBlock(note) {
    var t = norm(note.blockText);
    var scope = blocks;
    if (note.section) {
      var sec = main.querySelector('.chapter[id="' + note.section + '"]');
      if (sec) scope = blocks.filter(function (b) { return sec.contains(b); });
    }
    var hit = scope.find(function (b) { return norm(b.textContent) === t; });
    if (hit) return hit;
    hit = scope.find(function (b) { var bt = norm(b.textContent); return bt.indexOf(t) >= 0 || t.indexOf(bt) >= 0; });
    if (hit) return hit;
    hit = blocks.find(function (b) { return norm(b.textContent) === t; });
    if (hit) return hit;
    return blocks.find(function (b) { var bt = norm(b.textContent); return bt.indexOf(t) >= 0 || t.indexOf(bt) >= 0; }) || null;
  }

  // ---- 文件上下文：检测/加载/读取/渲染 ----
  function detectFiles(host) {
    // 沿 DOM 向上找带 data-file 的祖先；只取第一个（最近的）
    var cur = host;
    while (cur && cur !== main && cur !== document.body) {
      if (cur.getAttribute && cur.getAttribute("data-file")) {
        return [cur.getAttribute("data-file")];
      }
      cur = cur.parentElement;
    }
    return [];
  }
  // 文本匹配：选中/所在块文字里出现了文件名（如 index.html、styles.css）→ 视为要喂的文件
  function matchFilesByText(text) {
    if (!bookFiles || !bookFiles.length || !text) return [];
    var hits = [];
    for (var i = 0; i < bookFiles.length; i++) {
      var p = bookFiles[i].path;
      var base = p.split("/").pop(); // assets/styles.css → styles.css
      if (text.indexOf(p) >= 0 || text.indexOf(base) >= 0) {
        if (hits.indexOf(p) < 0) hits.push(p);
      }
    }
    return hits;
  }
  async function loadBookFiles(force) {
    if (!force && bookFiles) return bookFiles;
    try {
      var r = await fetch("/api/files?book=" + encodeURIComponent(BOOK));
      var d = await r.json();
      bookFiles = d.files || [];
    } catch (e) { bookFiles = []; }
    return bookFiles;
  }
  async function readFiles(paths) {
    var out = [];
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      if (fileContents[p]) { out.push(fileContents[p]); continue; }
      try {
        var r = await fetch("/api/file?book=" + encodeURIComponent(BOOK) + "&path=" + encodeURIComponent(p));
        if (!r.ok) continue;
        var d = await r.json();
        fileContents[p] = d;
        out.push(d);
      } catch (e) {}
    }
    return out;
  }
  // 文件勾选直接平铺在一级界面（解释按钮下方），默认全勾，无常驻 chip、无展开收起
  function renderFilesList() {
    var m = pendingCandidates.length;
    if (!m) return "";
    var html = '<div class="nb-files-list">';
    for (var i = 0; i < m; i++) {
      var p = pendingCandidates[i];
      var checked = pendingFiles.indexOf(p) >= 0 ? " checked" : "";
      var sz = "";
      if (bookFiles) {
        for (var k = 0; k < bookFiles.length; k++) {
          if (bookFiles[k].path === p) {
            sz = bookFiles[k].size < 1024 ? bookFiles[k].size + " B" : (bookFiles[k].size / 1024).toFixed(1) + " KB";
            break;
          }
        }
      }
      html += '<label class="nb-file-row">' +
        '<input type="checkbox" data-file-path="' + esc2(p) + '"' + checked + '>' +
        '<span class="nb-file-name">' + esc2(p) + '</span>' +
        (sz ? '<span class="nb-file-size">' + sz + '</span>' : '') +
        '</label>';
    }
    html += '</div>';
    return html;
  }
  function bindFilesList() {
    bubbleBody.querySelectorAll('.nb-files-list input[type="checkbox"]').forEach(function (cb) {
      cb.addEventListener("change", function () {
        var p = cb.getAttribute("data-file-path");
        var idx = pendingFiles.indexOf(p);
        if (cb.checked && idx < 0) pendingFiles.push(p);
        else if (!cb.checked && idx >= 0) pendingFiles.splice(idx, 1);
      });
    });
  }
  function markQuote(block, quote, id) {
    if (!quote) return;
    var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      var idx = node.nodeValue.indexOf(quote);
      if (idx < 0) continue;
      var range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + quote.length);
      var m = document.createElement("mark");
      m.className = "nb-quote";
      m.setAttribute("data-note", id);
      try { range.surroundContents(m); } catch (e) { return; }
      return;
    }
  }
  function unmarkQuote(id) {
    main.querySelectorAll('mark.nb-quote[data-note="' + id + '"]').forEach(function (m) {
      m.replaceWith(document.createTextNode(m.textContent));
    });
  }
  function clearPromoted(id) {
    main.querySelectorAll('.nb-promoted[data-note="' + id + '"]').forEach(function (d) { d.remove(); });
  }
  var TRASH_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>';
  var BOOKMARK_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>';
  var BOOKMARK_SVG_FILLED = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>';
  var EXPAND_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>';
  var PEN_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>';
  var COLLAPSE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="10" y1="14" x2="3" y2="21"></line></svg>';
  function renderPromoted(note) {
    clearPromoted(note.id);
    if (!note.promoted || !note.body) return;
    var block = findBlock(note);
    if (!block) return;
    var d = document.createElement("div");
    d.className = "nb-promoted";
    d.setAttribute("data-note", note.id);
    d.innerHTML =
      '<div class="nb-promoted-head"><span class="nb-promoted-tag">补充</span>' +
      '<span class="nb-promoted-actions">' +
      '<button class="nb-promoted-del" type="button" title="从正文移除">' + TRASH_SVG + "</button>" +
      '<button class="nb-promoted-toggle" type="button">展开</button>' +
      "</span></div>" +
      '<div class="nb-promoted-body"><div class="nb-note-body">' + renderMarkdown(note.body) + "</div></div>";
    var body = d.querySelector(".nb-promoted-body");
    var toggle = d.querySelector(".nb-promoted-toggle");
    d.querySelector(".nb-promoted-head").addEventListener("click", function (e) {
      if (e.target.closest(".nb-promoted-del")) return; // 点垃圾桶不触发展开
      clearTimeout(d.__collapseTimer);
      if (d.classList.contains("open")) {
        // 收起：先锁住当前真实高度，再归零（否则 max-height 会从 none/大值直接跳变）
        body.style.maxHeight = body.scrollHeight + "px";
        void body.offsetWidth;
        d.classList.remove("open");
        body.style.maxHeight = "0px";
        toggle.textContent = "展开";
      } else {
        d.classList.add("open"); // padding/透明度/位移先到位，scrollHeight 随之含 padding-bottom
        body.style.maxHeight = body.scrollHeight + "px";
        toggle.textContent = "收起";
        // 过渡结束后放开上限，内容再长也不会被截断
        d.__collapseTimer = setTimeout(function () { body.style.maxHeight = "none"; }, 360);
      }
    });
    d.querySelector(".nb-promoted-del").addEventListener("click", function (e) {
      e.stopPropagation();
      if (d.classList.contains("nb-removing")) return;
      // 塌缩承接：整卡锁高→合拢，内容同步淡出，下方正文平滑补位（无 blur，不吃性能）
      d.style.maxHeight = d.offsetHeight + "px";
      void d.offsetWidth;
      d.classList.add("nb-removing");
      setTimeout(function () {
        var id = note.id;
        clearPromoted(id);
        var n = notes.find(function (x) { return x.id === id; });
        if (n) { n.promoted = false; persist(n); }
        toast("已从正文移除，注释仍保留");
      }, 360);
    });
    block.insertAdjacentElement("afterend", d);
  }
  function clearMarkers(id) {
    var b = main.querySelector('.nb-block[data-note="' + id + '"]');
    if (b) { b.classList.remove("nb-block", "nb-active"); b.removeAttribute("data-note"); }
    unmarkQuote(id);
    clearPromoted(id);
  }

  function refreshAll() {
    collectBlocks();
    main.querySelectorAll(".nb-block").forEach(function (b) { b.classList.remove("nb-block", "nb-active"); b.removeAttribute("data-note"); });
    main.querySelectorAll("mark.nb-quote").forEach(function (m) { m.replaceWith(document.createTextNode(m.textContent)); });
    main.querySelectorAll(".nb-promoted").forEach(function (d) { d.remove(); });
    anchorMap = [];
    notes.forEach(function (note) {
      var block = findBlock(note);
      if (!block) return;
      block.classList.add("nb-block");
      block.setAttribute("data-note", note.id);
      markQuote(block, note.quote, note.id);
      if (note.promoted) renderPromoted(note);
      anchorMap.push({ el: block, note: note });
    });
    anchorMap.sort(function (a, b) { return (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1; });
    updateNav();
  }
  function activeIdx() {
    var i = anchorMap.findIndex(function (x) { return x.note.id === activeId; });
    return i < 0 ? 0 : i;
  }
  function updateNav() {
    var nav = document.getElementById("nbNav");
    if (!nav) return;
    if (anchorMap.length === 0) { nav.hidden = true; return; }
    nav.hidden = false;
    var c = document.getElementById("nbCount");
    if (c) c.textContent = (activeIdx() + 1) + " / " + anchorMap.length;
  }
  function setActive(id) {
    activeId = id;
    main.querySelectorAll(".nb-active").forEach(function (el) { el.classList.remove("nb-active"); });
    main.querySelectorAll("mark.nb-quote.nb-active").forEach(function (m) { m.classList.remove("nb-active"); });
    if (!id) { updateNav(); return; }
    var b = main.querySelector('.nb-block[data-note="' + id + '"]');
    if (b) b.classList.add("nb-active");
    main.querySelectorAll('mark.nb-quote[data-note="' + id + '"]').forEach(function (m) { m.classList.add("nb-active"); });
    updateNav();
  }

  // ================= 气泡 =================
  var bubble, bubbleBody, bubbleTitle;
  function buildBubble() {
    bubble = document.createElement("div");
    bubble.className = "nb-bubble";
    bubble.innerHTML =
      '<div class="nb-bubble-head"><p class="nb-bubble-title" id="nbTitle"></p>' +
      '<button class="nb-pen" id="nbPen" title="修改" hidden>' + PEN_SVG + "</button>" +
      '<button class="nb-expand" id="nbExpand" title="放大查看" aria-label="放大">' + EXPAND_SVG + "</button>" +
      '<button class="nb-close" id="nbClose">×</button></div>' +
      '<div class="nb-bubble-body" id="nbBody"></div>';
    document.body.appendChild(bubble);
    bubbleBody = bubble.querySelector("#nbBody");
    bubbleTitle = bubble.querySelector("#nbTitle");
    bubble.querySelector("#nbClose").addEventListener("click", closeBubble);
    bubble.querySelector("#nbPen").addEventListener("click", function () { toggleEdit(); });
    bubble.querySelector("#nbExpand").addEventListener("click", function () { toggleExpand(); });
    // 双击标题栏空白或标题文字：放大/缩小切换（双击按钮除外）
    bubble.querySelector(".nb-bubble-head").addEventListener("dblclick", function (e) {
      if (e.target.closest("button")) return;
      toggleExpand();
    });
    bubbleBody.addEventListener("scroll", function () {
      if (bubbleAtBottom()) resultReachedBottom = true;
      positionAskPop(); // 追问气泡跟随文字滚动
      positionSubchip(); // "追问这段"跟随文字滚动
    });
    bubbleBody.addEventListener("mouseup", handleNoteMouseup);
    document.addEventListener("mousedown", function (e) {
      if (subchip && !subchip.contains(e.target)) hideSubchip();
    });
    // 正文页面滚动时，"＋补注释"浮窗跟随选段文字
    window.addEventListener("scroll", function () {
      if (floatBtn) positionFloat(window.getSelection());
    }, { passive: true });
    // 隐形快捷键：划词后按 Enter 直接唤出聊天框（无 UI 提示）
    // 气泡内划词 → 追问小气泡；正文划词 → 补注释提问框
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      var t = e.target;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) return;
      if (isDiffMode() || isAskPopOpen()) return;
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      var text = sel.toString().trim();
      if (!text || text.length > 300) return;
      var node = sel.anchorNode;
      var el = node && (node.nodeType === 3 ? node.parentElement : node);
      if (!el) return;
      if (bubbleBody.contains(el)) {
        if (!resultState || el.closest("#nbEdit")) return;
        e.preventDefault();
        openAskPop("edit", text, mouseAnchor(), "");
        hideSubchip();
      } else if (main.contains(el) && !el.closest(".nb-promoted")) {
        e.preventDefault();
        hideFloat();
        var host = el.closest(BLOCK_SEL);
        if (!host) return;
        pending = {
          section: (host.closest(".chapter") || {}).id || "",
          sectionTitle: sectionTitle(host),
          blockText: norm(host.textContent),
          quote: text,
          files: detectFiles(host),
        };
        viewAsk();
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (isAskPopOpen()) { closeAskPop(); return; }
        if (isExpanded()) { toggleExpand(); return; }
        closeBubble();
      }
    });
  }
  function openBubble(titleHtml, fromEl) {
    if (!bubble) buildBubble();
    clearTimeout(closeTimer); closeTimer = null;
    setPenVisible(false);
    bubbleTitle.innerHTML = titleHtml;
    bubble.classList.add("nb-show");
    bubble.style.transition = "none";
    bubble.style.transform = "translate(0,0) scale(1)";
    bubble.style.opacity = "";
    bubble.getBoundingClientRect();
    var target = bubble.getBoundingClientRect();
    var dx = 0, dy = 40, s = 0.92;
    if (fromEl) {
      var f = fromEl.getBoundingClientRect();
      dx = (f.left + f.width / 2) - (target.left + target.width / 2);
      dy = (f.top + f.height / 2) - (target.top + target.height / 2);
      s = 0.4;
    }
    bubble.style.transform = "translate(" + dx + "px," + dy + "px) scale(" + s + ")";
    bubble.style.opacity = "0";
    bubble.getBoundingClientRect();
    bubble.style.transition = "transform .4s cubic-bezier(.2,.8,.2,1), opacity .26s ease";
    bubble.style.transform = "translate(0,0) scale(1)";
    bubble.style.opacity = "1";
    // 入场动画结束后清掉 inline transition，否则它会挡住 CSS 里 left/width 的放大/缩小过渡
    setTimeout(function () {
      if (bubble && bubble.classList.contains("nb-show")) bubble.style.transition = "";
    }, 460);
  }
  function resetBubbleState() {
    setActive(null);
    setProcessing(false);
    stopThink();
  }
  function bubbleAtBottom() {
    if (!bubbleBody) return true;
    return bubbleBody.scrollHeight - bubbleBody.scrollTop - bubbleBody.clientHeight < 24;
  }
  // 生成内容的衔接：连续扫开（clip-path 从上往下展开），只用于"刚生成完"的新内容
  function revealSweep() {
    var nb = bubbleBody.querySelector(".nb-note-body");
    if (!nb) return;
    nb.classList.remove("nb-sweep");
    void nb.offsetWidth;
    // 时长随内容高度微调，长文不会扫得太快
    var h = nb.scrollHeight;
    nb.style.animationDuration = Math.min(1.2, Math.max(0.6, h / 420)) + "s";
    nb.classList.add("nb-sweep");
  }
  // 滑到底只做标记（resultReachedBottom），不立即保存；关闭气泡时一次性保存
  function setPenVisible(on) {
    if (!bubble) return;
    var pen = bubble.querySelector("#nbPen");
    if (pen) pen.hidden = !on;
  }
  function toggleExpand() {
    if (!bubble) return;
    var expanded = bubble.classList.toggle("nb-bubble--expanded");
    var btn = bubble.querySelector("#nbExpand");
    if (btn) {
      btn.innerHTML = expanded ? COLLAPSE_SVG : EXPAND_SVG;
      btn.setAttribute("title", expanded ? "收起" : "放大查看");
    }
  }
  function isExpanded() { return bubble && bubble.classList.contains("nb-bubble--expanded"); }
  function closeBubble(point) {
    if (!bubble) { resetBubbleState(); return; }
    viewToken++;
    // 新注释结果态：滑过底 = 认可；关闭气泡的这一刻统一保存一次
    if (resultState && !resultState.existingId) {
      var rs = resultState;
      resultState = null;
      if (resultReachedBottom || bubbleAtBottom()) {
        saveNote(null, rs.question, rs.body, false);
      }
    }
    closeAskPop();
    explainSeq++;
    if (explainCtrl) { try { explainCtrl.abort(); } catch (e) {} explainCtrl = null; }
    resetBubbleState();
    if (!bubble.classList.contains("nb-show")) return;
    var target = bubble.getBoundingClientRect();
    var dx = 0, dy = 18, s = 0.9;
    if (point && typeof point.x === "number" && typeof point.y === "number") {
      dx = point.x - (target.left + target.width / 2);
      dy = point.y - (target.top + target.height / 2);
      s = 0.4;
    }
    bubble.classList.remove("nb-show");
    bubble.style.transition = "transform .26s cubic-bezier(.5,.05,.75,.35), opacity .2s ease";
    bubble.style.transform = "translate(" + dx + "px," + dy + "px) scale(" + s + ")";
    bubble.style.opacity = "0";
    clearTimeout(closeTimer);
    closeTimer = setTimeout(function () {
      closeTimer = null;
      if (!bubble.classList.contains("nb-show")) {
        bubble.style.transition = "";
        bubble.style.transform = "";
        bubble.style.opacity = "";
      }
    }, 280);
  }
  function titleFor(quote, dim) {
    return quote ? "<b>“" + esc2(cut(norm(quote), 22)) + "”</b>" : "<b>" + esc2(dim || "旁注") + "</b>";
  }

  // ================= 生成中的思考流 + 文字模糊 =================
  // 滚动思考流：首问与追问共用同一套机制与节奏（每行 停 .6s + 滚 .75s，点点点 1.3s）
  var THINK_LINES_ASK = ["读懂你圈出的这句话", "往回翻它所在的那一段", "想起相关的前端知识", "挑一个贴切的例子", "组织成一段解释"];
  var THINK_LINES_FOLLOWUP = ["对照你的要求", "比对新旧内容", "找出要增删的部分", "整理成修改清单"];
  var thinkTimer = null; // 首问 roller 的 stop 函数
  function buildThinkHTML() {
    return '<div class="nb-think-window"><div class="nb-think-track"></div></div>' +
           '<div class="nb-think-dots"><i></i><i></i><i></i></div>';
  }
  function makeRoller(container, lines) {
    var track = container.querySelector(".nb-think-track");
    function lineEl(t) {
      var d = document.createElement("div");
      d.className = "nb-think-line";
      d.textContent = t;
      return d;
    }
    for (var i = 0; i < 3 && i < lines.length; i++) track.appendChild(lineEl(lines[i]));
    var pi = 3;
    var lh = track.children[0].getBoundingClientRect().height;
    var stopped = false, t1 = null, t2 = null;
    function roll() {
      if (stopped) return;
      track.style.transition = "transform .75s cubic-bezier(.45,.05,.35,1)";
      track.style.transform = "translateY(-" + lh + "px)";
      t1 = setTimeout(function () {
        if (stopped) return;
        track.removeChild(track.firstChild);
        track.appendChild(lineEl(lines[pi % lines.length]));
        pi++;
        track.style.transition = "none";
        track.style.transform = "translateY(0)";
        void track.offsetWidth;
        t2 = setTimeout(roll, 600);
      }, 760);
    }
    roll();
    return function stop() { stopped = true; clearTimeout(t1); clearTimeout(t2); };
  }
  function startThink() {
    var think = bubbleBody.querySelector(".nb-think");
    if (!think) return;
    think.innerHTML = buildThinkHTML();
    thinkTimer = makeRoller(think, THINK_LINES_ASK);
  }
  function stopThink() { if (thinkTimer) { thinkTimer(); thinkTimer = null; } }

  function setProcessing(on) {
    if (!pending) return;
    var block = findBlock(pending);
    if (!block) return;
    if (on) {
      if (pending.quote) {
        markQuote(block, pending.quote, "__p__");
        var m = block.querySelector('mark.nb-quote[data-note="__p__"]');
        if (m) m.classList.add("nb-processing");
        else block.classList.add("nb-processing");
      } else {
        block.classList.add("nb-processing");
      }
    } else {
      block.querySelectorAll('mark.nb-quote[data-note="__p__"]').forEach(function (m) { m.replaceWith(document.createTextNode(m.textContent)); });
      block.classList.remove("nb-processing");
    }
  }

  // ================= 提问 / 生成 / 保存 =================
  async function viewAsk() {
    var tok = ++viewToken;
    openBubble(titleFor(pending.quote, "补注释"));
    // 候选文件 = 代码块 data-file 祖先 ∪ 选中文字/所在块里出现的文件名；默认全勾，用户可取消
    try { await loadBookFiles(); } catch (e) {}
    if (tok !== viewToken) return; // await 期间视图已被切换
    var textHits = matchFilesByText((pending.quote || "") + "\n" + (pending.blockText || ""));
    pendingCandidates = (pending.files || []).slice();
    for (var ti = 0; ti < textHits.length; ti++) {
      if (pendingCandidates.indexOf(textHits[ti]) < 0) pendingCandidates.push(textHits[ti]);
    }
    pendingFiles = pendingCandidates.slice(); // 默认全勾，用户可取消
    bubbleBody.innerHTML =
      '<div class="nb-ask">' +
      '<textarea id="nbQ" placeholder="哪里没懂？"></textarea>' +
      '<div class="nb-row">' +
        '<button class="nb-go" id="nbGo" aria-label="发送">' +
          '<span class="nb-go-label">解释</span>' +
          '<span class="nb-go-icon">↵</span>' +
        '</button>' +
      '</div>' +
      renderFilesList() +
      "</div>";
    bindFilesList();
    var ta = bubbleBody.querySelector("#nbQ");
    var btn = bubbleBody.querySelector("#nbGo");
    ta.focus();
    // 隐形快捷键：焦点在文件勾选框等非输入区时按回车 = 直接发送（用默认问题）
    bubbleBody.querySelector(".nb-ask").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && e.target !== ta) { e.preventDefault(); submit(); }
    });
    function refreshEnter() {
      if (ta.value.trim()) btn.classList.add("is-enter");
      else btn.classList.remove("is-enter");
    }
    function submit() {
      var q = ta.value.trim() || (pending.quote ? "这几个字是什么意思" : "这一段我没看懂");
      doExplain(q);
    }
    btn.addEventListener("click", submit);
    ta.addEventListener("input", refreshEnter);
    refreshEnter();
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        submit();
      }
    });
  }
  function viewLoading() {
    var body = bubbleBody;
    var tok = ++viewToken;
    body.classList.add("nb-body-exit");
    setTimeout(function () {
      if (tok !== viewToken) return;
      body.classList.remove("nb-body-exit");
      body.innerHTML = '<div class="nb-think"></div>';
      void body.offsetWidth;
      body.classList.add("nb-body-enter");
      startThink();
      setTimeout(function () { body.classList.remove("nb-body-enter"); }, 320);
    }, 170);
  }
  async function doExplain(question) {
    if (STATIC_MODE) { toast("静态演示不支持 AI 生成 · clone 仓库本地运行即可体验"); return; }
    viewLoading();
    setProcessing(true);
    var seq = ++explainSeq;
    var ctrl = new AbortController();
    explainCtrl = ctrl;
    var t = setTimeout(function () { ctrl.abort(); }, 120000);
    try {
      // 注入文件上下文：先读已勾选文件
      var files = pendingFiles.length ? await readFiles(pendingFiles) : [];
      var res = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quote: pending.quote || "",
          question: question,
          sectionTitle: pending.sectionTitle || "",
          blockText: pending.blockText || "",
          files: files,
        }),
        signal: ctrl.signal,
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error && data.error.message ? data.error.message : "生成失败");
      clearTimeout(t);
      if (seq !== explainSeq) return;
      explainCtrl = null;
      stopThink();
      setProcessing(false);
      viewResult(data.content, question, null);
    } catch (err) {
      clearTimeout(t);
      if (seq !== explainSeq) return;
      explainCtrl = null;
      stopThink();
      setProcessing(false);
      bubbleBody.innerHTML =
        '<div class="nb-row"><button class="nb-btn" id="nbRetry">再试一次</button></div>';
      var msg = err.name === "AbortError" ? "超时了，再试一次" : err.message;
      bubbleBody.querySelector("#nbRetry").addEventListener("click", function () { doExplain(question); });
      toast(msg);
    }
  }
  function viewResult(body, question, existingId) {
    var tok = ++viewToken;
    var note = existingId ? notes.find(function (n) { return n.id === existingId; }) : null;
    resultState = {
      existingId: existingId,
      question: question,
      body: body,
      editing: false,
      promoted: note ? !!note.promoted : false,
      quote: (pending && pending.quote) || (note ? note.quote : "") || "",
      sectionTitle: (pending && pending.sectionTitle) || (note ? note.sectionTitle : "") || "",
    };
    resultReachedBottom = false;
    setPenVisible(true);
    // 衔接动画：旧内容（思考态/清单）模糊上移淡出 → 新结果连续扫开（仅首次生成）
    bubbleBody.classList.add("nb-body-exit");
    setTimeout(function () {
      if (tok !== viewToken) return;
      bubbleBody.classList.remove("nb-body-exit");
      paintResult();
      if (!existingId) revealSweep(); // 打开旧注释不播，只有刚生成的才播
    }, 170);
  }

  function currentBody() {
    var s = resultState;
    if (!s) return "";
    if (s.editing) {
      var ed = bubbleBody.querySelector("#nbEdit");
      if (ed) s.body = htmlToMd(ed);
    }
    return s.body;
  }
  // contenteditable DOM → Markdown 源（覆盖 renderMarkdown 的元素集合，自产自销）
  function htmlToMd(root) {
    function inline(node) {
      var out = "";
      node.childNodes.forEach(function (n) {
        if (n.nodeType === 3) { out += n.nodeValue; return; }
        if (n.nodeType !== 1) return;
        var tag = n.tagName;
        if (tag === "STRONG" || tag === "B") out += "**" + inline(n) + "**";
        else if (tag === "EM" || tag === "I") out += "*" + inline(n) + "*";
        else if (tag === "CODE") out += "`" + n.textContent + "`";
        else if (tag === "A") out += "[" + inline(n) + "](" + (n.getAttribute("href") || "") + ")";
        else if (tag === "BR") out += "\n";
        else out += inline(n);
      });
      return out;
    }
    function block(el) {
      var tag = el.tagName;
      if (tag === "H3") return "### " + inline(el);
      if (tag === "H4") return "#### " + inline(el);
      if (tag === "BLOCKQUOTE") return "> " + inline(el);
      if (tag === "PRE") {
        var codeEl = el.querySelector("code");
        var lang = "";
        if (codeEl && codeEl.className) {
          var mcls = codeEl.className.match(/lang-([\w-]+)/);
          if (mcls) lang = mcls[1];
        }
        return "```" + lang + "\n" + (codeEl ? codeEl.textContent : el.textContent).replace(/\n$/, "") + "\n```";
      }
      if (tag === "UL") return Array.prototype.map.call(el.children, function (li) { return "- " + inline(li); }).join("\n");
      if (tag === "OL") {
        var num = parseInt(el.getAttribute("start") || "1", 10);
        return Array.prototype.map.call(el.children, function (li) { return (num++) + ". " + inline(li); }).join("\n");
      }
      if (tag === "TABLE") {
        var rows = [];
        var ths = el.querySelectorAll("thead th");
        if (ths.length) {
          rows.push("| " + Array.prototype.map.call(ths, function (t) { return inline(t); }).join(" | ") + " |");
          rows.push("|" + Array.prototype.map.call(ths, function () { return " --- "; }).join("|") + "|");
        }
        el.querySelectorAll("tbody tr").forEach(function (tr) {
          rows.push("| " + Array.prototype.map.call(tr.children, function (td) { return inline(td); }).join(" | ") + " |");
        });
        return rows.join("\n");
      }
      return inline(el);
    }
    var parts = [];
    root.childNodes.forEach(function (n) {
      if (n.nodeType === 3) { var t = n.nodeValue.replace(/^\s+|\s+$/g, ""); if (t) parts.push(t); }
      else if (n.nodeType === 1) parts.push(block(n));
    });
    return parts.join("\n\n");
  }

  function paintResult() {
    var s = resultState;
    if (!s) return;
    var isNew = !s.existingId;
    // 编辑态：所见即所得（飞书云文档式）——渲染后的 Markdown 直接可编辑，保存时转回 md 源
    var bodyHtml = s.editing
      ? '<div id="nbEdit" contenteditable="true" class="nb-edit-md">' + renderMarkdown(s.body) + "</div>"
      : '<div class="nb-note-body">' + renderMarkdown(s.body) + "</div>";
    bubbleBody.innerHTML =
      bodyHtml +
      '<div class="nb-row">' +
      '<button class="nb-icon-btn" id="nbPromote" data-tip="' + (isNew ? "添加为正文" : (s.promoted ? "从正文移除" : "添加为正文")) + '">' + (s.promoted ? BOOKMARK_SVG_FILLED : BOOKMARK_SVG) + "</button>" +
      (isNew ? "" : '<button class="nb-icon-btn danger" id="nbDelete" data-tip="删除">' + TRASH_SVG + "</button>") +
      '<button class="nb-icon-btn nb-more-btn" id="nbMore" data-tip="在末尾补充">＋</button>' +
      "</div>";

    bubbleBody.querySelector("#nbPromote").addEventListener("click", function () {
      if (isNew) saveNote(null, s.question, currentBody(), true);
      else saveNote(s.existingId, s.question, currentBody(), !s.promoted);
    });
    if (!isNew) {
      // 删除二次确认：点一次垃圾桶进入确认态（变红+抖动+提示换文案），3 秒内再点才真删
      var delBtn = bubbleBody.querySelector("#nbDelete");
      delBtn.addEventListener("click", function () {
        if (delBtn.classList.contains("confirming")) {
          clearTimeout(delBtn.__revertTimer);
          deleteNote(s.existingId);
          return;
        }
        delBtn.classList.add("confirming");
        delBtn.setAttribute("data-tip", "再点一次确认删除");
        delBtn.__revertTimer = setTimeout(function () {
          delBtn.classList.remove("confirming");
          delBtn.setAttribute("data-tip", "删除");
        }, 3000);
      });
    }
    bubbleBody.querySelector("#nbMore").addEventListener("click", function () {
      if (isDiffMode()) return; // diff 模式锁定：＋号禁用
      if (isAskPopOpen()) { closeAskPop(); return; }
      openAskPop("append", "", mouseAnchor(), "");
    });
  }

  function toggleEdit() {
    var s = resultState;
    if (!s) return;
    if (isDiffMode()) return; // diff 模式锁定：铅笔禁用
    if (s.editing) {
      currentBody();
      s.editing = false;
      if (s.existingId) updateExisting();
      paintResult();
    } else {
      s.editing = true;
      paintResult();
    }
  }

  function updateExisting() {
    var s = resultState;
    if (!s || !s.existingId) return;
    var note = notes.find(function (n) { return n.id === s.existingId; });
    if (!note) return;
    note.body = s.body;
    persist(note).then(function () {
      clearMarkers(note.id);
      var block = findBlock(note);
      if (block) {
        block.classList.add("nb-block");
        block.setAttribute("data-note", note.id);
        markQuote(block, note.quote, note.id);
      }
      renderPromoted(note);
      updateNav();
    });
  }

  // ================= 追问小气泡：跟随文字的独立浮层 =================
  var askPop = null;        // 浮层元素
  var askPopAnchor = null;  // { getRect: fn } 锚点
  var askPopCtx = null;     // { mode, selection }
  var askRollerStop = null; // 追问思考滚动 stop
  // 鼠标最后停留位置：追问气泡锚定在这里（方便鼠标就地点击）
  var lastMouse = { x: window.innerWidth / 2, y: window.innerHeight / 3 };
  document.addEventListener("mousedown", function (e) {
    lastMouse.x = e.clientX; lastMouse.y = e.clientY;
  }, true);
  function mouseAnchor() {
    return { getRect: function () {
      return { left: lastMouse.x, top: lastMouse.y, right: lastMouse.x, bottom: lastMouse.y + 6, width: 0, height: 6 };
    } };
  }

  function ensureAskPop() {
    if (askPop) return askPop;
    askPop = document.createElement("div");
    askPop.className = "nb-askpop";
    askPop.innerHTML =
      '<div class="nb-askpop-tag"></div>' +
      '<div class="nb-askpop-wrap">' +
        '<textarea class="nb-askpop-ta" placeholder="让它再讲讲 / 补充点什么"></textarea>' +
        '<button type="button" class="nb-askpop-go" aria-label="发送">↵</button>' +
      '</div>';
    document.body.appendChild(askPop);
    // 点外部关闭（nbMore 自己负责 toggle，排除）
    // 捕获阶段：点 askPop 以外任何区域（含注释区）都关小气泡；大气泡不联动
    document.addEventListener("mousedown", function (e) {
      if (!askPop || !askPop.classList.contains("nb-show")) return;
      if (askPop.contains(e.target)) return;
      if (e.target.closest && e.target.closest("#nbMore")) return;
      closeAskPop();
    }, true);
    return askPop;
  }
  function openAskPop(mode, selection, anchor, prefill) {
    var s = resultState;
    if (!s) return;
    ensureAskPop();
    askPopCtx = { mode: mode, selection: selection };
    askPopAnchor = anchor || { getRect: function () { return bubble ? bubble.getBoundingClientRect() : null; } };
    askPop.querySelector(".nb-askpop-tag").textContent = mode === "append" ? "在末尾补充" : "修改选中的这段话";
    var ta = askPop.querySelector(".nb-askpop-ta");
    var go = askPop.querySelector(".nb-askpop-go");
    ta.disabled = false; go.disabled = false;
    ta.value = prefill || "";
    askPop.querySelector(".nb-askpop-wrap").style.display = "";
    askPop.querySelector(".nb-askpop-tag").style.display = "";
    askPop.classList.add("nb-show");
    void askPop.offsetWidth;
    positionAskPop();
    function refreshEnter() { ta.value.trim() ? go.classList.add("has-text") : go.classList.remove("has-text"); }
    ta.oninput = refreshEnter;
    ta.onkeydown = function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); submitAsk(); }
    };
    go.onclick = submitAsk;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    refreshEnter();
  }
  function positionAskPop() {
    if (!askPop || !askPop.classList.contains("nb-show") || !askPopAnchor) return;
    var r = askPopAnchor.getRect();
    if (!r) return;
    var pw = askPop.offsetWidth, ph = askPop.offsetHeight;
    var left = Math.min(Math.max(12, r.left), window.innerWidth - pw - 12);
    var top = r.bottom + 8;
    if (top + ph > window.innerHeight - 12) top = Math.max(12, r.top - ph - 8);
    askPop.style.left = left + "px";
    askPop.style.top = top + "px";
  }
  function closeAskPop() {
    if (!askPop) return;
    if (askRollerStop) { askRollerStop(); askRollerStop = null; }
    askPop.classList.remove("nb-show");
    askPopAnchor = null;
    askPopCtx = null;
  }
  function isAskPopOpen() { return askPop && askPop.classList.contains("nb-show"); }
  function submitAsk() {
    var s = resultState;
    if (!s || !askPopCtx) return;
    var ta = askPop.querySelector(".nb-askpop-ta");
    var v = ta.value.trim();
    if (!v) return;
    s.__pendingInstruction = v;
    askFollowup(askPopCtx.mode, askPopCtx.selection, v);
  }
  async function askFollowup(mode, selection, instruction) {
    var s = resultState;
    if (!s) return;
    if (STATIC_MODE) { closeAskPop(); toast("静态演示不支持 AI 生成 · clone 仓库本地运行即可体验"); return; }
    var ta = askPop ? askPop.querySelector(".nb-askpop-ta") : null;
    var go = askPop ? askPop.querySelector(".nb-askpop-go") : null;
    if (go) go.disabled = true;
    if (ta) ta.disabled = true;
    // 思考态：输入框隐藏，显示滚动文字 + 点点点（与首问同节奏）
    if (askPop) {
      askPop.querySelector(".nb-askpop-wrap").style.display = "none";
      var think = askPop.querySelector(".nb-sub-think");
      if (!think) {
        think = document.createElement("div");
        think.className = "nb-sub-think";
        askPop.appendChild(think);
      }
      think.hidden = false;
      think.innerHTML = buildThinkHTML();
      askRollerStop = makeRoller(think, THINK_LINES_FOLLOWUP);
      positionAskPop();
    }
    try {
      var res = await fetch("/api/followup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: mode, selection: selection, instruction: instruction,
          context: s.body, quote: s.quote, sectionTitle: s.sectionTitle, question: s.question,
          files: [],
        }),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error && data.error.message ? data.error.message : "修改失败");
      var modified = data.content;
      closeAskPop();
      s.__diffOriginal = s.body;
      s.__diffModified = modified;
      s.__diffMode = mode;
      s.__diffSelection = selection;
      s.__diffInstruction = instruction;
      paintDiff();
    } catch (err) {
      if (askPop) {
        askPop.querySelector(".nb-askpop-wrap").style.display = "";
        var th = askPop.querySelector(".nb-sub-think");
        if (th) th.hidden = true;
      }
      if (go) go.disabled = false;
      if (ta) { ta.disabled = false; ta.focus(); }
      toast(err.message);
    }
  }

  // ---- 序列 diff（LCS）：输入字符串数组（行或 markdown 块），输出 same/add/del 序列 ----
  function sequenceDiff(aArr, bArr) {
    var al = aArr, bl = bArr;
    var m = al.length, n = bl.length;
    var dp = []; for (var i = 0; i <= m; i++) { dp.push(new Uint16Array(n + 1)); }
    for (var i = 1; i <= m; i++) {
      for (var j = 1; j <= n; j++) {
        dp[i][j] = al[i - 1] === bl[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    var ops = []; var i = m, j = n;
    while (i > 0 && j > 0) {
      if (al[i - 1] === bl[j - 1]) { ops.push({ t: "same", line: bl[j - 1] }); i--; j--; }
      else if (dp[i - 1][j] >= dp[i][j - 1]) { ops.push({ t: "del", line: al[i - 1] }); i--; }
      else { ops.push({ t: "add", line: bl[j - 1] }); j--; }
    }
    while (i > 0) { ops.push({ t: "del", line: al[i - 1] }); i--; }
    while (j > 0) { ops.push({ t: "add", line: bl[j - 1] }); j--; }
    return ops.reverse();
  }

  // markdown → 块数组：代码块（含围栏）整体一块，其余按空行分段——保证代码块不被 diff 切碎
  function splitMdBlocks(md) {
    var lines = md.split("\n");
    var parts = [];   // {type:'code'|'text', text}
    var cur = [], inCode = false, codeBuf = [];
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];
      if (/^\s*```/.test(L)) {
        if (!inCode) {
          if (cur.join("").trim()) parts.push({ type: "text", text: cur.join("\n") });
          cur = [];
          inCode = true; codeBuf = [L];
        } else {
          codeBuf.push(L);
          parts.push({ type: "code", text: codeBuf.join("\n") });
          codeBuf = []; inCode = false;
        }
      } else if (inCode) codeBuf.push(L);
      else cur.push(L);
    }
    if (inCode && codeBuf.join("").trim()) parts.push({ type: "code", text: codeBuf.join("\n") });
    if (cur.join("").trim()) parts.push({ type: "text", text: cur.join("\n") });
    var blocks = [];
    parts.forEach(function (p) {
      if (p.type === "code") { blocks.push(p.text); return; }
      p.text.split(/\n{2,}/).forEach(function (seg) {
        var t = seg.replace(/^\n+|\n+$/g, "");
        if (t) blocks.push(t);
      });
    });
    return blocks;
  }

  // diff 模式判定：审阅卡在场时，全站追问入口冻结，只能确认覆盖或返回
  function isDiffMode() { return !!(resultState && resultState.__diffOriginal); }
  function paintDiff() {
    var s = resultState;
    if (!s || !s.__diffOriginal) return;
    // 块级 diff：代码块整体参与对比，段落按空行分块
    var aBlocks = splitMdBlocks(s.__diffOriginal);
    var bBlocks = splitMdBlocks(s.__diffModified);
    var ops = sequenceDiff(aBlocks, bBlocks);
    var adds = ops.filter(function (o) { return o.t === "add"; }).length;
    var dels = ops.filter(function (o) { return o.t === "del"; }).length;
    var modeLabel = s.__diffMode === "edit" ? "修改选中的这段话" : "在末尾补充";
    var statTxt = [];
    if (adds) statTxt.push("新增 " + adds + " 段");
    if (dels) statTxt.push("删除 " + dels + " 段");
    // 改动大 → 默认左右对比；小 → 默认分块对照
    var view0 = (ops.length > 8 || adds + dels >= 4) ? "split" : "flow";
    var box = document.createElement("div");
    box.className = "nb-diff";
    box.dataset.view = view0;
    var flowR = renderDiffFlow(ops);
    var splitR = renderDiffSplit(ops);
    box.innerHTML =
      '<div class="nb-diff-op">' +
        '<span class="nb-diff-op-mode">' + esc2(modeLabel) + "</span>" +
        (s.__diffInstruction ? '<span class="nb-diff-op-instruction">“' + esc2(cut(s.__diffInstruction, 40)) + "”</span>" : "") +
        (statTxt.length ? '<span class="nb-diff-op-stat">' + esc2(statTxt.join(" · ")) + "</span>" : "") +
        '<div class="nb-diff-views">' +
          '<button type="button" data-dview="flow">对照</button>' +
          '<button type="button" data-dview="split">左右对比</button>' +
        "</div>" +
      "</div>" +
      '<div class="nb-diff-body">' +
        '<div class="nb-diff-changes">' +
          '<div class="nb-diff-changes-tag">修改区域</div>' +
          '<div class="nb-diff-flow">' + (flowR.changes || '<div class="nb-diff-none">这一版没有内容变化</div>') + "</div>" +
          '<div class="nb-diff-split">' + (splitR.changedCount ? splitR.changes : '<div class="nb-diff-none">这一版没有内容变化</div>') + "</div>" +
        "</div>" +
        (flowR.unchanged
          ? '<div class="nb-diff-unchanged">' +
              '<button type="button" class="nb-diff-unchanged-toggle">未改动内容（' + flowR.sameCount + "）</button>" +
              '<div class="nb-diff-unchanged-body" hidden>' +
                '<div class="nb-diff-flow">' + flowR.unchanged + "</div>" +
                '<div class="nb-diff-split">' + splitR.unchanged + "</div>" +
              "</div>" +
            "</div>"
          : "") +
      "</div>" +
      '<div class="nb-diff-actions">' +
        '<button type="button" class="nb-diff-revert">返回上一句话</button>' +
        '<button type="button" class="nb-diff-apply">确认覆盖</button>' +
      "</div>";
    var existing = bubbleBody.firstChild;
    bubbleBody.insertBefore(box, existing);
    // diff 模式锁定：收掉所有追问入口，此状态只允许「确认覆盖 / 返回上一句话」
    hideFloat();
    hideSubchip();
    setPenVisible(false);
    box.querySelectorAll("[data-dview]").forEach(function (b) {
      if (b.getAttribute("data-dview") === view0) b.classList.add("active");
      b.addEventListener("click", function () {
        box.dataset.view = b.getAttribute("data-dview");
        box.querySelectorAll("[data-dview]").forEach(function (x) { x.classList.toggle("active", x === b); });
      });
    });
    var uToggle = box.querySelector(".nb-diff-unchanged-toggle");
    if (uToggle) uToggle.addEventListener("click", function () {
      var uBody = box.querySelector(".nb-diff-unchanged-body");
      var open = !uBody.hidden;
      uBody.hidden = open;
      uToggle.textContent = open ? "未改动内容（" + flowR.sameCount + "）" : "收起未改动内容";
    });
    bubbleBody.scrollTop = 0;
    resultReachedBottom = false;

    box.querySelector(".nb-diff-apply").addEventListener("click", function () {
      s.body = s.__diffModified;
      clearDiff();
      resultReachedBottom = false;
      paintResult();
      if (s.existingId) updateExisting();
      if (bubbleAtBottom()) resultReachedBottom = true;
      toast("已应用");
    });
    box.querySelector(".nb-diff-revert").addEventListener("click", function () {
      revertDiff();
    });
  }
  // 单个 diff 块的渲染（flow/split 共用）
  function diffBlockHtml(op) {
    // 无标签 pill：用行首 +/− 符号（git diff 语言）区分增删，更简洁
    var txt = op.line;
    if (op.t === "add") return '<div class="nb-diff-block add">' + renderMarkdown(txt) + "</div>";
    if (op.t === "del") return '<div class="nb-diff-block del">' + renderMarkdown(txt) + "</div>";
    return '<div class="nb-diff-block same">' + renderMarkdown(txt) + "</div>";
  }
  // 分块对照：改动块进 changes（主视觉），same 块进 unchanged（折叠）
  function renderDiffFlow(ops) {
    var groups = [];
    ops.forEach(function (o) {
      var last = groups[groups.length - 1];
      if (last && last.t === o.t) last.texts.push(o.line);
      else groups.push({ t: o.t, texts: [o.line] });
    });
    var changes = "", unchanged = "", sameCount = 0;
    groups.forEach(function (g) {
      var txt = g.texts.join("\n\n");
      var html = diffBlockHtml({ t: g.t, line: txt });
      if (g.t === "same") { unchanged += html; sameCount += g.texts.length; }
      else changes += html;
    });
    return { changes: changes, unchanged: unchanged, sameCount: sameCount };
  }
  // 左右对比：含改动的行对进 changes（主视觉），纯 same 行对进 unchanged（折叠）
  function renderDiffSplit(ops) {
    var pairs = [];
    var i = 0;
    while (i < ops.length) {
      var o = ops[i];
      if (o.t === "same") { pairs.push({ l: o, r: o }); i++; continue; }
      if (o.t === "del" && i + 1 < ops.length && ops[i + 1].t === "add") { pairs.push({ l: o, r: ops[i + 1] }); i += 2; continue; }
      if (o.t === "add" && i + 1 < ops.length && ops[i + 1].t === "del") { pairs.push({ l: ops[i + 1], r: o }); i += 2; continue; }
      if (o.t === "del") { pairs.push({ l: o, r: null }); i++; continue; }
      pairs.push({ l: null, r: o }); i++;
    }
    var COLS = '<div class="nb-diff-cols-head"><span>原版</span><span>修改后</span></div>';
    var mk = function (rows) { return COLS + '<div class="nb-diff-rows">' + rows + "</div>"; };
    var changedRows = "", unchangedRows = "", sameCount = 0, changedCount = 0;
    pairs.forEach(function (p) {
      var row = '<div class="nb-diff-row">' +
        '<div class="nb-diff-cell">' + (p.l ? diffBlockHtml(p.l) : "") + "</div>" +
        '<div class="nb-diff-cell">' + (p.r ? diffBlockHtml(p.r) : "") + "</div>" +
        "</div>";
      var isPureSame = p.l && p.r && p.l.t === "same" && p.r.t === "same";
      if (isPureSame) { unchangedRows += row; sameCount++; }
      else { changedRows += row; changedCount++; }
    });
    return {
      changes: changedRows ? mk(changedRows) : "",
      unchanged: unchangedRows ? mk(unchangedRows) : "",
      sameCount: sameCount,
      changedCount: changedCount,
    };
  }
  function clearDiff() {
    var d = bubbleBody.querySelector(".nb-diff");
    if (d) d.remove();
    var s = resultState;
    if (s) { s.__diffOriginal = null; s.__diffModified = null; s.__diffMode = null; s.__diffSelection = null; s.__diffInstruction = null; }
  }
  function revertDiff() {
    var s = resultState;
    if (!s) return;
    // 先取值再清理（clearDiff 会把 __diff* 置空）
    var mode = s.__diffMode || "append";
    var selection = s.__diffSelection || "";
    var instruction = s.__diffInstruction || "";
    clearDiff();
    // 重开追问小气泡：上次那句话回填进输入框，光标到末尾，可继续编辑
    openAskPop(mode, selection, mouseAnchor(), instruction);
    toast("已回到上一句话，可继续修改");
  }

  function hideSubchip() {
    if (!subchip) return;
    var c = subchip;
    subchip = null;
    subchipRange = null;
    c.classList.remove("nb-show");
    setTimeout(function () { c.remove(); }, 160);
  }
  function handleNoteMouseup() {
    setTimeout(function () {
      hideSubchip();
      if (isDiffMode()) return; // diff 模式锁定：diff 内外的选字都不触发追问
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      var node = sel.anchorNode;
      var el = node && (node.nodeType === 3 ? node.parentElement : node);
      if (!el || !bubbleBody.contains(el)) return;
      if (el.closest("#nbEdit")) return;
      var text = sel.toString().trim();
      if (!text || text.length > 300) return;
      var range = sel.getRangeAt(0);
      var rect = range.getBoundingClientRect();
      if (!rect || rect.height === 0) return;
      // 以"最后一个字"为定位线：取选区最后一个行片段的右缘
      var rects = range.getClientRects();
      var lastRect = rects[rects.length - 1] || rect;
      var chip = document.createElement("button");
      chip.className = "nb-subchip";
      chip.textContent = "追问这段";
      chip.addEventListener("mousedown", function (e) { e.preventDefault(); });
      chip.addEventListener("click", function () {
        hideSubchip();
        openAskPop("edit", text, mouseAnchor(), "");
      });
      document.body.appendChild(chip);
      subchip = chip;
      subchipRange = range;
      positionSubchip();
      void chip.offsetWidth;
      chip.classList.add("nb-show");
    }, 0);
  }
  function saveNote(existingId, question, body, promote) {
    resultState = null;
    resultReachedBottom = false;
    var note;
    if (existingId) {
      note = notes.find(function (n) { return n.id === existingId; });
      if (!note) return;
      note.body = body;
      note.question = note.question || question;
      if (promote !== undefined) note.promoted = promote;
    } else {
      note = {
        id: "n" + Date.now().toString(36),
        section: pending.section,
        blockText: pending.blockText,
        quote: pending.quote || "",
        sectionTitle: pending.sectionTitle || "",
        question: question,
        body: body,
        promoted: !!promote,
        createdAt: today(),
      };
      notes.push(note);
    }
    persist(note).then(function () {
      clearMarkers(note.id);
      var block = findBlock(note);
      if (block) {
        block.classList.add("nb-block");
        block.setAttribute("data-note", note.id);
        markQuote(block, note.quote, note.id);
        anchorMap = anchorMap.filter(function (x) { return x.note.id !== note.id; });
        anchorMap.push({ el: block, note: note });
        anchorMap.sort(function (a, b) { return (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1; });
      }
      renderPromoted(note);
      updateNav();
      closeBubble();
      toast(note.promoted ? "已晋升为正文" : "已记下");
      pending = null;
    });
  }
  function deleteNote(id) {
    resultState = null;
    if (STATIC_MODE) {
      notes = notes.filter(function (n) { return n.id !== id; });
      try { localStorage.setItem("shelf-notes-" + BOOK, JSON.stringify(notes)); } catch (e) {}
      clearMarkers(id);
      anchorMap = anchorMap.filter(function (x) { return x.note.id !== id; });
      updateNav();
      closeBubble();
      toast("已删除（本地）");
      return;
    }
    fetch("/api/notes?book=" + BOOK + "&id=" + encodeURIComponent(id), { method: "DELETE" }).then(function (r) { return r.json(); }).then(function (d) {
      notes = d.notes;
      clearMarkers(id);
      anchorMap = anchorMap.filter(function (x) { return x.note.id !== id; });
      updateNav();
      closeBubble();
      toast("已删除");
    });
  }
  function persistLocal(note) {
    var idx = notes.findIndex(function (n) { return n.id === note.id; });
    if (idx >= 0) notes[idx] = note; else notes.push(note);
    try { localStorage.setItem("shelf-notes-" + BOOK, JSON.stringify(notes)); } catch (e) {}
    return Promise.resolve();
  }
  function persist(note) {
    if (STATIC_MODE) return persistLocal(note);
    return fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ book: BOOK, note: note }),
    }).then(function (r) { return r.json(); }).then(function (d) { notes = d.notes; })
      .catch(function () { return persistLocal(note); });
  }

  function viewNote(id, fromEl) {
    var note = notes.find(function (n) { return n.id === id; });
    if (!note) return;
    setActive(id);
    openBubble(titleFor(note.quote, note.sectionTitle || "旁注"), fromEl);
    viewResult(note.body, note.question, id);
  }
  function viewList(fromEl) {
    viewToken++;
    openBubble("<b>全部注释</b>", fromEl);
    bubbleBody.innerHTML =
      (anchorMap.length ? "" : '<p style="color:var(--muted);font-size:13px;">还没有注释。选中正文里的一句话试试。</p>') +
      anchorMap.map(function (x) {
        return '<div class="nb-list-item" data-id="' + x.note.id + '"><p class="t">' + esc2(cut(x.note.body.replace(/[#>*`\n]/g, "").trim(), 40) || "（空）") +
          '</p><p class="s">' + esc2(x.note.sectionTitle || x.note.section) + (x.note.promoted ? " · 已晋升" : "") + "</p></div>";
      }).join("");
    bubbleBody.querySelectorAll(".nb-list-item").forEach(function (it) {
      it.addEventListener("click", function () { viewNote(it.getAttribute("data-id"), it); });
    });
  }

  // ================= 选中文字 → 浮按钮 =================
  var floatBtn = null;
  var floatCleanup = null;
  function hideFloat() {
    if (!floatBtn) return;
    var b = floatBtn;
    floatBtn = null;
    clearTimeout(floatCleanup);
    b.classList.remove("nb-show");
    floatCleanup = setTimeout(function () { b.remove(); }, 180);
  }
  function positionFloat(sel) {
    if (!floatBtn) return false;
    if (!sel || sel.isCollapsed || !sel.rangeCount) { hideFloat(); return false; }
    var range = sel.getRangeAt(0);
    var full = range.getBoundingClientRect();
    // 取末尾字符的 rect（鼠标拖选结束处），比 collapse(false) 更稳（collapse 到元素边界会返回 0 高）
    var endNode = range.endContainer, endOff = range.endOffset;
    var er = null;
    if (endNode && endNode.nodeType === 3 && endOff > 0) {
      try {
        var cr = document.createRange();
        cr.setStart(endNode, endOff - 1);
        cr.setEnd(endNode, endOff);
        er = cr.getBoundingClientRect();
      } catch (e) {}
    }
    if (!er || er.height === 0) er = full;
    if (!er || er.height === 0) { hideFloat(); return false; }
    if (er.bottom < 0 || er.top > window.innerHeight) { hideFloat(); return false; }
    floatBtn.style.left = Math.max(12, Math.min(er.left, window.innerWidth - 150)) + "px";
    floatBtn.style.top = Math.min(er.bottom + 8, window.innerHeight - 56) + "px";
    return true;
  }
  function setupSelection() {
    document.addEventListener("mouseup", function () {
      setTimeout(function () {
        hideFloat();
        if (isDiffMode()) return; // diff 模式锁定：正文选字不触发补注释
        var sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return;
        var quote = sel.toString().trim();
        if (!quote || quote.length > 300) return;
        var node = sel.anchorNode;
        var host = node && (node.nodeType === 3 ? node.parentElement : node);
        host = host && host.closest ? host.closest(BLOCK_SEL) : null;
        if (!host || !main.contains(host) || host.closest(".nb-promoted")) return;
        floatBtn = document.createElement("button");
        floatBtn.className = "nb-float";
        floatBtn.textContent = "＋ 补注释";
        floatBtn.addEventListener("mousedown", function (e) { e.preventDefault(); });
        floatBtn.addEventListener("click", function () {
          hideFloat();
          // 文件上下文来源一：找最近的 [data-file] 祖先（代码块）；来源二（文本匹配）在 viewAsk 里做
          pending = {
            section: (host.closest(".chapter") || {}).id || "",
            sectionTitle: sectionTitle(host),
            blockText: norm(host.textContent),
            quote: quote,
            files: detectFiles(host),
          };
          viewAsk();
        });
        document.body.appendChild(floatBtn);
        if (!positionFloat(sel)) return;
        void floatBtn.offsetWidth; // 强制 reflow，确保初始状态已应用后再过渡
        floatBtn.classList.add("nb-show");
      }, 0);
    });
    document.addEventListener("mousedown", function (e) {
      if (floatBtn && !floatBtn.contains(e.target)) hideFloat();
    });
    // 滚动时浮按钮跟随选区末尾
    var ticking = false;
    window.addEventListener("scroll", function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        if (floatBtn) positionFloat(window.getSelection());
      });
    }, { passive: true });
  }

  // ================= 点击注释元素打开气泡（委托） =================
  function setupClickOpen() {
    main.addEventListener("click", function (e) {
      var t = e.target;
      var m = t.closest ? t.closest("mark.nb-quote") : null;
      if (!m) return; // 只有点击划线文字才打开注释
      var id = m.getAttribute("data-note");
      if (!id) return;
      // 已打开同一注释 → 再次点击回收（关闭），不重复打开
      if (activeId === id && bubble && bubble.classList.contains("nb-show")) {
        closeBubble({ x: e.clientX, y: e.clientY });
        return;
      }
      viewNote(id, m);
    });
  }
  function setupDismiss() {
    document.addEventListener("mousedown", function (e) {
      if (!bubble || !bubble.classList.contains("nb-show")) return;
      var t = e.target;
      if (!t || !t.closest) return;
      if (bubble.contains(t)) return;
      if (t.closest(".nb-nav") || t.closest(".nb-float") || t.closest(".nb-subchip")) return;
      if (t.closest("mark.nb-quote")) return;
      closeBubble({ x: e.clientX, y: e.clientY });
    });
  }

  // ================= 导航 =================
  function setupNav() {
    var nav = document.createElement("div");
    nav.className = "nb-nav";
    nav.id = "nbNav";
    nav.hidden = true;
    nav.innerHTML =
      '<button id="nbPrev" title="上一处">‹</button>' +
      '<span class="nb-count" id="nbCount">0 / 0</span>' +
      '<button id="nbNext" title="下一处">›</button>' +
      '<span class="nb-divider"></span>' +
      '<button id="nbListBtn" title="全部注释">☰</button>';
    document.body.appendChild(nav);
    nav.querySelector("#nbPrev").addEventListener("click", function () { jump(-1); });
    nav.querySelector("#nbNext").addEventListener("click", function () { jump(1); });
    nav.querySelector("#nbListBtn").addEventListener("click", function (e) { viewList(e.target); });
    function jump(delta) {
      if (!anchorMap.length) return;
      var next = (activeIdx() + delta + anchorMap.length) % anchorMap.length;
      var item = anchorMap[next];
      setActive(item.note.id);
      item.el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  // ================= 启动 =================
  setupSelection();
  setupClickOpen();
  setupDismiss();
  setupNav();
  buildBubble();
  fetch("/api/notes?book=" + BOOK)
    .then(function (r) { if (!r.ok) throw new Error("static"); return r.json(); })
    .then(function (list) { notes = list || []; refreshAll(); })
    .catch(function () {
      STATIC_MODE = true;
      var loadFromLocalStorage = function () {
        try { notes = JSON.parse(localStorage.getItem("shelf-notes-" + BOOK) || "[]"); } catch (e) { notes = []; }
        refreshAll();
        toast("静态演示：阅读与本地批注可用 · AI 生成请本地运行");
      };
      var saved = null;
      try { saved = localStorage.getItem("shelf-notes-" + BOOK); } catch (e) {}
      if (saved) { try { notes = JSON.parse(saved); } catch (e) { notes = []; } refreshAll(); return; }
      // 首次访问：读随书附带的示例注释
      fetch("data/" + BOOK + ".json")
        .then(function (r) { if (!r.ok) throw new Error("none"); return r.json(); })
        .then(function (list) { notes = list || []; refreshAll(); })
        .catch(loadFromLocalStorage);
    });
})();
