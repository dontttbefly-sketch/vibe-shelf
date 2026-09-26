/* 知识书架 · 旁注层逻辑（叠加在原书脚本之上，不改变原书正文结构） */
(function () {
  "use strict";
  var main = document.querySelector(".book-main");
  if (!main) return;

  var BOOK = window.SHELF_BOOK || "default"; // 由 build.mjs 注入；书名决定注释存到 data/<书名>.json
  // 新书页带有项目上下文；旧书页继续走原来的单书接口与本地存储键。
  var CONTEXT = window.SHELF_CONTEXT || {
    projectId: null,
    bookId: BOOK,
    sourceSnapshotId: null,
    staticNotesUrl: "data/" + BOOK + ".json",
  };
  CONTEXT.bookId = CONTEXT.bookId || BOOK;
  function projectNotesPath() {
    if (!CONTEXT.projectId) return "/api/notes?book=" + encodeURIComponent(BOOK);
    return "/api/projects/" + encodeURIComponent(CONTEXT.projectId) + "/books/" + encodeURIComponent(CONTEXT.bookId) + "/notes";
  }
  function projectBookPath(action) {
    return "/api/projects/" + encodeURIComponent(CONTEXT.projectId) + "/books/" + encodeURIComponent(CONTEXT.bookId) + "/" + action;
  }
  function projectSnapshotPath(action) {
    return "/api/projects/" + encodeURIComponent(CONTEXT.projectId) + "/snapshots/" + encodeURIComponent(CONTEXT.sourceSnapshotId) + "/" + action;
  }
  function localNotesKey() {
    return CONTEXT.projectId ? "shelf-notes-" + CONTEXT.projectId + "-" + CONTEXT.bookId : "shelf-notes-" + BOOK;
  }
  var STATIC_MODE = false; // GitHub Pages 等纯静态部署：阅读+本地批注可用，AI 生成不可用
  var notes = [];
  var blocks = [];
  var anchorMap = [];
  var activeId = null;
  var pending = null;   // { section, sectionTitle, blockText, quote }
  var thinkTimer = null;
  var closeTimer = null;
  var miniTimer = null;      // 思考收进右上角迷你卡的延迟触发
  var miniRollStop = null;   // 迷你卡里滚动文字的 stop 函数
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
  var searchPanel = null;
  var searchCtrl = null;
  var searchMatches = [];
  var searchLast = null;
  var MAX_SELECTION_QUOTE_CHARS = 4000;
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
    if (!bookFiles || !bookFiles.length || !text) return { full: [], base: [] };
    // full = 完整路径出现在文字里（确定）；base = 仅文件名命中（可能同名歧义，如每章的 code.py）
    var full = [], base = [];
    for (var i = 0; i < bookFiles.length; i++) {
      var p = bookFiles[i].path;
      var baseName = p.split("/").pop(); // assets/styles.css → styles.css
      if (text.indexOf(p) >= 0) {
        if (full.indexOf(p) < 0) full.push(p);
      } else if (text.indexOf(baseName) >= 0) {
        if (base.indexOf(p) < 0) base.push(p);
      }
    }
    return { full: full, base: base };
  }
  async function loadBookFiles(force) {
    if (!force && bookFiles) return bookFiles;
    try {
      var r = await fetch(CONTEXT.projectId ? projectSnapshotPath("files") : "/api/files?book=" + encodeURIComponent(BOOK));
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
        var r = await fetch(CONTEXT.projectId ? projectSnapshotPath("file") + "?path=" + encodeURIComponent(p) : "/api/file?book=" + encodeURIComponent(BOOK) + "&path=" + encodeURIComponent(p));
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
  // 划线标记：先在注释所属块内匹配；quote 跨块（表格多行/代码块+正文）时升级全书范围兜底
  function markQuote(block, quote, id) {
    if (!quote) return;
    if (markQuoteIn(block, quote, id)) return;
    if (main) markQuoteIn(main, quote, id);
  }
  function markQuoteIn(scope, quote, id) {
    if (!quote || !scope) return false;
    var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
    var nodes = [], flat = "", n;
    while ((n = walker.nextNode())) { nodes.push({ node: n, start: flat.length }); flat += n.nodeValue; }
    if (!flat) return false;
    var idx = flat.indexOf(quote), end = idx + quote.length;
    if (idx < 0) {
      // 去空白容错：sel.toString 会在块级边界插入 \n，DOM 文本流里没有——两边都删空白后再对位
      var map = [], normFlat = "";
      for (var i = 0; i < flat.length; i++) {
        if (!/\s/.test(flat[i])) { normFlat += flat[i]; map.push(i); }
      }
      var nq = quote.replace(/\s+/g, "");
      var nIdx = normFlat.indexOf(nq);
      if (nIdx < 0 || !map.length) return false;
      idx = map[nIdx];
      end = map[Math.min(nIdx + nq.length - 1, map.length - 1)] + 1;
    }
    // 找覆盖到的文本节点分段（文档序）
    var parts = [];
    for (var k = 0; k < nodes.length; k++) {
      var s = nodes[k].start, e = s + nodes[k].node.nodeValue.length;
      if (e <= idx || s >= end) continue;
      parts.push({ node: nodes[k].node, lo: Math.max(idx, s) - s, hi: Math.min(end, e) - s });
    }
    if (!parts.length) return false;
    // 倒序逐段包裹（插入 mark 不影响未处理的前置节点偏移）
    for (var j = parts.length - 1; j >= 0; j--) {
      var p = parts[j];
      if (p.hi - p.lo <= 0) continue;
      var r = document.createRange();
      r.setStart(p.node, p.lo);
      r.setEnd(p.node, p.hi);
      var m = document.createElement("mark");
      m.className = "nb-quote";
      m.setAttribute("data-note", id);
      m.appendChild(r.extractContents());
      r.insertNode(m);
    }
    return true;
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
  var RESTORE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 14 4 9 9 4"></polyline><path d="M20 20v-7a4 4 0 0 0-4-4H4"></path></svg>';
  var SEARCH_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="16.5" y1="16.5" x2="21" y2="21"></line></svg>';
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
      '<span class="nb-promoted-head-actions"><button class="nb-promoted-toggle" type="button">展开</button>' +
      '<button class="nb-promoted-restore" type="button" title="返回回注释" aria-label="返回回注释">' + RESTORE_SVG + "</button></span></div>" +
      '<div class="nb-promoted-body"><div class="nb-note-body">' + renderMarkdown(note.body) + "</div></div>";
    var body = d.querySelector(".nb-promoted-body");
    var toggle = d.querySelector(".nb-promoted-toggle");
    d.querySelector(".nb-promoted-head").addEventListener("click", function (e) {
      if (e.target.closest(".nb-promoted-restore")) return; // 点返回图标不触发展开
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
    d.querySelector(".nb-promoted-restore").addEventListener("click", function (e) {
      e.stopPropagation();
      if (d.classList.contains("nb-removing")) return;
      // 返回为注释：整卡退场后恢复原注释锚点与划线。
      d.style.maxHeight = d.offsetHeight + "px";
      void d.offsetWidth;
      d.classList.add("nb-restoring", "nb-removing");
      setTimeout(function () {
        var id = note.id;
        var n = notes.find(function (x) { return x.id === id; });
        if (!n) return;
        n.promoted = false;
        persist(n).then(function () {
          var restored = notes.find(function (x) { return x.id === id; }) || n;
          applyNotePlacement(restored, { animate: "restore" });
          toast("已返回回注释");
        });
      }, 360);
    });
    block.insertAdjacentElement("afterend", d);
  }
  function removeAnchor(id) {
    anchorMap = anchorMap.filter(function (x) { return x.note.id !== id; });
  }
  function sortAnchors() {
    anchorMap.sort(function (a, b) { return (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1; });
  }
  function addNoteAnchor(note) {
    if (note.promoted) return;
    var block = findBlock(note);
    if (!block) return;
    block.classList.add("nb-block");
    block.setAttribute("data-note", note.id);
    markQuote(block, note.quote, note.id);
    removeAnchor(note.id);
    anchorMap.push({ el: block, note: note });
    sortAnchors();
  }
  function animateRestoredNote(id) {
    var targets = Array.from(main.querySelectorAll('.nb-block[data-note="' + id + '"], mark.nb-quote[data-note="' + id + '"]'));
    if (!targets.length) return;
    targets.forEach(function (el) { el.classList.remove("nb-restored"); });
    void main.offsetWidth;
    targets.forEach(function (el) { el.classList.add("nb-restored"); });
    setTimeout(function () {
      targets.forEach(function (el) { el.classList.remove("nb-restored"); });
    }, 760);
  }
  function applyNotePlacement(note, opts) {
    opts = opts || {};
    clearMarkers(note.id);
    removeAnchor(note.id);
    if (note.promoted) renderPromoted(note);
    else addNoteAnchor(note);
    updateNav();
    if (opts.animate === "restore") animateRestoredNote(note.id);
    if (opts.animate === "insert") animateInsertedPromoted(note.id);
  }
  function animateInsertedPromoted(id) {
    var card = main.querySelector('.nb-promoted[data-note="' + id + '"]');
    if (!card) return;
    card.classList.remove("nb-inserted");
    void card.offsetWidth;
    card.classList.add("nb-inserted");
    setTimeout(function () { card.classList.remove("nb-inserted"); }, 820);
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
      if (note.promoted) { renderPromoted(note); return; }
      addNoteAnchor(note);
    });
    updateNav();
  }
  function activeIdx() {
    var i = anchorMap.findIndex(function (x) { return x.note.id === activeId; });
    return i < 0 ? 0 : i;
  }
  function updateNav() {
    var nav = document.getElementById("nbNav");
    if (!nav) return;
    nav.hidden = false;
    var c = document.getElementById("nbCount");
    if (c) c.textContent = anchorMap.length ? ((activeIdx() + 1) + " / " + anchorMap.length) : "0 / 0";
    ["nbPrev", "nbNext", "nbListBtn"].forEach(function (id) {
      var btn = document.getElementById(id);
      if (btn) btn.disabled = anchorMap.length === 0;
    });
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
      '<button class="nb-expand" id="nbExpand" title="放大查看" aria-label="放大">' + EXPAND_SVG + "</button>" +
      '<button class="nb-close" id="nbClose">×</button></div>' +
      '<div class="nb-bubble-body" id="nbBody"></div>';
    document.body.appendChild(bubble);
    bubbleBody = bubble.querySelector("#nbBody");
    bubbleTitle = bubble.querySelector("#nbTitle");
    bubble.querySelector("#nbClose").addEventListener("click", closeBubble);
    bubble.querySelector("#nbExpand").addEventListener("click", function () { toggleExpand(); });
    // 双击标题栏空白或标题文字：放大/缩小切换（双击按钮除外）
    bubble.querySelector(".nb-bubble-head").addEventListener("dblclick", function (e) {
      if (e.target.closest("button")) return;
      toggleExpand();
    });
    bubbleBody.addEventListener("scroll", function () {
      if (bubbleAtBottom()) resultReachedBottom = true;
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
      if (isInlineAskOpen()) return;
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      var text = sel.toString().trim();
      if (!text || text.length > MAX_SELECTION_QUOTE_CHARS) return;
      var node = sel.anchorNode;
      var el = node && (node.nodeType === 3 ? node.parentElement : node);
      if (!el) return;
      if (bubbleBody.contains(el)) {
        if (!resultState || el.closest("#nbEdit")) return;
        e.preventDefault();
        hideSubchip();
        openInlineAsk("edit", text, "");
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
        if (isInlineAskOpen()) { closeInlineAsk(); return; }
        if (isExpanded()) { toggleExpand(); return; }
        closeBubble();
      }
    });
  }
  // 重置放大态：关闭后下次打开必须回到右上角收起态（尺寸/位置/按钮图标）
  function resetExpandedState() {
    if (!bubble) return;
    bubble.classList.remove("nb-bubble--expanded");
    bubble.style.translate = "";
    var btn = bubble.querySelector("#nbExpand");
    if (btn) { btn.innerHTML = EXPAND_SVG; btn.setAttribute("title", "放大查看"); }
  }
  function openBubble(titleHtml, fromEl) {
    if (!bubble) buildBubble();
    clearTimeout(closeTimer); closeTimer = null;
    resetExpandedState(); // 防御：快速关-开路径会打断关闭动画里的清理，这里兜底
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
  function toggleExpand() {
    if (!bubble) return;
    var expanded = bubble.classList.toggle("nb-bubble--expanded");
    var btn = bubble.querySelector("#nbExpand");
    if (btn) {
      btn.innerHTML = expanded ? COLLAPSE_SVG : EXPAND_SVG;
      btn.setAttribute("title", expanded ? "收起" : "放大查看");
    }
    // 阅读主焦点：对准正文栏中心（左侧目录使视觉重心偏右，几何居中反而偏左）
    // dx = 正文栏中心 - expanded 右锚定时的几何中心（与 CSS 联动：width min(880, vw-120)、right 28px）
    if (expanded && main && main.getBoundingClientRect) {
      var mr = main.getBoundingClientRect();
      var w = Math.min(880, window.innerWidth - 120);
      var anchorCenter = window.innerWidth - 28 - w / 2;
      var dx = Math.round((mr.left + mr.right) / 2 - anchorCenter);
      bubble.style.translate = dx + "px 0";
    } else if (bubble) {
      bubble.style.translate = "";
    }
  }
  function isExpanded() { return bubble && bubble.classList.contains("nb-bubble--expanded"); }
  function closeBubble(point) {
    if (!bubble) { resetBubbleState(); return; }
    exitMini(); // 清迷你卡（滚动定时器/class/内联高度），防下次打开残留
    viewToken++;
    // 新注释结果态：滑过底 = 认可；关闭气泡的这一刻统一保存一次
    if (resultState && !resultState.existingId) {
      var rs = resultState;
      resultState = null;
      if (resultReachedBottom || bubbleAtBottom()) {
        saveNote(null, rs.question, rs.body, false);
      }
    }
    closeInlineAsk();
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
        resetExpandedState(); // 退出动画结束后重置放大态（动画期间保持原尺寸，避免收跳）
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

  // ---- 思考中迷你态：气泡收缩成右上角小卡（不打扰阅读），完成后飞回展开 ----
  // 高度走 FLIP（auto↔数值不可过渡，两侧都用数值，结束后释放回 auto）；宽度交给 CSS transition
  function miniHTML() {
    return '<div class="nb-mini-think">' +
      '<div class="nb-mini-label">思考中</div>' +
      '<div class="nb-mini-roll"><div class="nb-think-window nb-mini-window"><div class="nb-think-track"></div></div></div>' +
      '<div class="nb-think-dots"><i></i><i></i><i></i></div>' +
      "</div>";
  }
  function enterMini() {
    if (!bubble || !bubble.classList.contains("nb-show")) return;
    if (bubble.classList.contains("nb-mini")) return;
    stopThink();
    var h0 = bubble.offsetHeight, w0 = bubble.offsetWidth;
    bubble.classList.add("nb-mini");
    bubbleBody.innerHTML = miniHTML();
    var h1 = bubble.offsetHeight;
    bubble.style.transition = "none";
    bubble.style.height = h0 + "px";
    bubble.style.width = w0 + "px";
    void bubble.offsetWidth; // 冻结在旧尺寸后再放行过渡
    bubble.style.transition = "";
    bubble.style.height = h1 + "px";
    bubble.style.width = ""; // 回到 .nb-mini 的 CSS 宽度 → 宽度过渡
    miniRollStop = makeRoller(bubbleBody, THINK_LINES_ASK);
    setTimeout(function () { if (bubble) bubble.style.height = ""; }, 420);
  }
  function exitMini() {
    if (miniTimer) { clearTimeout(miniTimer); miniTimer = null; }
    if (miniRollStop) { miniRollStop(); miniRollStop = null; }
    if (!bubble || !bubble.classList.contains("nb-mini")) return;
    var h0 = bubble.offsetHeight, w0 = bubble.offsetWidth;
    bubble.classList.remove("nb-mini");
    bubble.style.transition = "none";
    bubble.style.height = h0 + "px";
    bubble.style.width = w0 + "px";
    void bubble.offsetWidth;
    bubble.style.transition = "";
    bubble.style.width = ""; // 宽度过渡回 392px；高度交给 viewResult 的内容扫开
  }

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
    // 候选文件 = 代码块 data-file 祖先 ∪ 选中文字/所在块里出现的文件名
    // 默认只勾「确定的」（data-file 祖先 + 完整路径命中）；同名歧义的 basename 命中
    // （如各章的 code.py）列出来但不勾，用户手动挑；唯一 basename 命中视为确定
    try { await loadBookFiles(); } catch (e) {}
    if (tok !== viewToken) return; // await 期间视图已被切换
    var textHits = matchFilesByText((pending.quote || "") + "\n" + (pending.blockText || ""));
    pendingCandidates = (pending.files || []).slice();
    for (var fi = 0; fi < textHits.full.length; fi++) {
      if (pendingCandidates.indexOf(textHits.full[fi]) < 0) pendingCandidates.push(textHits.full[fi]);
    }
    for (var bi = 0; bi < textHits.base.length; bi++) {
      if (pendingCandidates.indexOf(textHits.base[bi]) < 0) pendingCandidates.push(textHits.base[bi]);
    }
    pendingFiles = (pending.files || []).concat(textHits.full); // 默认勾确定的
    if (!pendingFiles.length && textHits.base.length === 1) pendingFiles = [textHits.base[0]];
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
    // 思考收进右上角迷你卡：等内容过渡（170ms）落位后再收缩；
    // 触发前确认气泡里仍是本次的思考态（期间用户点开别的注释时跳过，不误伤新内容）
    miniTimer = setTimeout(function () {
      if (bubbleBody && bubbleBody.querySelector(".nb-think")) enterMini();
    }, 240);
    var seq = ++explainSeq;
    var ctrl = new AbortController();
    explainCtrl = ctrl;
    var t = setTimeout(function () { ctrl.abort(); }, 120000);
    try {
      // 注入文件上下文：先读已勾选文件
      var files = pendingFiles.length ? await readFiles(pendingFiles) : [];
      var res = await fetch(CONTEXT.projectId ? projectBookPath("explain") : "/api/explain", {
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
      exitMini(); // 迷你卡飞回展开
      viewResult(data.content, question, null);
      // 生成即保存：不再等"滑到底/关闭气泡"，落地为已有注释（编辑/晋升/删除随即全部可用）
      var saved = saveNote(null, question, data.content, false, { silent: true });
      if (saved && resultState) resultState.existingId = saved.id;
    } catch (err) {
      clearTimeout(t);
      if (seq !== explainSeq) return;
      explainCtrl = null;
      stopThink();
      setProcessing(false);
      exitMini(); // 失败也回到大卡显示重试
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
      fresh: !existingId, // 刚生成的才播扫开动画（自动保存会把 existingId 立即补上，不能用它判断）
      quote: (pending && pending.quote) || (note ? note.quote : "") || "",
      sectionTitle: (pending && pending.sectionTitle) || (note ? note.sectionTitle : "") || "",
    };
    resultReachedBottom = false;
    // 衔接动画：旧内容（思考态/清单）模糊上移淡出 → 新结果连续扫开（仅首次生成）
    bubbleBody.classList.add("nb-body-exit");
    setTimeout(function () {
      if (tok !== viewToken) return;
      bubbleBody.classList.remove("nb-body-exit");
      paintResult();
      if (resultState && resultState.fresh) revealSweep(); // 打开旧注释不播，只有刚生成的才播
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
    // 释放迷你态/FLIP 残留的壳高锁：过渡到内容实际高度后交还 auto（否则内容被锁在小框里滚动）
    if (bubble && bubble.style.height) {
      var h1 = bubble.scrollHeight;
      bubble.style.height = h1 + "px";
      setTimeout(function () { if (bubble) bubble.style.height = ""; }, 420);
    }
    var isNew = !s.existingId;
    // 编辑态：所见即所得（飞书云文档式）——渲染后的 Markdown 直接可编辑，保存时转回 md 源
    var visibleBody = s.__inlineChangeHtml || renderMarkdown(s.body);
    var bodyHtml = s.editing
      ? '<div id="nbEdit" contenteditable="true" class="nb-edit-md">' + renderMarkdown(s.body) + "</div>"
      : '<div class="nb-note-body' + (s.__inlineChangeHtml ? " nb-note-body--changed" : "") + '">' + visibleBody + "</div>";
    // 追问痕迹：问句一行一条。问句列表 = 对话记录 = 版本历史，正文是对话的最新一稿
    var trailHtml = (s.__versions || []).map(function (v) {
      return '<div class="nb-trail-item">↳ 你问：' + esc2(cut(v.instruction, 34)) + "</div>";
    }).join("");
    if (trailHtml) trailHtml = '<div class="nb-ask-trail">' + trailHtml + "</div>";
    bubbleBody.innerHTML =
      bodyHtml +
      '<div class="nb-row">' +
      '<button class="nb-icon-btn' + (s.editing ? " nb-editing" : "") + '" id="nbEditBtn" data-tip="' + (s.editing ? "完成编辑" : "编辑") + '">' + PEN_SVG + "</button>" +
      '<button class="nb-icon-btn" id="nbPromote" data-tip="' + (isNew ? "添加为正文" : (s.promoted ? "从正文移除" : "添加为正文")) + '">' + (s.promoted ? BOOKMARK_SVG_FILLED : BOOKMARK_SVG) + "</button>" +
      (isNew ? "" : '<button class="nb-icon-btn danger" id="nbDelete" data-tip="删除">' + TRASH_SVG + "</button>") +
      '<button class="nb-icon-btn nb-more-btn" id="nbMore" data-tip="在末尾补充">＋</button>' +
      "</div>" +
      trailHtml +
      '<div class="nb-inline-ask" hidden>' +
        '<div class="nb-inline-label">' +
          '<span class="nb-inline-label-text"></span>' +
          '<span class="nb-inline-sel" hidden></span>' +
        "</div>" +
        '<div class="nb-inline-wrap">' +
          '<textarea class="nb-inline-textarea" placeholder="继续问一句，或让它补得更清楚"></textarea>' +
          '<button type="button" class="nb-inline-go" aria-label="发送">↵</button>' +
        "</div>" +
        '<div class="nb-inline-think" hidden></div>' +
      "</div>";

    bubbleBody.querySelector("#nbEditBtn").addEventListener("click", function () { toggleEdit(); });
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
      if (isInlineAskOpen()) { closeInlineAsk(); return; }
      openInlineAsk("append", "", "");
    });
  }

  function toggleEdit() {
    var s = resultState;
    if (!s) return;
    if (s.editing) {
      currentBody();
      s.editing = false;
      s.__inlineChangeHtml = null;
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

  // ================= 追问：只在这一个气泡里进行（不再另开气泡） =================
  // 追问一律收束到当前注释气泡底部的输入框：气泡一多，上下文就散了。
  var inlineAskCtx = null;   // 注释卡底部追问 { mode, selection }
  var inlineRollerStop = null;
  var inlineShimmerStop = null;

  function inlineAskEl() {
    return bubbleBody ? bubbleBody.querySelector(".nb-inline-ask") : null;
  }
  function isInlineAskOpen() {
    var box = inlineAskEl();
    return !!(box && !box.hidden && box.classList.contains("nb-show"));
  }
  function scrollInlineAskIntoView() {
    if (!bubbleBody) return;
    requestAnimationFrame(function () {
      if (!bubbleBody) return;
      if (bubbleBody.scrollTo) bubbleBody.scrollTo({ top: bubbleBody.scrollHeight, behavior: "smooth" });
      else bubbleBody.scrollTop = bubbleBody.scrollHeight;
    });
  }
  function openInlineAsk(mode, selection, prefill, opts) {
    var s = resultState;
    if (!s) return;
    hideSubchip();
    inlineAskCtx = { mode: mode, selection: selection || "" };
    var box = inlineAskEl();
    if (!box) { paintResult(); box = inlineAskEl(); }
    if (!box) return;
    var label = box.querySelector(".nb-inline-label");
    var labelText = box.querySelector(".nb-inline-label-text");
    var selChip = box.querySelector(".nb-inline-sel");
    var wrap = box.querySelector(".nb-inline-wrap");
    var think = box.querySelector(".nb-inline-think");
    var ta = box.querySelector(".nb-inline-textarea");
    var go = box.querySelector(".nb-inline-go");
    var clipped = clipSelection(selection);
    // free 态（写回后常驻重开）：整行指令标签都藏掉，只留输入框，存在感最低
    if (label) label.hidden = mode === "free";
    if (mode !== "free") (labelText || label).textContent = mode === "append" ? "在这条注释末尾补充" : "追问选中的这段";
    // 选中内容的身份牌：前三个字 + 省略号，带特殊样式，让用户确认"选中的是这段"
    if (selChip) {
      if (clipped) {
        selChip.textContent = clipped;
        selChip.hidden = false;
      } else {
        selChip.textContent = "";
        selChip.hidden = true;
      }
    }
    box.hidden = false;
    box.classList.remove("nb-thinking");
    box.classList.add("nb-show");
    wrap.hidden = false;
    think.hidden = true;
    stopInlineThink();
    ta.disabled = false;
    go.disabled = false;
    ta.value = prefill || "";
    function refreshEnter() { ta.value.trim() ? go.classList.add("has-text") : go.classList.remove("has-text"); }
    ta.oninput = refreshEnter;
    ta.onkeydown = function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); submitInlineAsk(); }
    };
    go.onclick = submitInlineAsk;
    // silent（写回后重开）：只亮出来，不抢焦点不滚动——视线应该先落在正文的改动上
    if (opts && opts.silent) { refreshEnter(); return; }
    scrollInlineAskIntoView();
    setTimeout(function () {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }, 180);
    refreshEnter();
  }
  function closeInlineAsk() {
    var box = inlineAskEl();
    stopInlineThink();
    inlineAskCtx = null;
    if (!box) return;
    box.classList.remove("nb-show", "nb-thinking");
    setTimeout(function () {
      if (!box.classList.contains("nb-show")) box.hidden = true;
    }, 220);
  }
  function submitInlineAsk() {
    var s = resultState;
    if (!s || !inlineAskCtx) return;
    var box = inlineAskEl();
    var ta = box ? box.querySelector(".nb-inline-textarea") : null;
    var v = ta ? ta.value.trim() : "";
    if (!v) return;
    s.__pendingInstruction = v;
    askFollowup(inlineAskCtx.mode, inlineAskCtx.selection, v);
  }
  async function askFollowup(mode, selection, instruction) {
    var s = resultState;
    if (!s) return;
    if (STATIC_MODE) { closeInlineAsk(); toast("静态演示不支持 AI 生成 · clone 仓库本地运行即可体验"); return; }
    var box = inlineAskEl();
    var ta = box ? box.querySelector(".nb-inline-textarea") : null;
    var go = box ? box.querySelector(".nb-inline-go") : null;
    if (go) go.disabled = true;
    if (ta) ta.disabled = true;
    // 思考态：输入框原地收成一行，文字被扫光带过 + 尾部脉冲点（Claude 式）
    if (box) {
      box.classList.add("nb-thinking");
      box.querySelector(".nb-inline-wrap").hidden = true;
      var think = box.querySelector(".nb-inline-think");
      think.hidden = false;
      startInlineThink(think);
      scrollInlineAskIntoView();
    }
    try {
      var res = await fetch(CONTEXT.projectId ? projectBookPath("followup") : "/api/followup", {
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
      var original = s.body;
      // 版本栈：每次追问把上一稿连同问句一起留痕（内存态，随气泡会话消失）
      (s.__versions = s.__versions || []).push({ instruction: instruction, body: original });
      applyFollowupInline(original, modified, mode, selection, instruction);
    } catch (err) {
      if (box) {
        box.classList.remove("nb-thinking");
        box.querySelector(".nb-inline-wrap").hidden = false;
        var th = box.querySelector(".nb-inline-think");
        if (th) th.hidden = true;
        stopInlineThink();
      }
      if (go) go.disabled = false;
      if (ta) { ta.disabled = false; ta.focus(); }
      toast(err.message);
    }
  }

  function renderInlineChange(original, modified) {
    var res = renderChangeHtml(original, modified);
    // 改动说明不再用说教文案——"哪次追问改的"由问句痕（nb-ask-trail）承担，正文里只留字级标记
    if (!res.changed) return renderMarkdown(modified || "");
    return res.html;
  }

  function applyFollowupInline(original, modified, mode, selection, instruction) {
    var s = resultState;
    if (!s) return;
    s.body = modified;
    s.__inlineChangeHtml = renderInlineChange(original, modified);
    s.__inlineChangeMode = mode;
    s.__inlineChangeSelection = selection;
    s.__inlineChangeInstruction = instruction;
    resultReachedBottom = true;
    if (s.existingId) updateExisting();
    paintResult();
    // 追问框常驻：写回后原地重开（free 态，不带指令标签），不打断继续追问
    openInlineAsk("free", "", "", { silent: true });
    // 改动落地：正文整体淡入，同时新增/删去处自己闪一下，视线自动落到改动点上
    var nb = bubbleBody.querySelector(".nb-note-body");
    if (nb) {
      nb.classList.remove("nb-change-applied");
      void nb.offsetWidth;
      nb.classList.add("nb-change-applied");
      setTimeout(function () { if (nb) nb.classList.remove("nb-change-applied"); }, 1400);
    }
    if (bubbleBody && bubbleBody.scrollTo) bubbleBody.scrollTo({ top: 0, behavior: "smooth" });
    toast("已写进注释");
  }

  // ================= 字词级 diff：改动直接落进原文，不用 diff 卡 =================
  // 目标：删掉的字被划掉、新增的字带底色，其余原文照旧排在那里——
  // 读者一眼看到"这段变成了什么"，而不是去对照两张卡。

  // ---- 字词级 diff 单测区（纯函数，勿依赖 DOM） ----
  var DIFF_TOKEN_LIMIT = 1200; // 超过这个长度降级为整块增删，避免 O(n·m) 回溯卡顿
  // 成对标记：\u0002 del 起 / \u0003 del 止 / \u0004 add 起 / \u0005 add 止
  var MK_D0 = "\u0002", MK_D1 = "\u0003", MK_A0 = "\u0004", MK_A1 = "\u0005";
  // 分词：ASCII 词/数字成块，中文按字切；标点与空白各自成块，保证不会把词拆碎
  function tokenize(str) {
    var s = String(str || "");
    var re = /[A-Za-z0-9_]+|\s+|[\u4e00-\u9fff]|[\s\S]/g;
    return s.match(re) || [];
  }
  // LCS 字词级 diff：返回 [{ t:'same'|'add'|'del', text }]，顺序为阅读顺序
  function tokenDiff(aStr, bStr) {
    var a = tokenize(aStr), b = tokenize(bStr);
    var m = a.length, n = b.length;
    if (m > DIFF_TOKEN_LIMIT || n > DIFF_TOKEN_LIMIT) {
      if (aStr === bStr) return aStr ? [{ t: "same", text: aStr }] : [];
      var big = [];
      if (aStr) big.push({ t: "del", text: aStr });
      if (bStr) big.push({ t: "add", text: bStr });
      return big;
    }
    var dp = [];
    for (var i = 0; i <= m; i++) dp.push(new Uint32Array(n + 1));
    for (var i = 1; i <= m; i++) {
      for (var j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    var rev = []; var i = m, j = n;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) { rev.push({ t: "same", text: b[j - 1] }); i--; j--; }
      else if (dp[i - 1][j] >= dp[i][j - 1]) { rev.push({ t: "del", text: a[i - 1] }); i--; }
      else { rev.push({ t: "add", text: b[j - 1] }); j--; }
    }
    while (i > 0) { rev.push({ t: "del", text: a[i - 1] }); i--; }
    while (j > 0) { rev.push({ t: "add", text: b[j - 1] }); j--; }
    rev.reverse();
    return cleanupDiff(mergeAdjacent(rev));
  }
  // 合并同类相邻块，减少碎片
  function mergeAdjacent(ops) {
    var out = [];
    ops.forEach(function (o) {
      var last = out[out.length - 1];
      if (last && last.t === o.t) last.text += o.text;
      else out.push({ t: o.t, text: o.text });
    });
    return out;
  }
  // 语义清理：把夹在增删之间的一两个相同字并入增删块。
  // 否则会出现「划掉『很危』/ 高亮『存在注入风』/ 留着『险』」这种碎块，读起来很糟。
  function cleanupDiff(ops) {
    var out = ops.slice();
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i < out.length - 2; i++) {
        var a = out[i], c = out[i + 1], b = out[i + 2];
        if (a.t === "del" && c.t === "same" && b.t === "add" && c.text.length <= 2) {
          out.splice(i, 3, { t: "del", text: a.text + c.text }, { t: "add", text: c.text + b.text });
          changed = true;
          break;
        }
      }
    }
    // 同一处增删统一成"先删后增"，读起来才是"原来 X 变成 Y"
    for (var k = 0; k < out.length - 1; k++) {
      if (out[k].t === "add" && out[k + 1].t === "del") {
        var tmp = out[k]; out[k] = out[k + 1]; out[k + 1] = tmp;
      }
    }
    return mergeAdjacent(out);
  }
  // 把 diff 结果标成带成对标记的纯文本，交给 markdown 渲染器统一处理
  function markMd(ops) {
    return ops.map(function (o) {
      if (o.t === "same") return o.text;
      if (o.t === "del") return MK_D0 + o.text + MK_D1;
      return MK_A0 + o.text + MK_A1;
    }).join("");
  }
  function countMarkOps(ops) {
    var adds = 0, dels = 0;
    ops.forEach(function (o) { if (o.t === "add") adds++; else if (o.t === "del") dels++; });
    return { adds: adds, dels: dels };
  }
  // 选中内容的标签文案：只露前三个字 + 省略号，让用户一眼确认"我选中的是这段"。
  // 不足三个字时不加省略号（不加就不会谎报"后面还有内容"）。
  function clipSelection(text) {
    var s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    if (!s) return "";
    return s.length > 3 ? s.slice(0, 3) + "…" : s;
  }
  // ---- 字词级 diff 单测区结束 ----

  // 标记文本 → 渲染后的 HTML：把成对标记换成 <del>/<ins>
  function markedToHtml(marked) {
    return renderMarkdown(marked)
      .replace(/\u0002([\s\S]*?)\u0003/g, '<del class="nb-w-del">$1</del>')
      .replace(/\u0004([\s\S]*?)\u0005/g, '<ins class="nb-w-add">$1</ins>');
  }

  // 含块级结构的段落（代码块/标题/列表/表格/引用/段内换行）不做字级切分，整段标色更可读
  function isPlainPara(seg) {
    var t = String(seg || "").trim();
    if (!t) return false;
    if (/^```/.test(t)) return false;
    if (/^#{2,4}\s/.test(t)) return false;
    if (/^\|/.test(t)) return false;
    if (/^[-*]\s/.test(t)) return false;
    if (/^\d+\.\s/.test(t)) return false;
    if (/^>\s?/.test(t)) return false;
    if (t.indexOf("\n") >= 0) return false;
    return true;
  }
  // markdown → 段落数组（代码块整体一段，其余按空行切段）
  function splitMdSegments(md) {
    var lines = String(md || "").split("\n");
    var parts = [];
    var cur = [], inCode = false, codeBuf = [];
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];
      if (/^\s*```/.test(L)) {
        if (!inCode) {
          if (cur.join("").trim()) parts.push({ type: "text", text: cur.join("\n") });
          cur = []; inCode = true; codeBuf = [L];
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
    var segs = [];
    parts.forEach(function (p) {
      if (p.type === "code") { segs.push(p.text); return; }
      p.text.split(/\n{2,}/).forEach(function (s) {
        var t = s.replace(/^\n+|\n+$/g, "");
        if (t) segs.push(t);
      });
    });
    return segs;
  }
  // 段级对齐：same / del / add / replace（一删一增配对成 replace，段内才好做字级）
  function seqDiffBy(aArr, bArr) {
    var m = aArr.length, n = bArr.length;
    var dp = [];
    for (var i = 0; i <= m; i++) dp.push(new Uint32Array(n + 1));
    for (var i = 1; i <= m; i++) {
      for (var j = 1; j <= n; j++) {
        dp[i][j] = aArr[i - 1] === bArr[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    var rev = []; var i = m, j = n;
    while (i > 0 && j > 0) {
      if (aArr[i - 1] === bArr[j - 1]) { rev.push({ t: "same", text: bArr[j - 1] }); i--; j--; }
      else if (dp[i - 1][j] >= dp[i][j - 1]) { rev.push({ t: "del", text: aArr[i - 1] }); i--; }
      else { rev.push({ t: "add", text: bArr[j - 1] }); j--; }
    }
    while (i > 0) { rev.push({ t: "del", text: aArr[i - 1] }); i--; }
    while (j > 0) { rev.push({ t: "add", text: bArr[j - 1] }); j--; }
    rev.reverse();
    var ops = [];
    for (var k = 0; k < rev.length; k++) {
      var o = rev[k];
      if (o.t === "del" && rev[k + 1] && rev[k + 1].t === "add") {
        ops.push({ t: "replace", a: o.text, b: rev[k + 1].text }); k++; continue;
      }
      if (o.t === "add" && rev[k + 1] && rev[k + 1].t === "del") {
        ops.push({ t: "replace", a: rev[k + 1].text, b: o.text }); k++; continue;
      }
      ops.push(o);
    }
    return ops;
  }

  // 主入口：原文 + 改后文 → { html, changed, adds, dels }
  // 未改动的段落原样渲染；改动段落内未变的字也原样保留，只把增删部分标记出来。
  function renderChangeHtml(original, modified) {
    var aSegs = splitMdSegments(original);
    var bSegs = splitMdSegments(modified);
    var ops = seqDiffBy(aSegs, bSegs);
    var adds = 0, dels = 0, changed = false;
    var html = "";
    ops.forEach(function (op) {
      if (op.t === "same") { html += renderMarkdown(op.text); return; }
      if (op.t === "del") {
        changed = true; dels++;
        html += '<div class="nb-change-block nb-change-block--del">' + renderMarkdown(op.text) + "</div>";
        return;
      }
      if (op.t === "add") {
        changed = true; adds++;
        html += '<div class="nb-change-block nb-change-block--add">' + renderMarkdown(op.text) + "</div>";
        return;
      }
      // replace：段内做字词级切分，删/增都留在这一段的原位
      changed = true;
      if (isPlainPara(op.a) && isPlainPara(op.b)) {
        var inner = tokenDiff(op.a, op.b);
        var c = countMarkOps(inner);
        adds += c.adds; dels += c.dels;
        html += markedToHtml(markMd(inner));
      } else {
        // 结构复杂（代码块/列表/表格）：整段标色，不切字
        adds++; dels++;
        html += '<div class="nb-change-block nb-change-block--del">' + renderMarkdown(op.a) + "</div>" +
          '<div class="nb-change-block nb-change-block--add">' + renderMarkdown(op.b) + "</div>";
      }
    });
    return { html: html, changed: changed, adds: adds, dels: dels };
  }

  // ================= 追问思考态：Claude 式扫光 =================
  var THINK_LINES_FOLLOWUP = ["正在读你这句话", "对照注释原文", "找出要改的地方", "重写这一段", "校对措辞"];
  var THINK_PHRASE_MS = 1900;
  // 一行短语 + 一道从左到右扫过的光带 + 尾部脉冲点；只动 transform，不重绘背景
  function startInlineThink(host) {
    stopInlineThink();
    host.innerHTML =
      '<span class="nb-shimmer">' +
        '<span class="nb-shimmer-text"></span>' +
        '<span class="nb-shimmer-band" aria-hidden="true"></span>' +
      "</span>" +
      '<span class="nb-shimmer-dots"><i></i><i></i><i></i></span>';
    var textEl = host.querySelector(".nb-shimmer-text");
    var pi = 0;
    function nextPhrase() {
      if (!textEl || !textEl.isConnected) return;
      textEl.textContent = THINK_LINES_FOLLOWUP[pi % THINK_LINES_FOLLOWUP.length];
      pi++;
    }
    nextPhrase();
    var phraseTimer = setInterval(nextPhrase, THINK_PHRASE_MS);
    inlineShimmerStop = function () {
      clearInterval(phraseTimer);
      inlineShimmerStop = null;
    };
  }
  function stopInlineThink() {
    if (inlineShimmerStop) { inlineShimmerStop(); inlineShimmerStop = null; }
    if (inlineRollerStop) { inlineRollerStop(); inlineRollerStop = null; }
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
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      var node = sel.anchorNode;
      var el = node && (node.nodeType === 3 ? node.parentElement : node);
      if (!el || !bubbleBody.contains(el)) return;
      if (el.closest("#nbEdit")) return;
      var text = sel.toString().trim();
      if (!text || text.length > MAX_SELECTION_QUOTE_CHARS) return;
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
        openInlineAsk("edit", text, "");
      });
      document.body.appendChild(chip);
      subchip = chip;
      subchipRange = range;
      positionSubchip();
      void chip.offsetWidth;
      chip.classList.add("nb-show");
    }, 0);
  }
  function saveNote(existingId, question, body, promote, opts) {
    opts = opts || {};
    if (!opts.silent) resultState = null; // silent（生成即保存）时保留结果态，由调用方升级 existingId
    resultReachedBottom = false;
    var note;
    if (existingId) {
      note = notes.find(function (n) { return n.id === existingId; });
      if (!note) return null;
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
      var saved = notes.find(function (n) { return n.id === note.id; }) || note;
      applyNotePlacement(saved);
      pending = null;
      if (opts.silent) { toast("已记下"); return; } // 自动保存也要给"已落盘"的确认感
      closeBubble();
      toast(saved.promoted ? "已晋升为正文" : "已记下");
    });
    return note;
  }
  function deleteNote(id) {
    resultState = null;
    if (STATIC_MODE) {
      notes = notes.filter(function (n) { return n.id !== id; });
      try { localStorage.setItem(localNotesKey(), JSON.stringify(notes)); } catch (e) {}
      clearMarkers(id);
      removeAnchor(id);
      updateNav();
      closeBubble();
      toast("已删除（本地）");
      return;
    }
    fetch(projectNotesPath() + (CONTEXT.projectId ? "?id=" : "&id=") + encodeURIComponent(id), { method: "DELETE" }).then(function (r) { return r.json(); }).then(function (d) {
      notes = d.notes;
      clearMarkers(id);
      removeAnchor(id);
      updateNav();
      closeBubble();
      toast("已删除");
    });
  }
  function persistLocal(note) {
    var idx = notes.findIndex(function (n) { return n.id === note.id; });
    if (idx >= 0) notes[idx] = note; else notes.push(note);
    try { localStorage.setItem(localNotesKey(), JSON.stringify(notes)); } catch (e) {}
    return Promise.resolve();
  }
  function persist(note) {
    if (STATIC_MODE) return persistLocal(note);
    return fetch(projectNotesPath(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ book: BOOK, note: note }),
    }).then(function (r) { return r.json(); }).then(function (d) { notes = d.notes; })
      .catch(function () { return persistLocal(note); });
  }

  function viewNote(id, fromEl) {
    var note = notes.find(function (n) { return n.id === id; });
    if (!note || note.promoted) return;
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
        var sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return;
        var quote = sel.toString().trim();
        if (!quote || quote.length > MAX_SELECTION_QUOTE_CHARS) return;
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
      if (t.closest(".nb-search-panel")) return;
      if (t.closest("mark.nb-quote")) return;
      closeBubble({ x: e.clientX, y: e.clientY });
    });
  }

  // ================= 全局问答 / 搜索 =================
  function globalSearchTerms(question) {
    var q = (question || "").toLowerCase();
    var terms = [];
    function add(x) {
      if (!x) return;
      x = String(x).toLowerCase().trim();
      if (x && terms.indexOf(x) < 0) terms.push(x);
    }
    var raw = q.match(/[a-z0-9_.-]+|[\u4e00-\u9fa5]{2,}/g) || [];
    raw.forEach(add);
    [
      { keys: ["动效", "动画", "过渡", "motion", "滑动"], vals: ["动效", "动画", "过渡", "缓动", "滑动", "transform", "transition", "translate", "scroll"] },
      { keys: ["演算", "计算", "怎么算"], vals: ["计算", "演算", "clamp", "状态", "坐标", "transform"] },
      { keys: ["设计", "怎么出来", "怎么做"], vals: ["设计", "实现", "效果", "代码", "逐块拆解"] },
      { keys: ["css", "样式", "外观"], vals: ["css", "styles.css", "外观", "变量", "响应式"] },
      { keys: ["js", "javascript", "交互", "行为"], vals: ["javascript", "app.js", "行为", "事件", "状态", "渲染"] },
    ].forEach(function (group) {
      if (group.keys.some(function (k) { return q.indexOf(k) >= 0; })) group.vals.forEach(add);
    });
    return terms.slice(0, 18);
  }
  function collectSearchMatches(question) {
    collectBlocks();
    var terms = globalSearchTerms(question);
    if (!terms.length) return [];
    var scored = [];
    blocks.forEach(function (el, i) {
      var title = sectionTitle(el);
      var text = norm(el.textContent);
      var hay = (title + "\n" + text).toLowerCase();
      var score = 0;
      terms.forEach(function (term) {
        if (!term) return;
        if ((title || "").toLowerCase().indexOf(term) >= 0) score += 5;
        if (hay.indexOf(term) >= 0) score += 2;
      });
      if (score <= 0) return;
      var sec = el.closest(".chapter");
      scored.push({
        el: el,
        order: i,
        score: score,
        section: sec ? sec.id : "",
        anchor: sec ? ("#" + sec.id) : "",
        sectionTitle: title,
        text: cut(text, 900),
      });
    });
    scored.sort(function (a, b) { return b.score - a.score || a.order - b.order; });
    return scored.slice(0, 6);
  }
  function searchPayload(matches) {
    return matches.map(function (m, i) {
      return { index: i, section: m.section, anchor: m.anchor, sectionTitle: m.sectionTitle, text: m.text };
    });
  }
  function ensureGlobalSearchPanel() {
    if (searchPanel) return searchPanel;
    searchPanel = document.createElement("div");
    searchPanel.className = "nb-search-panel";
    searchPanel.setAttribute("aria-hidden", "true");
    searchPanel.setAttribute("inert", "");
    searchPanel.innerHTML =
      '<form class="nb-search-form">' +
        '<input id="nbGlobalSearchInput" type="text" autocomplete="off" placeholder="问这本书：比如动效是怎么设计出来的？">' +
        '<button class="nb-search-go" type="submit" aria-label="提问">↵</button>' +
        '<button class="nb-search-close" type="button" aria-label="关闭">×</button>' +
      '</form>' +
      '<div class="nb-search-output" aria-live="polite"></div>';
    document.body.appendChild(searchPanel);
    searchPanel.querySelector(".nb-search-close").addEventListener("click", closeGlobalSearch);
    searchPanel.querySelector(".nb-search-form").addEventListener("submit", function (e) {
      e.preventDefault();
      submitGlobalSearch();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && searchPanel && searchPanel.classList.contains("nb-show")) {
        e.preventDefault();
        closeGlobalSearch();
      }
    });
    return searchPanel;
  }
  function setupGlobalSearch() {
    ensureGlobalSearchPanel();
    var btn = document.getElementById("nbSearchBtn");
    if (!btn || btn.__nbSearchBound) return;
    btn.__nbSearchBound = true;
    btn.addEventListener("click", function () {
      if (searchPanel.classList.contains("nb-show")) closeGlobalSearch();
      else openGlobalSearch();
    });
  }
  function openGlobalSearch() {
    ensureGlobalSearchPanel();
    hideFloat();
    searchPanel.removeAttribute("inert");
    searchPanel.setAttribute("aria-hidden", "false");
    searchPanel.classList.add("nb-show");
    var btn = document.getElementById("nbSearchBtn");
    if (btn) btn.classList.add("is-active");
    setTimeout(function () {
      var input = searchPanel.querySelector("#nbGlobalSearchInput");
      if (input) input.focus();
    }, 40);
  }
  function closeGlobalSearch() {
    if (!searchPanel) return;
    if (searchCtrl) { try { searchCtrl.abort(); } catch (e) {} searchCtrl = null; }
    searchPanel.classList.remove("nb-show", "nb-loading", "nb-search-committing");
    var out = searchPanel.querySelector(".nb-search-output");
    if (out) out.classList.remove("nb-search-committing");
    searchPanel.setAttribute("aria-hidden", "true");
    searchPanel.setAttribute("inert", "");
    var btn = document.getElementById("nbSearchBtn");
    if (btn) btn.classList.remove("is-active");
  }
  function renderSearchLoading(question, matches) {
    var out = searchPanel.querySelector(".nb-search-output");
    out.innerHTML =
      '<div class="nb-search-thinking">' +
        '<span>正在翻书</span><i></i><i></i><i></i>' +
      '</div>' +
      (matches.length ? '<p class="nb-search-hint">先找到了 ' + matches.length + ' 处可能相关的位置。</p>' : '<p class="nb-search-hint">书里暂时没有明显命中，我会按项目常识补充。</p>');
    searchPanel.classList.add("nb-loading");
  }
  async function submitGlobalSearch() {
    var input = searchPanel.querySelector("#nbGlobalSearchInput");
    var question = input ? input.value.trim() : "";
    if (!question) return;
    if (searchCtrl) { try { searchCtrl.abort(); } catch (e) {} searchCtrl = null; }
    searchMatches = collectSearchMatches(question);
    renderSearchLoading(question, searchMatches);
    if (STATIC_MODE) {
      renderSearchResult({
        matchType: searchMatches.length ? "partial" : "none",
        jumpIndex: searchMatches.length ? 0 : null,
        jumpTitle: searchMatches[0] ? searchMatches[0].sectionTitle : "",
        question: question,
        answer: searchMatches.length
          ? "静态演示不能调用模型，但我先替你找到了书里可能相关的位置。点下面的按钮可以跳过去继续看。"
          : "静态演示不能调用模型，也没有在当前书里找到明显相关段落。请本地运行服务后再问，我会给你补充解释。",
      });
      return;
    }
    var ctrl = new AbortController();
    searchCtrl = ctrl;
    try {
      var res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ book: BOOK, question: question, matches: searchPayload(searchMatches) }),
        signal: ctrl.signal,
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error && data.error.message ? data.error.message : "搜索失败");
      if (searchCtrl === ctrl) searchCtrl = null;
      data.question = question;
      renderSearchResult(data);
    } catch (err) {
      if (err.name === "AbortError") return;
      searchCtrl = null;
      renderSearchResult({
        matchType: searchMatches.length ? "partial" : "none",
        jumpIndex: searchMatches.length ? 0 : null,
        jumpTitle: searchMatches[0] ? searchMatches[0].sectionTitle : "",
        question: question,
        answer: "模型这次没有接上。我先把书里最可能相关的位置放在下面，你可以跳过去看；也可以换个问法再试一次。\n\n错误：" + (err.message || "搜索失败"),
      });
    }
  }
  function searchTypeLabel(type, hit) {
    if (type === "exact") return "书里写到了";
    if (type === "partial" && hit) return "书里有相关线索";
    return "书里没有明显写到";
  }
  function renderSearchResult(data) {
    searchPanel.classList.remove("nb-loading");
    var type = data && data.matchType ? data.matchType : (searchMatches.length ? "partial" : "none");
    if (["exact", "partial", "none"].indexOf(type) < 0) type = searchMatches.length ? "partial" : "none";
    var jumpIndex = Number.isInteger(data && data.jumpIndex) ? data.jumpIndex : null;
    if ((type === "exact" || type === "partial") && (jumpIndex === null || !searchMatches[jumpIndex]) && searchMatches.length) jumpIndex = 0;
    if (type === "none") jumpIndex = null;
    var hit = jumpIndex !== null ? searchMatches[jumpIndex] : null;
    var answer = (data && data.answer) || "暂时没有生成回答。";
    var input = searchPanel.querySelector("#nbGlobalSearchInput");
    var question = (data && data.question) || (input ? input.value.trim() : "");
    var canInsert = type !== "exact";
    searchLast = {
      type: type,
      jumpIndex: jumpIndex,
      jumpTitle: (data && data.jumpTitle) || (hit && hit.sectionTitle) || "",
      hit: hit,
      question: question,
      answer: answer,
    };
    var out = searchPanel.querySelector(".nb-search-output");
    out.innerHTML =
      '<div class="nb-search-status ' + esc2(type) + '">' +
        '<span>' + esc2(searchTypeLabel(type, hit)) + "</span>" +
        (hit ? '<b>' + esc2(data.jumpTitle || hit.sectionTitle || "相关位置") + "</b>" : "") +
      "</div>" +
      '<div class="nb-search-answer">' + renderMarkdown(answer) + "</div>" +
      (hit || canInsert ? '<div class="nb-search-actions">' +
        (hit ? '<button class="nb-search-jump" type="button" data-jump-index="' + jumpIndex + '">确认跳到这里</button>' : "") +
        (canInsert ? '<button class="nb-search-insert" type="button">插成补充卡</button>' : "") +
      "</div>" : "");
    Array.from(out.querySelectorAll(".nb-search-answer > *")).forEach(function (el, i) {
      el.style.setProperty("--i", i);
      el.classList.add("nb-search-line");
    });
    out.querySelectorAll("[data-jump-index]").forEach(function (btn) {
      btn.addEventListener("click", function () { jumpToSearchMatch(Number(btn.getAttribute("data-jump-index"))); });
    });
    var insertBtn = out.querySelector(".nb-search-insert");
    if (insertBtn) insertBtn.addEventListener("click", function () { insertSearchCard(insertBtn); });
  }
  function currentVisibleBlock() {
    collectBlocks();
    var center = Math.max(120, window.innerHeight * 0.42);
    var best = null;
    var bestScore = Infinity;
    blocks.forEach(function (el) {
      var rect = el.getBoundingClientRect();
      if (rect.bottom < 72 || rect.top > window.innerHeight - 72) return;
      var mid = (Math.max(rect.top, 0) + Math.min(rect.bottom, window.innerHeight)) / 2;
      var score = Math.abs(mid - center);
      if (score < bestScore) { best = el; bestScore = score; }
    });
    return best || blocks[0] || null;
  }
  function resolveSearchInsertTarget() {
    if (searchLast && searchLast.hit && searchLast.hit.el && main.contains(searchLast.hit.el)) return searchLast.hit.el;
    return currentVisibleBlock();
  }
  function searchCardBody(result) {
    var q = norm(result && result.question) || "全局补充";
    var answer = norm(result && result.answer) ? result.answer : "这个点目前还没有生成完整补充。";
    var lead = result && result.type === "partial"
      ? "书里已经有一些线索，我把没有讲透的部分单独补成一张卡。"
      : "书里没有明显写到这个点，我把它作为独立补充放在这里。";
    return ["### " + q, "", "> " + lead, "", answer].join("\n").trim();
  }
  function playSearchInsertMotion(btn, block) {
    if (searchPanel) {
      searchPanel.classList.add("nb-search-committing");
      var out = searchPanel.querySelector(".nb-search-output");
      if (out) {
        out.classList.remove("nb-search-committing");
        void out.offsetWidth;
        out.classList.add("nb-search-committing");
      }
    }
    if (btn) {
      btn.disabled = true;
      btn.classList.add("nb-search-inserting");
      btn.textContent = "插入中";
    }
    if (block) {
      block.classList.remove("nb-search-insert-anchor");
      void block.offsetWidth;
      block.classList.add("nb-search-insert-anchor");
      setTimeout(function () { block.classList.remove("nb-search-insert-anchor"); }, 720);
    }
  }
  function insertSearchCard(btn) {
    if (!searchLast) return;
    var block = resolveSearchInsertTarget();
    if (!block) { toast("没有找到合适的插入位置"); return; }
    playSearchInsertMotion(btn, block);
    var sec = block.closest(".chapter");
    var note = {
      id: "n" + Date.now().toString(36),
      section: sec ? sec.id : "",
      blockText: norm(block.textContent),
      quote: "",
      sectionTitle: sectionTitle(block) || searchLast.jumpTitle || "全局补充",
      question: searchLast.question || "全局补充",
      body: searchCardBody(searchLast),
      promoted: true,
      source: "global-search",
      createdAt: today(),
    };
    notes.push(note);
    persist(note).then(function () {
      var saved = notes.find(function (n) { return n.id === note.id; }) || note;
      applyNotePlacement(saved, { animate: "insert" });
      var card = main.querySelector('.nb-promoted[data-note="' + saved.id + '"]');
      if (card) card.scrollIntoView({ block: "center", behavior: "smooth" });
      setTimeout(closeGlobalSearch, 180);
      toast("已插成补充卡");
    });
  }
  function jumpToSearchMatch(index) {
    var hit = searchMatches[index];
    if (!hit || !hit.el) return;
    hit.el.scrollIntoView({ block: "center", behavior: "smooth" });
    hit.el.classList.remove("nb-search-target");
    void hit.el.offsetWidth;
    hit.el.classList.add("nb-search-target");
    setTimeout(function () { hit.el.classList.remove("nb-search-target"); }, 1400);
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
      '<button id="nbListBtn" title="全部注释">☰</button>' +
      '<span class="nb-divider"></span>' +
      '<button id="nbSearchBtn" title="问这本书" aria-label="问这本书">' + SEARCH_SVG + "</button>";
    document.body.appendChild(nav);
    nav.querySelector("#nbPrev").addEventListener("click", function () { jump(-1); });
    nav.querySelector("#nbNext").addEventListener("click", function () { jump(1); });
    nav.querySelector("#nbListBtn").addEventListener("click", function (e) { viewList(e.target); });
    setupGlobalSearch();
    function jump(delta) {
      if (!anchorMap.length) return;
      var next = (activeIdx() + delta + anchorMap.length) % anchorMap.length;
      var item = anchorMap[next];
      setActive(item.note.id);
      item.el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  // ================= 源码抽屉（书绑定的本地快照浏览） =================
  var sourceDrawer = null, sourceTree = null, sourceCode = null, sourceHead = null, sourceBack = null;
  var sourceActivePath = null;
  var sourceCloseTimer = null;
  var SRC_REF_RE = /([A-Za-z0-9_\-.]+\.(?:py|js|ts|tsx|jsx|mjs|cjs|go|rs|java|rb|php|sh|css|scss|html|json|yml|yaml|toml|vue|svelte)):(\d+)/g;
  var SRC_TOKEN = /(#.*$|\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\b(def|class|return|if|elif|else|for|while|import|from|as|with|try|except|finally|raise|lambda|yield|async|await|function|const|let|var|new|extends|export|import|switch|case|break|continue|not|and|or|is|in|None|True|False|null|undefined|true|false|self|this|fn|impl|pub|struct|enum|match|type|interface)\b/g;

  function snapshotAvailable() {
    return Boolean(CONTEXT.projectId && CONTEXT.sourceSnapshotId);
  }

  function highlightSourceLine(text) {
    return esc2(text).replace(SRC_TOKEN, function (m, comment, str, kw) {
      if (comment) return '<span class="nb-src-comment">' + comment + '</span>';
      if (str) return '<span class="nb-src-string">' + str + '</span>';
      if (kw) return '<span class="nb-src-kw">' + kw + '</span>';
      return m;
    });
  }

  function ensureSourceDrawer() {
    if (sourceDrawer) return sourceDrawer;
    sourceDrawer = document.createElement("div");
    sourceDrawer.className = "nb-source-drawer";
    sourceDrawer.hidden = true;
    sourceDrawer.innerHTML =
      '<div class="nb-source-head">' +
        '<span class="nb-source-path"></span>' +
        '<button type="button" class="nb-source-close" aria-label="关闭源码面板">×</button>' +
      '</div>' +
      '<div class="nb-source-back" hidden></div>' +
      '<div class="nb-source-body">' +
        '<nav class="nb-source-tree" aria-label="源码文件树"></nav>' +
        '<pre class="nb-source-code"><code></code></pre>' +
      '</div>';
    document.body.appendChild(sourceDrawer);
    sourceTree = sourceDrawer.querySelector(".nb-source-tree");
    sourceCode = sourceDrawer.querySelector(".nb-source-code");
    sourceHead = sourceDrawer.querySelector(".nb-source-path");
    sourceBack = sourceDrawer.querySelector(".nb-source-back");
    sourceBack.addEventListener("click", function (event) {
      var chip = event.target.closest("[data-back-chapter]");
      if (!chip) return;
      var el = document.getElementById(chip.getAttribute("data-back-chapter"));
      if (!el) return;
      // 窄屏抽屉是覆盖式，跳回正文前先收起；宽屏泊位式保留同屏
      if (!window.matchMedia("(min-width: 1081px)").matches) toggleSourceDrawer(false);
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      var h = el.querySelector("h2");
      if (h && h.animate) h.animate([{ opacity: 1 }, { opacity: .25 }, { opacity: 1 }], { duration: 900, easing: "ease-in-out" });
    });
    sourceDrawer.querySelector(".nb-source-close").addEventListener("click", function () { toggleSourceDrawer(false); });
    sourceTree.addEventListener("click", function (event) {
      var link = event.target.closest("[data-src-path]");
      if (link) showSourceFile(link.getAttribute("data-src-path"));
    });
    return sourceDrawer;
  }

  function toggleSourceDrawer(show, skipRestore) {
    var drawer = ensureSourceDrawer();
    var next = typeof show === "boolean" ? show : drawer.hidden;
    clearTimeout(sourceCloseTimer);
    if (next) {
      drawer.hidden = false;
      if (!drawer.dataset.loaded) {
        drawer.dataset.loaded = "1";
        renderSourceTree();
      }
      // 重新打开时回到上次看的文件；srcref 跳转自带目标文件，跳过恢复
      if (!skipRestore && sourceActivePath) showSourceFile(sourceActivePath);
      void drawer.offsetWidth; // 强制 reflow，确保过渡从初始态开始
      drawer.classList.add("nb-show");
    } else {
      drawer.classList.remove("nb-show");
      // 等退场动画走完再摘 display，期间再打开由 clearTimeout 兜住
      sourceCloseTimer = setTimeout(function () { drawer.hidden = true; }, 240);
    }
    document.body.classList.toggle("nb-source-open", next);
  }

  function renderSourceTree(activePath) {
    var files = bookFiles || [];
    var dirs = {};
    for (var i = 0; i < files.length; i++) {
      var parts = files[i].path.split("/");
      var top = parts.length > 1 ? parts[0] : "/";
      (dirs[top] = dirs[top] || []).push(files[i]);
    }
    var tops = Object.keys(dirs).sort(function (a, b) {
      if (a === "/") return -1; if (b === "/") return 1; return a.localeCompare(b);
    });
    var html = '<div class="nb-tree-label">源码快照</div>';
    for (var t = 0; t < tops.length; t++) {
      var rows = dirs[tops[t]];
      var open = activePath && rows.some(function (f) { return f.path === activePath; });
      if (tops[t] === "/") {
        html += rows.map(function (f) {
          return '<a class="nb-tree-file' + (f.path === activePath ? " nb-tree-active" : "") + '" data-src-path="' + esc2(f.path) + '">' + esc2(f.path) + '</a>';
        }).join("");
      } else {
        html += '<details class="nb-tree-dir"' + (open ? " open" : "") + '><summary>' + esc2(tops[t]) + '/</summary>' +
          rows.map(function (f) {
            return '<a class="nb-tree-file' + (f.path === activePath ? " nb-tree-active" : "") + '" data-src-path="' + esc2(f.path) + '">' + esc2(f.path.split("/").slice(1).join("/")) + '</a>';
          }).join("") + '</details>';
      }
    }
    sourceTree.innerHTML = html;
  }

  function chapterLabel(ch) {
    var eye = ch.querySelector(".eyebrow");
    var h2 = ch.querySelector("h2");
    var t = (eye ? eye.textContent.trim() + " · " : "") + (h2 ? h2.textContent.trim() : "");
    return t.trim() || ch.id;
  }

  // 反向锚定：源码文件 → 正文哪些章节引用了它（从已 linkify 的 .nb-srcref 收集）
  var sourceBackRefs = {};
  function buildSourceBackIndex() {
    if (!main) return;
    var links = main.querySelectorAll("a.nb-srcref");
    if (!links.length) return;
    var jobs = {};
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var raw = a.getAttribute("data-src-ref");
      var refLine = a.getAttribute("data-src-line");
      var ch = a.closest(".chapter") || a.closest("section[id]");
      if (!raw || !ch) continue;
      (jobs[raw] = jobs[raw] || []).push({ id: ch.id, line: refLine && Number(refLine) > 0 ? refLine : "" });
    }
    loadBookFiles().then(function (files) {
      Object.keys(jobs).forEach(function (raw) {
        var path = matchSourcePath(raw, files);
        if (!path) return;
        var list = sourceBackRefs[path] = sourceBackRefs[path] || [];
        jobs[raw].forEach(function (item) {
          for (var k = 0; k < list.length; k++) {
            if (list[k].id === item.id) {
              // 同章多次引用只留最小行号（DOM 顺序即文档顺序，取首个更省事，但行号取最小更准）
              if (item.line && (!list[k].line || Number(item.line) < Number(list[k].line))) list[k].line = item.line;
              return;
            }
          }
          list.push(item);
        });
      });
    });
  }

  function renderSourceBack(path) {
    if (!sourceBack) return;
    var refs = sourceBackRefs[path] || [];
    if (!refs.length) { sourceBack.hidden = true; sourceBack.innerHTML = ""; return; }
    var chips = "";
    var shown = 0;
    for (var i = 0; i < refs.length && shown < 3; i++) {
      var r = refs[i];
      var el = r.id && document.getElementById(r.id);
      if (!el) continue;
      chips += '<button type="button" class="nb-back-chip" data-back-chapter="' + esc2(r.id) + '" title="跳到正文">' +
        esc2(cut(chapterLabel(el), 18)) +
        (r.line ? '<span class="nb-back-line">:' + esc2(r.line) + "</span>" : "") +
        "</button>";
      shown++;
    }
    if (!shown) { sourceBack.hidden = true; sourceBack.innerHTML = ""; return; }
    if (refs.length > shown) chips += '<span class="nb-back-more">+' + (refs.length - shown) + "</span>";
    sourceBack.hidden = false;
    sourceBack.innerHTML = '<span class="nb-back-label">正文讲到此</span>' + chips;
  }

  async function showSourceFile(path, line) {
    ensureSourceDrawer();
    var loaded = await readFiles([path]);
    var file = null;
    for (var i = 0; i < loaded.length; i++) if (loaded[i].path === path) file = loaded[i];
    if (!file) { toast("源码里没有这个文件：" + path); return; }
    sourceActivePath = path;
    sourceHead.textContent = path;
    renderSourceBack(path);
    renderSourceTree(path);
    var lines = String(file.content || "").split("\n");
    var html = "";
    for (var n = 0; n < lines.length; n++) {
      html += '<div class="nb-src-line' + (line && n + 1 === Number(line) ? " nb-src-line-active" : "") + '"><span class="nb-src-no">' + (n + 1) + '</span><span class="nb-src-text">' + highlightSourceLine(lines[n]) + '</span></div>';
    }
    sourceCode.innerHTML = '<code>' + html + '</code>';
    var target = sourceCode.querySelector(".nb-src-line-active");
    if (target) target.scrollIntoView({ block: "center" });
    else sourceCode.scrollTop = 0;
  }

  function matchSourcePath(path, files) {
    for (var i = 0; i < files.length; i++) if (files[i].path === path) return path;
    var hits = [];
    for (var j = 0; j < files.length; j++) {
      if (files[j].path === path || files[j].path.endsWith("/" + path) || files[j].path.endsWith(path)) hits.push(files[j].path);
    }
    return hits.length === 1 ? hits[0] : null;
  }

  async function resolveSourceRef(path) {
    var files = await loadBookFiles();
    return matchSourcePath(path, files);
  }

  function linkifySourceRefs() {
    if (!snapshotAvailable() || !main) return;
    var walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT, null);
    var nodes = [], n;
    while ((n = walker.nextNode())) {
      if (!SRC_REF_RE.test(n.nodeValue)) continue;
      SRC_REF_RE.lastIndex = 0;
      if (n.parentElement.closest("a, .nb-bubble, .nb-pop, .nb-mini, .nb-promoted, .nb-files-list, mark")) continue;
      nodes.push(n);
    }
    for (var i = 0; i < nodes.length; i++) splitSourceRefNode(nodes[i]);
  }

  function splitSourceRefNode(node) {
    var text = node.nodeValue;
    SRC_REF_RE.lastIndex = 0;
    var match, last = 0, frag = document.createDocumentFragment(), made = false;
    while ((match = SRC_REF_RE.exec(text))) {
      made = true;
      if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      var a = document.createElement("a");
      a.className = "nb-srcref";
      a.setAttribute("data-src-ref", match[1]);
      a.setAttribute("data-src-line", match[2]);
      a.textContent = match[0];
      a.title = "在源码抽屉中查看";
      frag.appendChild(a);
      last = match.index + match[0].length;
    }
    if (!made) return;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }

  function setupSourceDrawer() {
    if (!snapshotAvailable()) return;
    var topbar = document.querySelector(".shelf-topbar");
    var entry = document.createElement("button");
    entry.type = "button";
    entry.className = "nb-source-toggle";
    entry.setAttribute("aria-label", "打开源码面板");
    entry.textContent = "源码";
    entry.addEventListener("click", function () { toggleSourceDrawer(); });
    if (topbar) topbar.appendChild(entry);
    else {
      entry.classList.add("nb-source-fab");
      document.body.appendChild(entry);
    }
    main.addEventListener("click", function (event) {
      var ref = event.target.closest(".nb-srcref");
      if (!ref) return;
      event.preventDefault();
      var raw = ref.getAttribute("data-src-ref");
      var line = ref.getAttribute("data-src-line");
      resolveSourceRef(raw).then(function (resolved) {
        if (resolved) { toggleSourceDrawer(true, true); showSourceFile(resolved, line); }
        else toast("快照里找不到 " + raw);
      });
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !previewCard) hidePreview();
      if (event.key !== "Escape" || !sourceDrawer || sourceDrawer.hidden) return;
      toggleSourceDrawer(false);
    });
    loadBookFiles().then(function () {
      linkifySourceRefs();
      buildSourceBackIndex();
    });
    setupSourcePreview();
  }

  // ================= 引用速览：hover 文件:行号 浮出代码小卡（点击仍进抽屉） =================
  var previewCard = null, previewAnchor = null, previewTimer = null, previewSeq = 0;
  var previewCache = {};

  function drawerOpen() {
    return Boolean(sourceDrawer && !sourceDrawer.hidden);
  }

  function hidePreview() {
    clearTimeout(previewTimer);
    previewTimer = null;
    previewAnchor = null;
    previewSeq++;
    if (!previewCard) return;
    var c = previewCard;
    previewCard = null;
    c.classList.remove("nb-show");
    setTimeout(function () { c.remove(); }, 180);
  }

  function positionPreview() {
    if (!previewCard || !previewAnchor) return;
    var r = previewAnchor.getBoundingClientRect();
    var w = previewCard.offsetWidth || 440;
    var h = previewCard.offsetHeight || 200;
    var left = Math.max(12, Math.min(r.left, window.innerWidth - w - 14));
    var top = r.bottom + 8;
    if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 8);
    previewCard.style.left = left + "px";
    previewCard.style.top = top + "px";
  }

  async function previewFileLines(path) {
    if (previewCache[path]) return previewCache[path];
    var loaded = await readFiles([path]);
    var file = null;
    for (var i = 0; i < loaded.length; i++) if (loaded[i].path === path) file = loaded[i];
    if (!file) return null;
    var lines = String(file.content || "").split("\n");
    if (Object.keys(previewCache).length > 12) previewCache = {}; // 简单上限，防长会话内存膨胀
    previewCache[path] = lines;
    return lines;
  }

  async function openPreview(anchor) {
    var seq = ++previewSeq;
    var raw = anchor.getAttribute("data-src-ref");
    var line = Number(anchor.getAttribute("data-src-line")) || 0;
    var path = await resolveSourceRef(raw);
    if (seq !== previewSeq || !path || previewAnchor !== anchor || drawerOpen()) return;
    var lines = await previewFileLines(path);
    if (seq !== previewSeq || !lines || previewAnchor !== anchor || drawerOpen()) return;
    var card = document.createElement("div");
    card.className = "nb-src-preview";
    var start = Math.max(1, line - 6);
    var end = Math.min(lines.length, line ? line + 8 : 24);
    if (start > end) {
      // 引用行号超出快照（压缩骨架文件比真实源码短），落到文件尾部
      end = lines.length;
      start = Math.max(1, end - 14);
    }
    var html = '<div class="nb-src-preview-head"><span>' + esc2(path) + (line ? ":" + line : "") + "</span></div><pre>";
    for (var n = start; n <= end; n++) {
      html += '<div class="nb-src-line' + (line && n === line ? " nb-src-line-active" : "") + '"><span class="nb-src-no">' + n + '</span><span class="nb-src-text">' + highlightSourceLine(lines[n - 1] || "") + "</span></div>";
    }
    html += "</pre>";
    card.innerHTML = html;
    document.body.appendChild(card);
    previewCard = card;
    positionPreview();
    // 刚挂载时 offsetHeight 可能还是 0，钳位不生效——下一帧布局稳定后再校一次
    requestAnimationFrame(positionPreview);
    void card.offsetWidth;
    card.classList.add("nb-show");
  }

  function setupSourcePreview() {
    if (!snapshotAvailable() || !main) return;
    main.addEventListener("mouseover", function (e) {
      var a = e.target.closest("a.nb-srcref");
      if (!a || a === previewAnchor || drawerOpen()) return;
      hidePreview();
      previewAnchor = a;
      previewTimer = setTimeout(function () { openPreview(a); }, 380);
    });
    main.addEventListener("mouseout", function (e) {
      var a = e.target.closest("a.nb-srcref");
      if (!a || a !== previewAnchor) return;
      if (e.relatedTarget && a.contains(e.relatedTarget)) return;
      hidePreview();
    });
    // 点击进抽屉，速览即撤
    main.addEventListener("click", function (e) {
      if (e.target.closest("a.nb-srcref")) hidePreview();
    });
    window.addEventListener("scroll", function () {
      if (!previewCard) return;
      requestAnimationFrame(positionPreview);
    }, { passive: true });
  }

  // ================= 启动 =================
  setupSelection();
  setupClickOpen();
  setupDismiss();
  setupNav();
  buildBubble();
  setupSourceDrawer();
  fetch(projectNotesPath())
    .then(function (r) { if (!r.ok) throw new Error("static"); return r.json(); })
    .then(function (list) { notes = list || []; refreshAll(); })
    .catch(function () {
      STATIC_MODE = true;
      var loadFromLocalStorage = function () {
        try { notes = JSON.parse(localStorage.getItem(localNotesKey()) || "[]"); } catch (e) { notes = []; }
        refreshAll();
        toast("静态演示：阅读与本地批注可用 · AI 生成请本地运行");
      };
      var saved = null;
      try { saved = localStorage.getItem(localNotesKey()); } catch (e) {}
      if (saved) { try { notes = JSON.parse(saved); } catch (e) { notes = []; } refreshAll(); return; }
      // 首次访问：读随书附带的示例注释
      fetch(CONTEXT.staticNotesUrl || ("data/" + BOOK + ".json"))
        .then(function (r) { if (!r.ok) throw new Error("none"); return r.json(); })
        .then(function (list) { notes = list || []; refreshAll(); })
        .catch(loadFromLocalStorage);
    });
})();
