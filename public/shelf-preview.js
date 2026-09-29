/* 按需预览：只读摘要，不加载书页，也不改变阅读位置。 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (!root.ShelfPreview) root.ShelfPreview = Object.assign(api, api.mount(root, root.document));
}(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  function validId(value) { return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value); }
  function bookHref(projectId, bookId, chapterId) {
    if (!validId(projectId) || !validId(bookId)) return null;
    return "/projects/" + projectId + "/books/" + bookId + "/" + (chapterId ? "#" + encodeURIComponent(chapterId) : "");
  }
  function projectBookHref(project, bookId, chapterId) {
    var href = project && bookHref(project.id, bookId || project.mainBookId || "main", chapterId);
    return href && project.isExample ? href.replace("/projects/", "/examples/") : href;
  }
  function hexColor(value) {
    if (typeof value !== "string" || !/^#(?:[a-f0-9]{3}|[a-f0-9]{6})$/i.test(value)) return null;
    value = value.toLowerCase();
    return value.length === 4 ? "#" + value.slice(1).split("").map(function (digit) { return digit + digit; }).join("") : value;
  }
  function rgb(value) { return value.slice(1).match(/../g).map(function (pair) { return parseInt(pair, 16); }); }
  function luminance(value) {
    return rgb(value).map(function (number) { number /= 255; return number <= .04045 ? number / 12.92 : Math.pow((number + .055) / 1.055, 2.4); })
      .reduce(function (sum, number, index) { return sum + number * [.2126, .7152, .0722][index]; }, 0);
  }
  function contrast(a, b) { return (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05); }
  function coverPalette(fingerprint) {
    var colors = fingerprint && Array.isArray(fingerprint.colors) ? fingerprint.colors.map(hexColor).filter(Boolean) : [];
    var paper = colors.find(function (color) { return luminance(color) >= .65; }) || "#fffdf7";
    var ink = colors.find(function (color) { return contrast(color, paper) >= 7; }) || "#151b1e";
    var accent = colors.find(function (color) {
      var channels = rgb(color);
      return Math.max.apply(null, channels) - Math.min.apply(null, channels) > 35 && contrast(color, paper) >= 3;
    }) || "#993c1d";
    return { paper: paper, ink: ink, accent: accent };
  }

  function createPreviewCache(loader, options) {
    options = options || {};
    var entries = new Map();
    var now = options.now || Date.now;
    var ttl = options.ttl === undefined ? 60000 : options.ttl;
    var maxEntries = options.maxEntries || 40;
    function invalidate(projectId) {
      entries.forEach(function (entry, key) { if (!projectId || entry.projectId === projectId) entries.delete(key); });
    }
    function load(project) {
      if (!project || !validId(project.id)) return Promise.reject(new Error("无法识别这本书，请刷新书架后重试。"));
      var key = [project.id, project.updatedAt || 0, project.bookCount || 0, project.generationStatus || "", project.mainBookId || "main", project.isExample ? "example" : "private"].join("|");
      var existing = entries.get(key);
      if (existing && now() - existing.createdAt < ttl) return existing.promise;
      var entry = { projectId: project.id, createdAt: now() };
      entry.promise = Promise.resolve().then(function () { return loader(project.id, project); }).then(function (data) {
        if (!data || data.projectId !== project.id) throw new Error("预览信息与这本书不一致，请重试。");
        return data;
      }).catch(function (error) { if (entries.get(key) === entry) entries.delete(key); throw error; });
      entries.set(key, entry);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      return entry.promise;
    }
    return { load: load, invalidate: invalidate };
  }

  // The sequence belongs to the preview session, not the network request.
  // A cached request may finish after switching or closing without repainting.
  function createPreviewSession(load, onChange) {
    var sequence = 0;
    return {
      open: function (project) {
        var ownSequence = ++sequence;
        onChange({ state: "loading", project: project });
        return Promise.resolve().then(function () { return load(project); }).then(function (data) {
          if (ownSequence !== sequence) return { state: "stale" };
          var event = { state: "ready", project: project, data: data };
          onChange(event); return event;
        }, function (error) {
          if (ownSequence !== sequence) return { state: "stale" };
          var event = { state: "error", project: project, error: error };
          onChange(event); return event;
        });
      },
      close: function () { sequence++; onChange({ state: "closed" }); },
    };
  }

  function mount(win, doc) {
    var dialog, panel, cover, title, projectName, coverTitle, summary, chapters, books, status, readLink, retry, previous, next, count, closeButton;
    var projects = [], current = null, trigger = null, triggerProjectId = null, loadingTimer = null;
    var currentPalette = null, closingForNavigation = false;
    var cache = createPreviewCache(async function (projectId, project) {
      var controller = new win.AbortController();
      var timeout = win.setTimeout(function () { controller.abort(); }, 10000);
      try {
        var response = await win.fetch((project.isExample ? "/api/examples/" : "/api/projects/") + projectId + "/preview", { signal: controller.signal, headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(response.status === 404 ? "未找到预览信息，可以直接打开书阅读，或刷新书架后重试。" : "暂时无法读取预览，可以重试或直接打开书。");
        return await response.json();
      } catch (error) {
        if (error.name === "AbortError") throw new Error("读取预览有些慢，可以重试或直接打开书。");
        throw error;
      } finally { win.clearTimeout(timeout); }
    });

    function element(tag, className, text) {
      var node = doc.createElement(tag); if (className) node.className = className;
      if (text !== undefined) node.textContent = text; return node;
    }
    function button(className, text) { var node = element("button", className, text); node.type = "button"; return node; }
    function animate() {
      if (win.matchMedia("(prefers-reduced-motion: reduce)").matches || !panel.animate) return;
      panel.getAnimations().forEach(function (animation) { animation.cancel(); });
      panel.animate([{ opacity: .45, transform: "translateY(5px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 160, easing: "ease-out" });
    }
    function applyPalette(fingerprint) {
      var palette = coverPalette(fingerprint);
      currentPalette = palette;
      dialog.style.setProperty("--sp-cover-paper", palette.paper);
      dialog.style.setProperty("--sp-cover-ink", palette.ink);
      dialog.style.setProperty("--sp-cover-accent", palette.accent);
    }
    function updateNavigation() {
      var index = projects.findIndex(function (project) { return project.id === current.id; });
      count.textContent = projects.length > 1 ? "快速预览 · " + (index + 1) + " / " + projects.length : "快速预览";
      previous.disabled = index <= 0; next.disabled = index < 0 || index >= projects.length - 1;
      previous.hidden = next.hidden = projects.length < 2;
    }
    function move(direction) {
      var index = projects.findIndex(function (project) { return project.id === current.id; });
      var target = projects[index + direction];
      if (target) {
        var focused = doc.activeElement;
        choose(target);
        if ((focused === previous || focused === next) && focused.disabled) (direction > 0 ? previous : next).focus({ preventScroll: true });
      }
    }
    function close() { if (dialog && dialog.open) dialog.close(); }
    function openBook(event, link, bookTitle) {
      if (event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
          link.hasAttribute('download') || link.target && link.target !== '_self' || !win.ShelfTransition) return;
      event.preventDefault();
      var focusKey = 'book:' + current.id;
      var returnTrigger = Array.from(doc.querySelectorAll('[data-shelf-focus]')).find(function (node) { return node.getAttribute('data-shelf-focus') === focusKey; });
      win.ShelfTransition.open(cover, link.href, {
        title: bookTitle || title.textContent, palette: currentPalette,
        returnFocus: focusKey, returnTrigger: returnTrigger || trigger,
        // Next/previous can preview a book past the current catalog page.
        catalogLimit: projects.findIndex(function (project) { return project.id === current.id; }) + 1,
        beforeOpen: function () {
          if (dialog.open) { closingForNavigation = true; session.close(); win.clearTimeout(loadingTimer); dialog.close(); }
          if (win.ShelfStack) win.ShelfStack.closeAll();
        },
      });
    }
    function ensureDialog() {
      if (dialog) return;
      dialog = element("dialog", "shelf-preview");
      dialog.setAttribute("aria-labelledby", "shelfPreviewTitle");
      var toolbar = element("div", "sp-toolbar");
      count = element("p", "sp-label", "快速预览");
      var navigation = element("div", "sp-navigation");
      previous = button("sp-nav", "←"); previous.setAttribute("aria-label", "预览上一本书"); previous.title = "上一本（←）";
      next = button("sp-nav", "→"); next.setAttribute("aria-label", "预览下一本书"); next.title = "下一本（→）";
      closeButton = button("sp-close", "×"); closeButton.setAttribute("aria-label", "关闭预览"); closeButton.title = "关闭预览（Esc）";
      navigation.append(previous, next, closeButton); toolbar.append(count, navigation);
      panel = element("div", "sp-panel");
      cover = element("div", "sp-cover"); cover.setAttribute("aria-hidden", "true");
      cover.appendChild(element("span", "sp-cover-label", "项目主书"));
      coverTitle = element("strong", "sp-cover-title"); cover.appendChild(coverTitle);
      cover.appendChild(element("span", "sp-cover-foot", "知识书架"));
      var content = element("div", "sp-content");
      projectName = element("p", "sp-project-name"); title = element("h2", "sp-title"); title.id = "shelfPreviewTitle";
      title.setAttribute("aria-live", "polite");
      summary = element("p", "sp-summary");
      status = element("p", "sp-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
      retry = button("sp-retry", "重试预览"); retry.hidden = true;
      chapters = element("div", "sp-chapters");
      readLink = element("a", "sp-read", "开始阅读");
      readLink.addEventListener('click', function (event) { openBook(event, readLink); });
      content.append(projectName, title, summary, status, retry, chapters, readLink);
      panel.append(cover, content);
      books = element("div", "sp-books-section"); books.hidden = true;
      dialog.append(toolbar, panel, books); doc.body.appendChild(dialog);
      previous.addEventListener("click", function () { move(-1); });
      next.addEventListener("click", function () { move(1); });
      closeButton.addEventListener("click", close);
      retry.addEventListener("click", function () { cache.invalidate(current.id); choose(current); });
      dialog.addEventListener("cancel", function (event) { event.preventDefault(); close(); });
      dialog.addEventListener("close", function () {
        if (closingForNavigation) { closingForNavigation = false; return; }
        session.close(); win.clearTimeout(loadingTimer);
        var destination = trigger && trigger.isConnected !== false ? trigger : doc.querySelector('[data-preview-project="' + triggerProjectId + '"]');
        if (destination && typeof destination.focus === "function") destination.focus({ preventScroll: true });
      });
      dialog.addEventListener("click", function (event) {
        if (event.target !== dialog) return;
        var rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
      });
      dialog.addEventListener("keydown", function (event) {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
        var selection = win.getSelection && win.getSelection();
        if (selection && String(selection) && dialog.contains(selection.anchorNode)) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); move(event.key === "ArrowLeft" ? -1 : 1); }
      });
    }
    function hasReadingPosition(project) {
      if (project.lastOpenedAt) return true;
      try {
        var record = JSON.parse(win.localStorage.getItem("shelf-reading-" + project.id + "-" + (project.mainBookId || "main")) || "null");
        return record && record.projectId === project.id;
      } catch (error) { return false; }
    }
    function setReading(project, ready) {
      var href = ready && projectBookHref(project, project.mainBookId || "main");
      readLink.hidden = !href;
      if (href) readLink.href = href; else readLink.removeAttribute("href");
      readLink.textContent = hasReadingPosition(project) ? "继续阅读 →" : "开始阅读 →";
    }
    function chapterList(items) {
      var list = element("ol", "sp-chapter-list");
      items.forEach(function (chapter) {
        if (!chapter || typeof chapter.title !== "string") return;
        var item = element("li");
        var link = chapter.id ? element("a", "", chapter.title) : element("span", "", chapter.title);
        if (chapter.id) {
          link.href = projectBookHref(current, current.mainBookId || "main", String(chapter.id));
          link.addEventListener('click', function (event) { openBook(event, link); });
        }
        item.appendChild(link); list.appendChild(item);
      });
      return list;
    }
    function renderReady(data, project) {
      title.textContent = data.title || project.name || "项目主书"; coverTitle.textContent = title.textContent;
      projectName.hidden = projectName.textContent === title.textContent;
      applyPalette(data.styleFingerprint);
      summary.textContent = data.summary || (data.ready ? "这本书暂时没有可预览的摘要，可以直接打开阅读。" : "主书还没有准备好，完成后就可以在这里预览和阅读。");
      setReading(project, data.ready && Boolean(data.readingUrl));
      var list = Array.isArray(data.chapters) ? data.chapters.slice(0, 24) : [];
      if (list.length) {
        chapters.appendChild(element("h3", "sp-section-label", "书中内容"));
        chapters.appendChild(chapterList(list.slice(0, 5)));
        if (list.length > 5) {
          var more = element("details", "sp-more-chapters");
          more.appendChild(element("summary", "", "更多章节 · " + (list.length - 5)));
          var rest = chapterList(list.slice(5)); rest.start = 6; more.appendChild(rest); chapters.appendChild(more);
        }
        if (data.chaptersTruncated) chapters.appendChild(element("p", "sp-status", "这里只展示部分目录，完整内容在书中。"));
      }
      var smallBooks = (Array.isArray(data.books) ? data.books : []).filter(function (book) { return book && book.kind === "exploration" && validId(book.id); }).slice(0, 200);
      if (smallBooks.length) {
        var details = element("details", "sp-small-books");
        details.appendChild(element("summary", "", "这个项目的小书 · " + smallBooks.length + (data.booksTruncated ? "+" : "")));
        var bookList = element("ul", "sp-book-list");
        smallBooks.forEach(function (book) {
          var item = element("li"); var link = element("a", "", book.title || "探索小书");
          link.href = projectBookHref(project, book.id);
          link.addEventListener('click', function (event) { openBook(event, link, book.title || '探索小书'); });
          item.appendChild(link); bookList.appendChild(item);
        });
        details.appendChild(bookList); books.appendChild(details); books.hidden = false;
      }
    }
    var session = createPreviewSession(cache.load, function (event) {
      win.clearTimeout(loadingTimer);
      if (event.state === "closed") return;
      if (event.state === "loading") {
        projectName.textContent = event.project.name || ""; projectName.hidden = true;
        title.textContent = event.project.name || "项目主书"; coverTitle.textContent = title.textContent;
        summary.textContent = ""; status.textContent = ""; retry.hidden = true;
        chapters.replaceChildren(); books.replaceChildren(); books.hidden = true;
        applyPalette(event.project.mainBook && event.project.mainBook.styleFingerprint || event.project.styleFingerprint); setReading(event.project, Boolean(event.project.bookCount));
        panel.setAttribute("aria-busy", "true");
        loadingTimer = win.setTimeout(function () { status.textContent = "正在读取预览…"; }, 140);
      } else {
        panel.setAttribute("aria-busy", "false"); status.textContent = "";
        if (event.state === "ready") renderReady(event.data, event.project);
        else { status.textContent = event.error && event.error.message || "暂时无法读取预览，请重试。"; retry.hidden = false; }
      }
    });
    function choose(project) {
      current = project; updateNavigation(); dialog.scrollTop = 0;
      var promise = session.open(project); animate(); return promise;
    }
    function open(options) {
      options = options || {};
      if (!options.project || !validId(options.project.id)) return Promise.resolve({ state: "error", error: new Error("无法识别这本书") });
      ensureDialog();
      var seen = new Set();
      projects = (Array.isArray(options.projects) ? options.projects : [options.project]).filter(function (project) {
        if (!project || !validId(project.id) || seen.has(project.id)) return false;
        seen.add(project.id); return true;
      });
      if (!seen.has(options.project.id)) projects.unshift(options.project);
      trigger = options.trigger || doc.activeElement;
      triggerProjectId = options.project.id;
      if (!dialog.open) dialog.showModal();
      closeButton.focus({ preventScroll: true });
      return choose(options.project);
    }
    return { open: open, close: close, invalidate: cache.invalidate };
  }
  return { mount: mount, bookHref: bookHref, projectBookHref: projectBookHref, coverPalette: coverPalette, contrast: contrast, createPreviewCache: createPreviewCache, createPreviewSession: createPreviewSession };
}));
