/* 错位叠书：悬停只读，打开仍交给原来的书链接。 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (!root.ShelfStack) root.ShelfStack = api;
}(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  var mounted = new Map(), active = null, cache = null;

  // Separate pointer and focus ownership: leaving the cover for its preview,
  // or leaving with the mouse while a chapter link has focus, must not close it.
  function createHoverIntent(options) {
    var schedule = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
    var enterDelay = options.enterDelay === undefined ? 180 : options.enterDelay;
    var leaveDelay = options.leaveDelay === undefined ? 160 : options.leaveDelay;
    var pointer = false, focus = false, visible = false, suppressed = false, dead = false;
    var enterTimer = null, leaveTimer = null;
    function clearTimers() { cancel(enterTimer); cancel(leaveTimer); enterTimer = leaveTimer = null; }
    function show() {
      enterTimer = null;
      if (dead || suppressed || visible || (!pointer && !focus)) return;
      visible = true; options.open();
    }
    function hide() {
      leaveTimer = null;
      if (!visible) return;
      visible = false; options.close();
    }
    function enter(kind) {
      if (dead) return;
      if (kind === "focus") focus = true; else pointer = true;
      cancel(leaveTimer); leaveTimer = null;
      if (suppressed || visible) return;
      if (kind === "focus") { cancel(enterTimer); enterTimer = null; show(); }
      else if (enterTimer === null) enterTimer = schedule(show, enterDelay);
    }
    function leave(kind) {
      if (kind === "focus") focus = false; else pointer = false;
      if (pointer || focus) return;
      suppressed = false;
      cancel(enterTimer); enterTimer = null;
      if (!dead && visible && leaveTimer === null) leaveTimer = schedule(hide, leaveDelay);
    }
    return {
      enter: enter, leave: leave,
      dismiss: function () { clearTimers(); suppressed = pointer || focus; hide(); },
      destroy: function () { if (dead) return; dead = true; clearTimers(); hide(); },
      isOpen: function () { return visible; },
    };
  }

  function readingLabel(project, data, record) {
    var mainId = project.mainBookId || "main";
    if (!record || record.projectId !== project.id || record.bookId !== mainId ||
        !Number.isFinite(record.scrollY) || record.scrollY < 0) return "未开始阅读";
    var chapter = (Array.isArray(data.chapters) ? data.chapters : []).find(function (item) {
      return item && item.id && item.id === record.chapterId && typeof item.title === "string";
    });
    return chapter ? "读到 · " + chapter.title : "已开始阅读 · 已保存位置";
  }

  function makeCache(win, preview) {
    return preview.createPreviewCache(async function (projectId, project) {
      var controller = new win.AbortController();
      var timeout = win.setTimeout(function () { controller.abort(); }, 10000);
      try {
        var response = await win.fetch((project.isExample ? "/api/examples/" : "/api/projects/") + projectId + "/preview", {
          method: "GET", signal: controller.signal, headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error("暂时无法读取预览，仍可直接打开书。");
        return await response.json();
      } catch (error) {
        if (error.name === "AbortError") throw new Error("读取预览较慢，可以重试或直接打开书。");
        throw error;
      } finally { win.clearTimeout(timeout); }
    });
  }

  function mount(card, project) {
    if (!card || !project || mounted.has(card)) return mounted.get(card);
    var doc = card.ownerDocument, win = doc && doc.defaultView;
    var preview = win && win.ShelfPreview;
    var link = card.querySelector(".shelf-book-card");
    if (!preview || !link || !preview.projectBookHref(project, project.mainBookId || "main")) return null;
    cache = cache || makeCache(win, preview);
    var listeners = [], disposed = false, tracking = false, frame = null, sizeObserver = null;
    var pointerInPreview = false, above = false;
    function listen(target, type, handler) { target.addEventListener(type, handler); listeners.push([target, type, handler]); }
    function element(tag, className, text) {
      var node = doc.createElement(tag); if (className) node.className = className;
      if (text !== undefined) node.textContent = text; return node;
    }
    function readingRecord() {
      try { return JSON.parse(win.localStorage.getItem("shelf-reading-" + project.id + "-" + (project.mainBookId || "main")) || "null"); }
      catch (error) { return null; }
    }
    var panel = element("section", "ss-preview");
    panel.id = "ss-preview-" + project.id;
    panel.setAttribute("aria-label", (project.name || "项目主书") + "的只读预览");
    panel.setAttribute("aria-hidden", "true"); panel.inert = true;
    var sheet = element("div", "ss-preview-sheet");
    sheet.tabIndex = 0; sheet.setAttribute("role", "region"); sheet.setAttribute("aria-label", "预览摘要与目录");
    var label = element("p", "ss-preview-label", "翻开之前");
    var summary = element("p", "ss-preview-summary");
    var chapters = element("ol", "ss-preview-chapters");
    var progress = element("p", "ss-preview-progress");
    var status = element("p", "ss-preview-status"); status.setAttribute("role", "status");
    var actions = element("div", "ss-preview-actions");
    var readLink = element("a", "ss-preview-read", "打开这本书 →");
    readLink.href = preview.projectBookHref(project, project.mainBookId || "main");
    var retry = element("button", "ss-preview-retry", "重试预览"); retry.type = "button"; retry.hidden = true;
    actions.append(readLink, retry);
    sheet.append(label, summary, chapters, progress, status, actions); panel.appendChild(sheet); card.appendChild(panel);
    card.classList.add("ss-book");
    card.setAttribute("data-stack-project", project.id);
    link.setAttribute("aria-controls", panel.id); link.setAttribute("aria-expanded", "false");
    // Cards without a generated book still need a keyboard route to their state.
    if (!link.hasAttribute("href")) link.tabIndex = 0;

    function position() {
      if (frame !== null) win.cancelAnimationFrame(frame);
      frame = null;
      if (disposed || card.isConnected === false) return;
      var rect = card.getBoundingClientRect();
      var panelRect = panel.getBoundingClientRect(), height = panelRect.height || 285;
      var stagger = parseFloat(win.getComputedStyle(card).getPropertyValue("--ss-stagger")) || 0;
      var margin = 16, belowTop = rect.bottom - 6, aboveBottom = rect.top + stagger + 5;
      // Keep the side the reader has already entered. A late, taller response
      // must not move the preview across its cover and strand the pointer/focus.
      if (!pointerInPreview && !panel.contains(doc.activeElement)) {
        above = win.innerHeight - margin - belowTop < height && aboveBottom - margin > win.innerHeight - margin - belowTop;
      }
      var top = above ? aboveBottom - height : belowTop;
      top = Math.max(margin, Math.min(top, win.innerHeight - margin - height));
      var left = Math.max(margin, Math.min(rect.left, win.innerWidth - margin - panelRect.width));
      // The panel always has the same absolute anchor in CSS. Reposition only
      // this overlay with transform; never rewrite card geometry or grid rows.
      card.classList.toggle("ss-preview-above", above);
      panel.style.setProperty("--ss-preview-x", (left - rect.left) + "px");
      panel.style.setProperty("--ss-preview-y", (top - belowTop) + "px");
    }
    function schedulePosition() {
      if (!tracking || frame !== null) return;
      frame = win.requestAnimationFrame(position);
    }
    function startTracking() {
      if (tracking) return;
      tracking = true;
      win.addEventListener("scroll", schedulePosition, { passive: true });
      win.addEventListener("resize", schedulePosition);
      if (win.ResizeObserver) { sizeObserver = new win.ResizeObserver(schedulePosition); sizeObserver.observe(sheet); }
    }
    function stopTracking() {
      tracking = false;
      win.removeEventListener("scroll", schedulePosition);
      win.removeEventListener("resize", schedulePosition);
      if (frame !== null) win.cancelAnimationFrame(frame);
      frame = null;
      if (sizeObserver) sizeObserver.disconnect(); sizeObserver = null;
    }
    function render(event) {
      if (disposed || card.isConnected === false || event.state === "closed") return;
      sheet.setAttribute("aria-busy", event.state === "loading" ? "true" : "false");
      retry.hidden = event.state !== "error";
      if (event.state === "loading") {
        summary.textContent = ""; chapters.replaceChildren(); progress.textContent = "";
        status.textContent = "正在读取这本书的摘要与目录…";
        readLink.hidden = !project.bookCount;
      } else if (event.state === "error") {
        status.textContent = event.error && event.error.message || "暂时无法读取预览，可以重试。";
      } else {
        var data = event.data;
        summary.textContent = data.summary || (data.ready ? "这本书尚无可预览摘要，打开即可阅读正文。" : "主书还在准备中，完成后会在这里显示真实目录。");
        status.textContent = ""; chapters.replaceChildren();
        (Array.isArray(data.chapters) ? data.chapters : []).slice(0, 3).forEach(function (chapter) {
          if (!chapter || typeof chapter.title !== "string") return;
          var item = element("li");
          var target = element(chapter.id && data.ready ? "a" : "span", "", chapter.title);
          if (chapter.id && data.ready) {
            target.href = preview.projectBookHref(project, project.mainBookId || "main", String(chapter.id));
            target.addEventListener('click', function (event) {
              if (event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
                  target.hasAttribute('download') || target.target && target.target !== '_self' || !win.ShelfTransition) return;
              event.preventDefault();
              win.ShelfTransition.open(link, target.href, { title: data.title || project.name, beforeOpen: intent.dismiss });
            });
          }
          item.appendChild(target); chapters.appendChild(item);
        });
        progress.textContent = data.ready ? readingLabel(project, data, readingRecord()) : "主书尚未完成";
        readLink.hidden = !data.ready;
        if (data.styleFingerprint) {
          var palette = preview.coverPalette(data.styleFingerprint);
          link.style.setProperty("--cover-paper", palette.paper); link.style.setProperty("--cover-ink", palette.ink);
        }
      }
      position();
    }
    var session = preview.createPreviewSession(cache.load, render);
    var intent = createHoverIntent({
      setTimeout: win.setTimeout.bind(win), clearTimeout: win.clearTimeout.bind(win),
      open: function () {
        if (disposed || card.isConnected === false) return;
        if (active && active !== intent) active.dismiss();
        active = intent; startTracking();
        card.classList.add("ss-is-previewing"); panel.inert = false;
        panel.setAttribute("aria-hidden", "false"); link.setAttribute("aria-expanded", "true");
        session.open(project);
      },
      close: function () {
        stopTracking(); pointerInPreview = false;
        session.close(); card.classList.remove("ss-is-previewing", "ss-keyboard-preview");
        panel.inert = true; panel.setAttribute("aria-hidden", "true"); link.setAttribute("aria-expanded", "false");
        if (active === intent) active = null;
      },
    });
    function desktopPointer(event) {
      return event.pointerType !== "touch" && win.matchMedia("(hover: hover) and (pointer: fine)").matches;
    }
    listen(card, "pointerenter", function (event) { if (desktopPointer(event)) intent.enter("pointer"); });
    listen(card, "pointerleave", function () { intent.leave("pointer"); });
    listen(panel, "pointerenter", function (event) {
      if (desktopPointer(event)) { pointerInPreview = true; intent.enter("pointer"); }
    });
    listen(panel, "pointerleave", function () { pointerInPreview = false; schedulePosition(); });
    listen(card, "focusin", function (event) {
      if (event.target !== link && !panel.contains(event.target)) return;
      if (event.target === link && !link.matches(":focus-visible")) return;
      card.classList.add("ss-keyboard-preview"); intent.enter("focus");
    });
    listen(card, "focusout", function (event) { if (!card.contains(event.relatedTarget)) intent.leave("focus"); });
    listen(card, "keydown", function (event) {
      if (event.key !== "Escape" || !intent.isOpen()) return;
      event.preventDefault(); event.stopPropagation();
      if (panel.contains(doc.activeElement)) link.focus({ preventScroll: true });
      intent.dismiss();
    });
    // The existing button opens the explicit preview dialog (including touch).
    listen(card, "click", function (event) {
      if (event.target.closest(".shelf-book-preview")) intent.dismiss();
    });
    listen(retry, "click", function () { cache.invalidate(project.id); session.open(project); });
    listen(readLink, "click", function (event) {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (link.hasAttribute("href")) { event.preventDefault(); link.click(); }
    });
    var handle = {
      close: intent.dismiss,
      destroy: function () {
        if (disposed) return;
        disposed = true; stopTracking(); intent.destroy(); session.close();
        listeners.forEach(function (listener) { listener[0].removeEventListener(listener[1], listener[2]); });
        panel.remove(); card.classList.remove("ss-book", "ss-preview-above");
        link.removeAttribute("aria-controls"); link.removeAttribute("aria-expanded"); mounted.delete(card);
      },
    };
    mounted.set(card, handle); return handle;
  }

  function cleanup() { mounted.forEach(function (handle, card) { if (card.isConnected === false) handle.destroy(); }); }
  function closeAll() { mounted.forEach(function (handle) { handle.close(); }); }
  function invalidate(projectId) { if (cache) cache.invalidate(projectId); }
  return { mount: mount, cleanup: cleanup, closeAll: closeAll, invalidate: invalidate, createHoverIntent: createHoverIntent, readingLabel: readingLabel };
}));
