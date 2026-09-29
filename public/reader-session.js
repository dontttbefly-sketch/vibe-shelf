/* 跨次阅读与本项目书目。动态加载，兼容已经编译的书。 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (!root.ShelfReaderSession) {
    root.ShelfReaderSession = api;
    api.mount(root, root.document);
  }
}(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  function assertId(value) {
    if (typeof value !== "string" || !/^[a-z0-9-]+$/.test(value)) throw new Error("无效的项目或书籍标识");
    return value;
  }
  function readingKey(context) {
    return "shelf-reading-" + context.projectId + "-" + context.bookId;
  }
  function canRestore(location) {
    return !location.hash && !new URLSearchParams(location.search || "").has("exploration");
  }
  function validRecord(record, context) {
    return !!record && record.projectId === context.projectId && record.bookId === context.bookId &&
      Number.isFinite(record.scrollY) && record.scrollY >= 0;
  }
  function bookUrl(base, projectId, bookId) {
    return new URL("projects/" + assertId(projectId) + "/books/" + assertId(bookId) + "/", base).href;
  }
  function explorationUrl(base, projectId, session) {
    return bookUrl(base, projectId, session.originBookId || "main") +
      "?exploration=" + encodeURIComponent(assertId(session.id)) + "#shelf-explore";
  }
  function originQuestion(book, session) {
    var messages = Array.isArray(session.messages) ? session.messages : [];
    var index = messages.findIndex(function (message) { return message.id === book.originAnswerMessageId; });
    if (index > 0 && messages[index - 1].role === "user") return String(messages[index - 1].content || "");
    var first = messages.find(function (message) { return message.role === "user"; });
    return first ? String(first.content || "") : "回到来源问题";
  }
  function watchGeneration(win, base, onSettled) {
    var key = "shelf-import-flow";
    function readFlow() {
      try { return JSON.parse(win.localStorage.getItem(key) || "null"); } catch (_) { return null; }
    }
    var pending = readFlow();
    if (!pending || !/^[a-z0-9-]+$/.test(pending.projectId || "") || pending.status !== "generating") return null;
    var timer = null, request = null, sequence = 0, paused = false, settled = false, destroyed = false;
    function sameGeneration(a, b) { return (a.generationId || null) === (b.generationId || null); }
    function schedule(delay) {
      if (paused || settled || destroyed) return;
      win.clearTimeout(timer);
      timer = win.setTimeout(check, delay);
    }
    function isCurrent(own) { return request === own && sequence === own.sequence && !paused && !settled && !destroyed; }
    async function check() {
      timer = null;
      if (paused || settled || destroyed || request) return;
      var own = { sequence: ++sequence, controller: new win.AbortController(), timeout: null };
      request = own;
      own.timeout = win.setTimeout(function () {
        if (!isCurrent(own)) return;
        // Invalidate before aborting: even a fetch/body that ignores cancellation
        // must not publish a late completion or hold up the next retry.
        request = null; sequence++;
        own.controller.abort(); schedule(5000);
      }, 10000);
      try {
        var response = await win.fetch(new URL("api/projects/" + pending.projectId + "/generation", base), { signal: own.controller.signal });
        if (!isCurrent(own)) return;
        if (!response.ok) throw Error("status unavailable");
        var result = await response.json();
        if (!isCurrent(own)) return;
        var generation = result && result.generation;
        if (!generation) return;
        // A newer job for the same project supersedes this watcher. Old records
        // remain compatible only when both sides lack a generation identifier.
        if (!sameGeneration(pending, generation)) { settled = true; return; }
        var status = generation.status;
        if (status !== "ready" && status !== "failed") return;
        // This page may be watching A while another tab has already started B.
        // Preserve that newer flow (and all its fields) instead of writing A back.
        settled = true;
        var latest = readFlow();
        if (latest && latest.projectId === pending.projectId && !sameGeneration(pending, latest)) return;
        if (latest && latest.projectId === pending.projectId && latest.status === "generating") {
          try { win.localStorage.setItem(key, JSON.stringify(Object.assign({}, latest, { status: status }))); } catch (_) {}
        }
        onSettled(pending, status);
      } catch (_) {
        // A temporary failure leaves the task intact for the next timed retry.
      } finally {
        win.clearTimeout(own.timeout);
        if (request === own) { request = null; schedule(5000); }
      }
    }
    function pause() {
      paused = true; sequence++;
      win.clearTimeout(timer); timer = null;
      var own = request; request = null;
      if (own) { win.clearTimeout(own.timeout); own.controller.abort(); }
    }
    function resume() {
      if (!paused || settled || destroyed) return;
      paused = false; schedule(0);
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true; pause();
      win.removeEventListener("pagehide", pause);
      win.removeEventListener("pageshow", resume);
    }
    win.addEventListener("pagehide", pause);
    win.addEventListener("pageshow", resume);
    schedule(2000);
    return { pause: pause, resume: resume, destroy: destroy };
  }
  function mount(win, doc) {
    var context = win.SHELF_CONTEXT;
    var topbar = doc.querySelector("[data-shelf-reader-topbar]");
    if (!context || !context.projectId || !topbar || topbar.querySelector("[data-project-library]")) return;
    context = { projectId: context.projectId, bookId: context.bookId || "main" };
    var script = doc.currentScript;
    var base = new URL(".", script && script.src ? script.src : win.location.href).href;
    var titleEl = topbar.querySelector("[data-shelf-book-title]");
    var title = titleEl ? titleEl.textContent : doc.title;
    var back = topbar.querySelector('[data-shelf-back]');
    if (back) back.href = new URL('index.html#library', base).href;
    var storageWarning = false;
    function element(tag, text, className) {
      var node = doc.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    }
    function storageNotice() {
      if (storageWarning) return;
      storageWarning = true;
      var notice = element("p", "浏览器无法保存阅读位置；本次仍可继续阅读。", "shelf-reading-status");
      notice.setAttribute("role", "status");
      doc.body.appendChild(notice);
      win.setTimeout(function () { notice.remove(); }, 6500);
    }
    var restoreFinished = false;
    var interacted = false;
    var saveTimer;
    ["wheel", "touchstart", "pointerdown", "keydown"].forEach(function (type) {
      win.addEventListener(type, function () { interacted = true; }, { once: true, passive: true });
    });
    function savePosition() {
      if (!restoreFinished) return;
      var chapter = null;
      doc.querySelectorAll(".book-main .chapter[id]").forEach(function (candidate) {
        if (candidate.getBoundingClientRect().top <= 130) chapter = candidate;
      });
      var record = {
        projectId: context.projectId, bookId: context.bookId,
        url: bookUrl(base, context.projectId, context.bookId), title: title,
        chapterId: chapter ? chapter.id : "", scrollY: Math.max(0, win.scrollY || 0),
        chapterOffset: chapter ? -chapter.getBoundingClientRect().top : 0, updatedAt: Date.now(),
      };
      try {
        win.localStorage.setItem(readingKey(context), JSON.stringify(record));
        win.localStorage.setItem("shelf-last-read", JSON.stringify(record));
      } catch (error) { storageNotice(); }
    }
    function restorePosition() {
      if (restoreFinished) return;
      if (!interacted && canRestore(win.location)) {
        var record;
        try { record = JSON.parse(win.localStorage.getItem(readingKey(context)) || "null"); } catch (error) {}
        if (validRecord(record, context)) {
          var chapter = record.chapterId && doc.getElementById(record.chapterId);
          var y = chapter && Number.isFinite(record.chapterOffset)
            ? chapter.getBoundingClientRect().top + win.scrollY + record.chapterOffset : record.scrollY;
          win.scrollTo({ top: Math.max(0, y), behavior: "instant" });
        }
      }
      restoreFinished = true;
      savePosition();
      try {
        var entry = JSON.parse(win.sessionStorage.getItem('shelf-book-entry') || 'null');
        win.sessionStorage.removeItem('shelf-book-entry');
        var header = doc.querySelector('.book-header');
        if (entry && entry.url === win.location.href && Date.now() - entry.at < 60000 && win.scrollY < 100 && header && header.animate && !win.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          header.animate([{ opacity: .6, transform: 'translateY(12px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 280, easing: 'cubic-bezier(.22,1,.36,1)' });
        }
      } catch (_) {}
    }
    function readyToRestore() {
      var ready = doc.fonts && doc.fonts.ready ? doc.fonts.ready : Promise.resolve();
      ready.then(function () { win.requestAnimationFrame(function () { win.requestAnimationFrame(restorePosition); }); });
    }
    if (doc.readyState === "complete") readyToRestore();
    else win.addEventListener("load", readyToRestore, { once: true });
    win.addEventListener("scroll", function () {
      win.clearTimeout(saveTimer);
      saveTimer = win.setTimeout(savePosition, 350);
    }, { passive: true });
    win.addEventListener("pagehide", savePosition);
    doc.addEventListener("visibilitychange", function () { if (doc.visibilityState === "hidden") savePosition(); });

    // 另一项目的成书只提示，不改变当前读本或阅读位置。
    watchGeneration(win, base, function (pendingGeneration, status) {
      var notice = element("p", status === "ready" ? "“" + pendingGeneration.name + "”已成书。" : "“" + pendingGeneration.name + "”生成未完成。", "shelf-reading-status");
      notice.setAttribute("role", "status");
      var destination = element("a", "回书架查看"); destination.href = new URL("index.html#library", base).href;
      notice.appendChild(destination); doc.body.appendChild(notice);
    });

    var trigger = element("button", "本项目", "shelf-project-toggle");
    trigger.type = "button";
    trigger.setAttribute("data-project-library", "");
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", "shelf-project-library");
    topbar.insertBefore(trigger, topbar.querySelector(".nb-source-toggle, [data-theme-toggle]"));

    var panel = element("dialog", undefined, "shelf-project-dialog");
    panel.id = "shelf-project-library";
    panel.setAttribute("aria-labelledby", "shelf-project-title");
    var head = element("div", undefined, "shelf-project-head");
    var heading = element("h2", "本项目");
    heading.id = "shelf-project-title";
    var closeButton = element("button", "×", "shelf-project-close");
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "关闭本项目");
    head.append(heading, closeButton);
    var content = element("div", undefined, "shelf-project-content");
    content.setAttribute("aria-live", "polite");
    panel.append(head, content);
    doc.body.appendChild(panel);
    var requestToken = 0;
    var controller = null;
    function close() {
      requestToken++;
      if (controller) controller.abort();
      controller = null;
      panel.close();
      trigger.setAttribute("aria-expanded", "false");
      trigger.focus();
    }
    closeButton.addEventListener("click", close);
    panel.addEventListener("cancel", function (event) { event.preventDefault(); close(); });
    panel.addEventListener("keydown", function (event) {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    });
    panel.addEventListener("click", function (event) {
      var rect = panel.getBoundingClientRect();
      if (event.target === panel && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) close();
    });
    function link(text, url, detail, current) {
      var row = element("a", undefined, "shelf-project-link");
      row.href = url;
      row.appendChild(element("span", text));
      if (detail) row.appendChild(element("small", detail));
      if (current) row.setAttribute("aria-current", "page");
      return row;
    }
    function section(titleText) {
      var sectionNode = element("section");
      sectionNode.appendChild(element("h3", titleText));
      content.appendChild(sectionNode);
      return sectionNode;
    }
    function sessionTitle(session) {
      var messages = Array.isArray(session.messages) ? session.messages : [];
      var question = messages.find(function (m) { return m.role === "user"; });
      return String(session.title || (question && question.content) || "尚未提问的探索").slice(0, 110);
    }
    function render(view, sessions) {
      content.replaceChildren();
      var books = Array.isArray(view.books) ? view.books : [];
      var project = view.project || {};
      heading.textContent = project.name || "本项目";
      var mainId = project.mainBookId || "main";
      var current = books.find(function (book) { return book.id === context.bookId; });
      if (current && current.kind !== "main") {
        var origin = section("这本书的来处");
        origin.appendChild(link("回到项目主书", bookUrl(base, context.projectId, mainId)));
        var sourceSession = sessions.find(function (s) { return s.id === current.originExplorationId; });
        if (sourceSession) origin.appendChild(link(originQuestion(current, sourceSession).slice(0, 110), explorationUrl(base, context.projectId, sourceSession), "回到来源问题，继续探索"));
        else if (current.originExplorationId) origin.appendChild(link("回到来源问题", explorationUrl(base, context.projectId, { id: current.originExplorationId, originBookId: current.parentBookId || mainId })));
        if (current.parentBookId && current.parentBookId !== mainId) origin.appendChild(link("回到上一本书", bookUrl(base, context.projectId, current.parentBookId)));
      }
      var bookSection = section("项目里的书");
      books.sort(function (a, b) { return (a.id === mainId ? -1 : b.id === mainId ? 1 : 0); });
      books.forEach(function (book) {
        bookSection.appendChild(link(book.title || "未命名的书", bookUrl(base, context.projectId, book.id),
          (book.id === mainId ? "主书" : "探索小书") + (book.id === context.bookId ? " · 正在阅读" : ""), book.id === context.bookId));
      });
      if (!books.length) bookSection.appendChild(element("p", "还没有可阅读的书。"));
      var history = section("探索历史");
      if (!sessions.length) history.appendChild(element("p", "书底提出的新问题会留在这里，随时可以继续。"));
      sessions.forEach(function (session) {
        history.appendChild(link(sessionTitle(session), explorationUrl(base, context.projectId, session), "继续这次探索"));
      });
    }
    async function load() {
      var token = ++requestToken;
      controller = new AbortController();
      content.replaceChildren(element("p", "正在找回这个项目的书和探索…"));
      try {
        var path = "/api/projects/" + encodeURIComponent(context.projectId);
        var responses = await Promise.all([win.fetch(path, { signal: controller.signal }), win.fetch(path + "/explorations", { signal: controller.signal })]);
        if (responses.some(function (response) { return !response.ok; })) throw new Error("暂时无法读取本项目，请检查连接后重试。资料会保留。");
        var values = await Promise.all(responses.map(function (response) { return response.json(); }));
        if (token !== requestToken) return;
        render(values[0], Array.isArray(values[1].sessions) ? values[1].sessions : []);
      } catch (error) {
        if (token !== requestToken || error.name === "AbortError") return;
        content.replaceChildren(element("p", error.message || "暂时无法读取，请稍后重试。"));
        var retry = element("button", "重新读取", "shelf-project-retry");
        retry.type = "button";
        retry.addEventListener("click", load);
        content.appendChild(retry);
      }
    }
    trigger.addEventListener("click", function () {
      if (panel.open) { close(); return; }
      panel.showModal();
      trigger.setAttribute("aria-expanded", "true");
      closeButton.focus();
      load();
    });
  }
  return { readingKey: readingKey, canRestore: canRestore, validRecord: validRecord, bookUrl: bookUrl, explorationUrl: explorationUrl, originQuestion: originQuestion, watchGeneration: watchGeneration, mount: mount };
}));
