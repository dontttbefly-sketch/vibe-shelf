/* 知识书架 · 旁注层逻辑（叠加在原书脚本之上，不改变原书正文结构） */
(function () {
  "use strict";
  var main = document.querySelector(".book-main");
  if (!main) return;

  var BOOK = window.SHELF_BOOK || "default"; // 由 build.mjs 注入；书名决定注释存到 data/<书名>.json
  var notes = [];
  var blocks = [];
  var anchorMap = [];
  var activeId = null;
  var pending = null;   // { section, sectionTitle, blockText, quote }
  var thinkTimer = null;
  var closeTimer = null;
  var explainSeq = 0;
  var explainCtrl = null;
  var resultState = null;        // 当前结果视图 { existingId, question, body, editing, promoted, quote, sectionTitle }
  var resultReachedBottom = false;
  var subchip = null;
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
      '<button class="nb-pen" id="nbPen" title="修改" hidden>✎</button>' +
      '<button class="nb-close" id="nbClose">×</button></div>' +
      '<div class="nb-bubble-body" id="nbBody"></div>';
    document.body.appendChild(bubble);
    bubbleBody = bubble.querySelector("#nbBody");
    bubbleTitle = bubble.querySelector("#nbTitle");
    bubble.querySelector("#nbClose").addEventListener("click", closeBubble);
    bubble.querySelector("#nbPen").addEventListener("click", function () { toggleEdit(); });
    bubbleBody.addEventListener("scroll", function () {
      if (bubbleAtBottom()) resultReachedBottom = true;
    });
    bubbleBody.addEventListener("mouseup", handleNoteMouseup);
    document.addEventListener("mousedown", function (e) {
      if (subchip && !subchip.contains(e.target)) hideSubchip();
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeBubble(); });
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
  function setPenVisible(on) {
    if (!bubble) return;
    var pen = bubble.querySelector("#nbPen");
    if (pen) pen.hidden = !on;
  }
  function closeBubble(point) {
    if (!bubble) { resetBubbleState(); return; }
    viewToken++;
    // 新注释结果态：滑到底 = 认可 → 自动保存；否则丢弃不保存
    if (resultState && !resultState.existingId) {
      var rs = resultState;
      resultState = null;
      if (resultReachedBottom || bubbleAtBottom()) {
        saveNote(null, rs.question, rs.body, false);
      }
    }
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
  function startThink() {
    var lines = ["读懂你圈出的这句话", "往回翻它所在的那一段", "想起相关的前端知识", "挑一个贴切的例子", "组织成一段解释"];
    var think = bubbleBody.querySelector(".nb-think");
    if (!think) return;
    think.innerHTML =
      '<div class="nb-think-window"><div class="nb-think-track"></div></div>' +
      '<div class="nb-think-dots"><i></i><i></i><i></i></div>';
    var track = think.querySelector(".nb-think-track");
    function lineEl(t) {
      var d = document.createElement("div");
      d.className = "nb-think-line";
      d.textContent = t;
      return d;
    }
    track.appendChild(lineEl(lines[0]));
    track.appendChild(lineEl(lines[1]));
    track.appendChild(lineEl(lines[2]));
    var pi = 3;
    var lh = track.querySelector(".nb-think-line").getBoundingClientRect().height;
    thinkTimer = setInterval(function () {
      track.style.transition = "transform .6s cubic-bezier(.45,0,.2,1)";
      track.style.transform = "translateY(-" + lh + "px)";
      setTimeout(function () {
        track.removeChild(track.firstChild);
        track.appendChild(lineEl(lines[pi % lines.length]));
        pi++;
        track.style.transition = "none";
        track.style.transform = "translateY(0)";
        void track.offsetWidth;
        track.style.transition = "";
      }, 610);
    }, 1150);
  }
  function stopThink() { if (thinkTimer) { clearInterval(thinkTimer); thinkTimer = null; } }

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
  function viewAsk() {
    viewToken++;
    openBubble(titleFor(pending.quote, "补注释"));
    bubbleBody.innerHTML =
      '<div class="nb-ask">' +
      '<textarea id="nbQ" placeholder="哪里没懂？"></textarea>' +
      '<div class="nb-row"><button class="nb-btn primary nb-go" id="nbGo">解释</button></div>' +
      "</div>";
    var ta = bubbleBody.querySelector("#nbQ");
    var btn = bubbleBody.querySelector("#nbGo");
    ta.focus();
    function submit() {
      var q = ta.value.trim() || (pending.quote ? "这几个字是什么意思" : "这一段我没看懂");
      doExplain(q);
    }
    btn.addEventListener("click", submit);
    ta.addEventListener("input", function () {
      if (ta.value.trim()) { btn.classList.add("is-enter"); btn.textContent = "↵"; }
      else { btn.classList.remove("is-enter"); btn.textContent = "解释"; }
    });
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
    viewLoading();
    setProcessing(true);
    var seq = ++explainSeq;
    var ctrl = new AbortController();
    explainCtrl = ctrl;
    var t = setTimeout(function () { ctrl.abort(); }, 120000);
    try {
      var res = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quote: pending.quote || "",
          question: question,
          sectionTitle: pending.sectionTitle || "",
          blockText: pending.blockText || "",
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
    viewToken++;
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
    paintResult();
  }

  function currentBody() {
    var s = resultState;
    if (!s) return "";
    if (s.editing) {
      var ta = bubbleBody.querySelector("#nbEdit");
      if (ta) s.body = ta.value;
    }
    return s.body;
  }

  function paintResult() {
    var s = resultState;
    if (!s) return;
    var isNew = !s.existingId;
    var bodyHtml = s.editing
      ? '<textarea id="nbEdit" style="width:100%;min-height:220px;resize:vertical;box-sizing:border-box;font:inherit;font-size:14px;line-height:1.7;padding:11px 13px;border:1px solid var(--line-strong);border-radius:13px;background:var(--paper);color:var(--ink);outline:none">' + esc2(s.body) + "</textarea>"
      : '<div class="nb-note-body">' + renderMarkdown(s.body) + "</div>";
    bubbleBody.innerHTML =
      bodyHtml +
      '<div class="nb-row">' +
      (isNew ? '<button class="nb-btn primary" id="nbSave">保存</button>' : "") +
      '<button class="nb-icon-btn" id="nbPromote" data-tip="' + (isNew ? "晋升为正文" : (s.promoted ? "撤销晋升" : "晋升为正文")) + '">' + (s.promoted ? BOOKMARK_SVG_FILLED : BOOKMARK_SVG) + "</button>" +
      (isNew ? "" : '<button class="nb-icon-btn danger" id="nbDelete" data-tip="删除">' + TRASH_SVG + "</button>") +
      "</div>" +
      '<button class="nb-more" id="nbMore" title="在末尾补充">＋</button>';

    if (isNew) {
      bubbleBody.querySelector("#nbSave").addEventListener("click", function () {
        saveNote(null, s.question, currentBody(), false);
      });
    }
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
    bubbleBody.querySelector("#nbMore").addEventListener("click", function () { toggleSubbox("append", ""); });
  }

  function toggleEdit() {
    var s = resultState;
    if (!s) return;
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

  function toggleSubbox(mode, selection) {
    var old = bubbleBody.querySelector(".nb-subbox");
    if (old) { old.remove(); return; }
    var s = resultState;
    if (!s) return;
    var label = mode === "append" ? "在末尾补充" : "修改选中的这段话";
    var selHint = (mode === "edit" && selection) ? "已选中「" + cut(norm(selection), 24) + "」" : "";
    var box = document.createElement("div");
    box.className = "nb-subbox";
    box.innerHTML =
      '<div class="nb-subbox-tag">' + esc2(label) + (selHint ? " · " + esc2(selHint) : "") + "</div>" +
      '<textarea class="nb-subbox-ta" placeholder="让它再讲讲 / 补充点什么"></textarea>' +
      '<div class="nb-subbox-actions"><button class="nb-subbox-go">↵</button></div>';
    var more = bubbleBody.querySelector("#nbMore");
    if (more) bubbleBody.insertBefore(box, more);
    else bubbleBody.appendChild(box);
    var ta = box.querySelector(".nb-subbox-ta");
    var go = box.querySelector(".nb-subbox-go");
    ta.focus();
    function submit() {
      var v = ta.value.trim();
      if (!v) return;
      followup(mode, selection, v);
    }
    go.addEventListener("click", submit);
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); submit(); }
    });
  }

  async function followup(mode, selection, instruction) {
    var s = resultState;
    if (!s) return;
    var box = bubbleBody.querySelector(".nb-subbox");
    var go = box ? box.querySelector(".nb-subbox-go") : null;
    if (box) box.classList.add("nb-sub-loading");
    if (go) go.disabled = true;
    try {
      var res = await fetch("/api/followup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: mode, selection: selection, instruction: instruction,
          context: s.body, quote: s.quote, sectionTitle: s.sectionTitle, question: s.question,
        }),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error && data.error.message ? data.error.message : "修改失败");
      s.body = data.content;
      resultReachedBottom = false;
      paintResult();
      if (s.existingId) updateExisting();
      if (bubbleAtBottom()) resultReachedBottom = true;
    } catch (err) {
      if (box) box.classList.remove("nb-sub-loading");
      if (go) go.disabled = false;
      toast(err.message);
    }
  }

  function hideSubchip() {
    if (!subchip) return;
    var c = subchip;
    subchip = null;
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
      if (el.closest(".nb-subbox") || el.closest("#nbEdit")) return;
      var text = sel.toString().trim();
      if (!text || text.length > 300) return;
      var range = sel.getRangeAt(0);
      var rect = range.getBoundingClientRect();
      if (!rect || rect.height === 0) return;
      var chip = document.createElement("button");
      chip.className = "nb-subchip";
      chip.textContent = "追问这段";
      chip.addEventListener("mousedown", function (e) { e.preventDefault(); });
      chip.addEventListener("click", function () {
        hideSubchip();
        toggleSubbox("edit", text);
      });
      document.body.appendChild(chip);
      chip.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - 120)) + "px";
      chip.style.top = Math.min(rect.bottom + 6, window.innerHeight - 40) + "px";
      void chip.offsetWidth;
      chip.classList.add("nb-show");
      subchip = chip;
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
    fetch("/api/notes?book=" + BOOK + "&id=" + encodeURIComponent(id), { method: "DELETE" }).then(function (r) { return r.json(); }).then(function (d) {
      notes = d.notes;
      clearMarkers(id);
      anchorMap = anchorMap.filter(function (x) { return x.note.id !== id; });
      updateNav();
      closeBubble();
      toast("已删除");
    });
  }
  function persist(note) {
    return fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ book: BOOK, note: note }),
    }).then(function (r) { return r.json(); }).then(function (d) { notes = d.notes; });
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
          pending = {
            section: (host.closest(".chapter") || {}).id || "",
            sectionTitle: sectionTitle(host),
            blockText: norm(host.textContent),
            quote: quote,
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
    .then(function (r) { return r.json(); })
    .then(function (list) { notes = list || []; refreshAll(); })
    .catch(function () { refreshAll(); });
})();
