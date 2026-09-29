/* 知识书架：同一条导入路径，服务端任务状态决定界面。 */
(function () {
  "use strict";
  var form = document.querySelector("[data-project-import]");
  var projects = [];
  var shownProjects = [];
  var catalogQuery = "";
  var catalogSort = "recent";
  var catalogFilter = "all";
  var catalogLimit = 40;
  var searchLimit = 60;
  var pendingRevealProjectId = null;
  var lastProjectPayload = null;
  var arrivedProjects = new Set();
  var pollTimer = null;
  var readingFiles = 0;
  var preparedFiles = null;
  var busy = false;
  var source = "local";
  var flow = null;
  var flowReadSequence = 0;
  var submissionSequence = 0;
  var FLOW_KEY = "shelf-import-flow";
  var DRAFT_KEY = "shelf-import-draft";
  var folderName = "";
  var draftStorageFailed = false;
  var stageCopy = { reading: "正在归集项目源码…", writing: "正在组织内容、撰写章节…", compiling: "正在编排书页、核验源码引用…" };

  function readStored(key) { try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (error) { return null; } }
  function saveFlow() { try { if (flow) localStorage.setItem(FLOW_KEY, JSON.stringify(flow)); else localStorage.removeItem(FLOW_KEY); } catch (error) {} }
  function clearImportDraft() { try { localStorage.removeItem(DRAFT_KEY); draftStorageFailed = false; } catch (error) { draftStorageFailed = true; } }
  function showDraftHint() {
    setStatus(source === "local" && folderName && !preparedFiles ? "已保留导入信息，请重新选择原文件夹“" + folderName + "”后继续。" : "");
  }
  function saveImportDraft() {
    // 文件内容与文件句柄不写浏览器存储；刷新后由用户重新授权选择目录。
    var draft = { name: form.elements.name.value, repo: form.elements.repo.value, source: source, folderName: folderName };
    if (form.elements.readingIntent) draft.readingIntent = form.elements.readingIntent.value;
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); draftStorageFailed = false; }
    catch (error) { draftStorageFailed = true; }
    showDraftHint();
    updateProjectIdentity();
  }
  function restoreImportDraft() {
    var draft = readStored(DRAFT_KEY);
    if (!draft || typeof draft.name !== "string" || typeof draft.repo !== "string" || typeof draft.folderName !== "string" || (draft.source !== "local" && draft.source !== "github")) return;
    form.elements.name.value = draft.name; form.elements.name.dataset.suggested = "false";
    if (form.elements.readingIntent) form.elements.readingIntent.value = draft.readingIntent || "overview";
    form.elements.repo.value = draft.repo; folderName = draft.folderName; setSource(draft.source);
    if (folderName) form.querySelector("[data-folder-label]").textContent = folderName;
    showDraftHint();
  }
  function makeProjectId() { return "p-" + (window.crypto && crypto.randomUUID ? crypto.randomUUID().replaceAll("-", "").slice(0, 16) : Date.now().toString(36) + Math.random().toString(36).slice(2, 9)); }
  async function request(url, options) {
    var response = await fetch(url, Object.assign({ signal: AbortSignal.timeout(90000) }, options || {}));
    var data = await response.json().catch(function () { return null; });
    if (!response.ok) {
      var error = new Error(data && data.error ? data.error.message : "请求没有成功，请稍后重试");
      error.status = response.status;
      error.kind = data && data.error ? data.error.kind : null;
      throw error;
    }
    return data;
  }
  function post(url, body) { return request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }); }
  function setStatus(text, type) {
    var node = form.querySelector("[data-import-status]");
    var warn = draftStorageFailed && (!flow || flow.status === "importing");
    node.textContent = (text || "") + (warn ? (text ? " " : "") + "浏览器无法保存导入草稿，输入仅保留在当前页；刷新前请先导入。" : "");
    node.dataset.state = type || (warn ? "error" : "");
  }
  function setButton(text, disabled) { var button = form.querySelector("[type=submit]"); button.querySelector("span").textContent = text; button.disabled = Boolean(disabled); }
  function mainBookUrl(project) { return (project.isExample ? "/examples/" : "/projects/") + encodeURIComponent(typeof project === "string" ? project : project.id) + "/books/" + encodeURIComponent(project.mainBookId || "main") + "/"; }
  function playBookOpenTransition(trigger, url) {
    if (!url) return;
    if (window.ShelfTransition) return window.ShelfTransition.open(trigger, url);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return window.location.assign(url);
    window.location.assign(url);
  }
  function setSource(next) {
    source = next === "github" ? "github" : "local";
    form.querySelector("[data-local-source]").hidden = source !== "local";
    form.querySelector("[data-github-source]").hidden = source !== "github";
    form.querySelectorAll("[data-source-choice]").forEach(function (node) { node.setAttribute("aria-pressed", String(node.dataset.sourceChoice === source)); });
    showSummary();
  }
  function showSummary() {
    var node = form.querySelector("[data-import-summary]");
    if (source !== "local" || !preparedFiles) { node.textContent = ""; updateProjectIdentity(); return; }
    node.textContent = "将导入 " + preparedFiles.length + " 个文本文件" + (preparedFiles.skipped ? " · 已排除 " + preparedFiles.skipped + " 个文件" : "") + (preparedFiles.truncated ? " · 已达到导入上限，其余文件未包含" : "");
    updateProjectIdentity();
  }
  function updateProjectIdentity() {
    window.dispatchEvent(new CustomEvent('shelf-import-identity', { detail: {
      name: form.elements.name.value.trim(), source: source, repo: form.elements.repo.value.trim(),
      folderName: folderName, summary: form.querySelector('[data-import-summary]').textContent,
      fileCount: preparedFiles ? preparedFiles.length : 0,
    } }));
  }
  function lockFields(locked) { form.querySelectorAll("input,select,[data-source-choice]").forEach(function (node) { node.disabled = locked; }); }
  function showFlow(project, generation) {
    if (!flow || project.id !== flow.projectId) return;
    var state = generation.status === "idle" ? (project.bookCount ? "ready" : "pending") : generation.status;
    var previous = flow.status;
    flow.status = state;
    if (flow.requestError && (state === "ready" || state === "generating" || generation.generationId && generation.generationId !== flow.requestError.generationId)) delete flow.requestError;
    if (generation.generationId) flow.generationId = generation.generationId;
    saveFlow();
    clearImportDraft();
    lockFields(true);
    form.querySelector("[data-import-secondary]").hidden = false;
    form.querySelector("[data-generating]").hidden = state !== "generating";
    if (state === "generating") {
      setButton("正在生成主书", true);
      form.querySelector("[data-generating-stage]").textContent = stageCopy[generation.stage] || "主书正在生成…";
      setStatus("项目已保存。可以先读其他书，回来后会显示最新进度。", "loading");
    } else if (state === "ready") {
      setButton("打开项目主书", false);
      setStatus("主书已准备好，可以开始阅读了。", "success");
    } else if (state === "failed") {
      setButton("重试生成主书", false);
      setStatus(flow.requestError && flow.requestError.message || generation.error || "这次生成中断了。项目已保留，可以重试。", "error");
    } else if (state === "pending") {
      setButton("开始生成主书", false);
      setStatus(flow.requestError && flow.requestError.message || "项目源码已保存，可以直接开始生成主书。", flow.requestError ? "error" : "");
    }
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("shelf-generation-state", { detail: { project: project, generation: generation, previous: previous, state: state } }));
  }
  function addText(parent, tag, value, className) { var node = document.createElement(tag); node.textContent = value; if (className) node.className = className; parent.appendChild(node); return node; }
  function coverColors(project) {
    var fingerprint = project.mainBook && project.mainBook.styleFingerprint;
    if (fingerprint && typeof window !== "undefined" && window.ShelfPreview) return window.ShelfPreview.coverPalette(fingerprint);
    var hash = Array.from(project.id || "").reduce(function (sum, char) { return sum + char.charCodeAt(0); }, 0);
    return { paper: ["#f5f1ea", "#e8f0ed", "#fdf6f1", "#fffdf7"][hash % 4], ink: "#151b1e" };
  }
  function applyCover(node, project) {
    var colors = coverColors(project);
    if (node.style && node.style.setProperty) { node.style.setProperty("--cover-paper", colors.paper); node.style.setProperty("--cover-ink", colors.ink); }
  }
  function openPreview(project, trigger) {
    if (window.ShelfPreview) window.ShelfPreview.open({ project: project, projects: shownProjects, trigger: trigger });
  }
  function makeBookCard(project) {
    var state = project.generationStatus;
    var card = document.createElement("article"); card.className = "shelf-book-item";
    var link = document.createElement("a"); link.className = "shelf-book-card"; link.href = mainBookUrl(project);
    link.setAttribute("data-shelf-focus", "book:" + project.id);
    applyCover(link, project);
    link.setAttribute("aria-label", project.name + "，打开项目主书");
    var content = addText(link, "span", "", "shelf-book-card-content");
    addText(content, "span", "项目手记", "shelf-book-edition");
    addText(content, "span", (project.name || "书").replace(/^[^\p{L}\p{N}]+/u, "").slice(0, 1), "shelf-book-symbol").setAttribute("aria-hidden", "true");
    addText(content, "strong", project.name);
    addText(content, "span", "", "shelf-cover-rule");
    var canRead = Boolean(project.bookCount);
    var waiting = state === "idle" && !canRead;
    if (state === "generating" || state === "failed") link.classList.add("is-" + state);
    if (!canRead) { link.removeAttribute("href"); link.setAttribute("aria-disabled", "true"); }
    else link.addEventListener("click", function (event) { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); playBookOpenTransition(link, link.href); });
    link.addEventListener("keydown", function (event) { if (event.code === "Space" || event.key === " ") { event.preventDefault(); openPreview(project, link); } });
    card.appendChild(link);
    var meta = addText(card, "div", "", "shelf-book-meta");
    addText(meta, "span", project.bookCount > 1 ? "主书 · " + (project.bookCount - 1) + " 本小书" : canRead ? "项目主书" : "源码已保存");
    var preview = addText(meta, "button", "预览 ↗", "shelf-book-preview"); preview.type = "button"; preview.setAttribute("data-preview-project", project.id);
    preview.setAttribute("data-shelf-focus", "preview:" + project.id);
    preview.setAttribute("aria-label", "预览“" + project.name + "”"); preview.addEventListener("click", function () { openPreview(project, preview); });
    if (state === "generating") {
      var progressAction = addText(card, "button", "正在写成主书 · 查看进度", "shelf-book-state shelf-card-retry"); progressAction.type = "button";
      progressAction.addEventListener("click", function () {
        flow = { projectId: project.id, name: project.name, readingIntent: project.readingIntent || "overview", status: "generating" };
        saveFlow(); form.elements.name.value = project.name;
        if (form.elements.readingIntent) form.elements.readingIntent.value = flow.readingIntent;
        window.ShelfLanding?.showGeneration({ focus: true }); updateFlow(); updateProjectIdentity();
      });
    }
    if (state === "failed") addText(card, "span", canRead ? "新版未完成 · 原书可阅读" : "生成未完成 · 可以重试", "shelf-book-state");
    if (state === "failed" || waiting) {
      var retry = addText(card, "button", waiting ? "开始生成主书" : "重试生成", "shelf-card-retry"); retry.type = "button";
      retry.setAttribute("data-shelf-focus", "retry:" + project.id);
      retry.addEventListener("click", async function () {
        retry.disabled = true; retry.textContent = "正在重新开始…";
        try { await post("/api/projects/" + encodeURIComponent(project.id) + "/generation"); await loadProjects(); }
        catch (error) { retry.disabled = false; retry.textContent = "再试一次"; addText(card, "p", error.message, "shelf-card-error"); }
      });
    }
    var coverage = project.sourceCoverage;
    var omitted = coverage && Number(coverage.skippedTooLarge || 0) + Number(coverage.skippedOverBudget || 0) + Number(coverage.skippedUnreadable || 0);
    if (omitted) addText(card, "small", omitted + " 个源码文件未参与生成", "shelf-book-note");
    if (typeof window !== "undefined" && window.ShelfStack) window.ShelfStack.mount(card, project);
    return card;
  }
  function readingTime(project) {
    return (project.books || [{ id: project.mainBookId || "main" }]).reduce(function (time, book) {
      var read = readStored("shelf-reading-" + project.id + "-" + book.id);
      return Math.max(time, read && Number(read.updatedAt) || 0);
    }, 0);
  }
  function renderProjects() {
    var root = document.querySelector("[data-project-list]");
    var focused = document.activeElement && document.activeElement.getAttribute("data-shelf-focus");
    root.replaceChildren();
    if (window.ShelfStack) window.ShelfStack.cleanup();
    var visible = projects.filter(function (project) { return !project.archived; });
    var count = document.querySelector("[data-library-count]");
    if (count) count.textContent = visible.length ? visible.length + " 个项目 · " + visible.reduce(function (sum, p) { return sum + Number(p.bookCount || 0); }, 0) + " 本书" : "等一本新书，也等一个新想法";
    var readTimes = new Map();
    if (catalogFilter === "read") visible.forEach(function (project) { readTimes.set(project.id, readingTime(project)); });
    var candidates = visible.filter(function (project) { return catalogFilter !== "read" || readTimes.get(project.id); });
    candidates.sort(function (a, b) { return catalogSort === "name" ? a.name.localeCompare(b.name, "zh-CN", { numeric: true }) : catalogFilter === "read" ? readTimes.get(b.id) - readTimes.get(a.id) : Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0); });
    var words = catalogQuery.normalize("NFKC").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    var matches = [];
    if (words.length) {
      candidates.forEach(function (project) {
        var books = project.books && project.books.length ? project.books : project.bookCount ? [{ id: project.mainBookId || "main", title: project.name, kind: "main" }] : [];
        books.forEach(function (book) {
          var haystack = (project.name + " " + book.title).normalize("NFKC").toLocaleLowerCase();
          if (words.every(function (word) { return haystack.includes(word); })) matches.push({ project: project, book: book });
        });
        if (!books.length && words.every(function (word) { return project.name.normalize("NFKC").toLocaleLowerCase().includes(word); })) matches.push({ project: project, book: null });
      });
      var matchedIds = new Set(matches.map(function (match) { return match.project.id; }));
      shownProjects = candidates.filter(function (project) { return matchedIds.has(project.id); });
      root.classList.add("is-searching");
      matches.slice(0, searchLimit).forEach(function (match) {
        if (!match.book) {
          var pending = addText(root, "div", "", "shelf-search-result is-pending"); applyCover(pending, match.project);
          addText(pending, "span", (match.project.name || "书").slice(0, 1), "shelf-result-cover").setAttribute("aria-hidden", "true");
          var pendingCopy = addText(pending, "span", "", "shelf-result-copy"); addText(pendingCopy, "strong", match.project.name);
          addText(pendingCopy, "small", match.project.generationStatus === "generating" ? "正在写成主书…" : match.project.generationStatus === "failed" ? "生成未完成 · 可以重试" : "源码已保存 · 等待生成");
          var pendingActions = addText(pending, "span", "", "shelf-search-pending-actions");
          var pendingPreview = addText(pendingActions, "button", "查看状态", "shelf-book-preview"); pendingPreview.type = "button";
          pendingPreview.setAttribute("data-preview-project", match.project.id); pendingPreview.setAttribute("data-shelf-focus", "preview:" + match.project.id);
          pendingPreview.addEventListener("click", function () { openPreview(match.project, pendingPreview); });
          if (match.project.generationStatus !== "generating") {
            var restart = addText(pendingActions, "button", "生成主书", "shelf-card-retry"); restart.type = "button";
            restart.setAttribute("data-shelf-focus", "retry:" + match.project.id);
            restart.addEventListener("click", async function () {
              restart.disabled = true;
              try { await post("/api/projects/" + encodeURIComponent(match.project.id) + "/generation"); await loadProjects(); }
              catch (error) { restart.disabled = false; addText(pendingCopy, "small", error.message); }
            });
          }
          return;
        }
        var link = document.createElement("a"); link.className = "shelf-search-result"; link.href = (match.project.isExample ? "/examples/" : "/projects/") + encodeURIComponent(match.project.id) + "/books/" + encodeURIComponent(match.book.id) + "/";
        link.setAttribute("data-shelf-focus", "search:" + match.project.id + ":" + match.book.id);
        applyCover(link, match.project); addText(link, "span", (match.project.name || "书").slice(0, 1), "shelf-result-cover").setAttribute("aria-hidden", "true");
        var copy = addText(link, "span", "", "shelf-result-copy"); addText(copy, "strong", match.book.title); addText(copy, "small", match.project.name + " · " + (match.book.kind === "exploration" ? "探索小书" : "项目主书"));
        addText(link, "span", "↗", "shelf-result-arrow");
        link.addEventListener("click", function (event) { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); playBookOpenTransition(link, link.href); }); root.appendChild(link);
      });
    } else {
      shownProjects = candidates; root.classList.remove("is-searching");
      candidates.slice(0, catalogLimit).forEach(function (project, index) {
        var card = makeBookCard(project); card.style.setProperty("--book-order", Math.min(index, 8));
        if (arrivedProjects.has(project.id)) card.style.animation = "none";
        arrivedProjects.add(project.id); root.appendChild(card);
      });
    }
    if (root.dataset) { root.dataset.catalogLimit = String(catalogLimit); root.dataset.searchLimit = String(searchLimit); }
    var remaining = words.length ? matches.length - searchLimit : candidates.length - catalogLimit;
    if (remaining > 0) {
      var more = addText(root, "button", "再看 " + Math.min(remaining, words.length ? 60 : 40) + (words.length ? " 个结果" : " 个项目"), "shelf-load-more"); more.type = "button";
      more.addEventListener("click", function () {
        var nextIndex = words.length ? searchLimit : catalogLimit;
        if (words.length) searchLimit += 60; else catalogLimit += 40; renderProjects();
        var next = root.children[nextIndex];
        var nextAction = next && (next.matches && next.matches("a,button") ? next : next.querySelector && next.querySelector("a[href],button"));
        if (nextAction) nextAction.focus({ preventScroll: true });
      });
    }
    var searchStatus = document.querySelector("[data-search-status]");
    if (searchStatus) {
      var bookMatches = matches.filter(function (match) { return match.book; }).length;
      var pendingMatches = matches.length - bookMatches;
      searchStatus.hidden = !words.length;
      searchStatus.textContent = matches.length ? (bookMatches ? "找到 " + bookMatches + " 本书" : "") + (pendingMatches ? (bookMatches ? " · " : "") + pendingMatches + " 个待完成项目" : "") : "没有找到这本书。试试项目名，或小书标题里的几个字。";
    }
    var empty = document.querySelector("[data-library-empty]"); if (empty) empty.hidden = Boolean(visible.length || words.length || catalogFilter === "read");
    if (!candidates.length && catalogFilter === "read" && !words.length) addText(root, "p", "读过的项目会留在这里。从全部项目里翻开一本吧。", "shelf-empty");
    var resume = document.querySelector("[data-resume-book]");
    var last = readStored("shelf-last-read");
    var recent = last && visible.find(function (project) { return project.id === last.projectId && project.bookCount; });
    resume.hidden = !recent;
    if (recent) {
      resume.replaceChildren();
      addText(resume, "span", "", "shelf-resume-spine").setAttribute("aria-hidden", "true");
      var resumeCopy = addText(resume, "span", "", "shelf-resume-copy"); addText(resumeCopy, "small", "上次翻开的那一本"); addText(resumeCopy, "strong", last.title || recent.name);
      var resumeAction = addText(resume, "span", "继续阅读", "shelf-resume-action"); addText(resumeAction, "span", "→");
      var foundBook = (recent.books || []).find(function (book) { return book.id === last.bookId; });
      var lastBook = foundBook ? foundBook.id : recent.mainBookId || "main";
      resume.href = (recent.isExample ? "/examples/" : "/projects/") + encodeURIComponent(recent.id) + "/books/" + encodeURIComponent(lastBook) + "/";
    }
    if (focused) {
      var replacement = Array.from(document.querySelectorAll("[data-shelf-focus]")).find(function (node) { return node.getAttribute("data-shelf-focus") === focused; });
      if (replacement) replacement.focus({ preventScroll: true });
    }
  }
  async function updateFlow(allowDuringSubmit) {
    if (!flow || busy && !allowDuringSubmit) return;
    var current = flow;
    var projectId = current.projectId;
    var generationId = current.generationId || null;
    var sequence = ++flowReadSequence;
    function isCurrent() {
      return flow === current && flow.projectId === projectId && (flow.generationId || null) === generationId && sequence === flowReadSequence;
    }
    try {
      var project = projects.find(function (item) { return item.id === projectId; });
      if (!project) return;
      var data = await request("/api/projects/" + encodeURIComponent(projectId) + "/generation");
      if (!isCurrent()) return;
      showFlow(project, data.generation || {});
    } catch (error) { if (isCurrent()) setStatus("连接暂时中断，恢复后会继续显示项目状态。", "error"); }
  }
  function expandCatalogForProject() {
    if (!pendingRevealProjectId || catalogQuery || catalogFilter !== "all") return false;
    var candidates = projects.filter(function (project) { return !project.archived; });
    candidates.sort(function (a, b) { return catalogSort === "name" ? a.name.localeCompare(b.name, "zh-CN", { numeric: true }) : Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0); });
    var index = candidates.findIndex(function (project) { return project.id === pendingRevealProjectId; });
    if (index < 0) return false; // A completed import may precede its catalog response.
    pendingRevealProjectId = null;
    if (index < catalogLimit) return false;
    catalogLimit = index + 1;
    return true;
  }
  async function loadProjects() {
    clearTimeout(pollTimer);
    try {
      var data = await request("/api/projects?view=shelf", { signal: AbortSignal.timeout(10000) });
      projects = data.projects || [];
      var expandedForArrival = expandCatalogForProject();
      var payload = JSON.stringify(projects);
      if (payload !== lastProjectPayload || expandedForArrival) { renderProjects(); lastProjectPayload = payload; }
      await updateFlow();
      if (projects.some(function (project) { return project.generationStatus === "generating"; })) pollTimer = setTimeout(loadProjects, 2000);
      window.dispatchEvent(new CustomEvent("shelf-projects-loaded", { detail: projects }));
    } catch (error) {
      var root = document.querySelector("[data-project-list]");
      if (!root.children.length) addText(root, "p", "暂时无法连接，正在尝试重新连接…", "shelf-empty");
      if (flow) setStatus("连接暂时中断。恢复后会继续显示任务状态。", "error");
      pollTimer = setTimeout(loadProjects, 5000);
    }
  }
  function resetImport() {
    flowReadSequence++; submissionSequence++;
    readingFiles++; preparedFiles = null; folderName = ""; flow = null; busy = false; saveFlow(); clearImportDraft(); form.reset(); lockFields(false); setSource("local");
    form.querySelector("[data-folder-label]").textContent = "选择项目源码文件夹";
    form.querySelector("[data-generating]").hidden = true; form.querySelector("[data-import-secondary]").hidden = true;
    setStatus(""); setButton("生成项目书", false); form.elements.name.focus();
    window.dispatchEvent(new CustomEvent("shelf-import-reset"));
  }
  if (!form) return;
  form.querySelectorAll("[data-source-choice]").forEach(function (node) { node.addEventListener("click", function () { setSource(node.dataset.sourceChoice); saveImportDraft(); if (source === "github") form.elements.repo.focus(); }); });
  form.elements.repo.addEventListener("input", function () {
    if (!form.elements.name.value || form.elements.name.dataset.suggested === "true") {
      form.elements.name.value = form.elements.repo.value.trim().replace(/\/$/, "").split("/").pop().replace(/\.git$/, ""); form.elements.name.dataset.suggested = "true";
    }
    saveImportDraft();
  });
  form.elements.name.addEventListener("input", function () { form.elements.name.dataset.suggested = "false"; saveImportDraft(); });
  async function prepareDirectory(files) {
    var sequence = ++readingFiles; preparedFiles = null;
    if (!files.length) { showSummary(); showDraftHint(); return; }
    var directory = (files[0].webkitRelativePath || files[0].name).split("/")[0];
    folderName = directory;
    form.querySelector("[data-folder-label]").textContent = directory;
    if (!form.elements.name.value || form.elements.name.dataset.suggested === "true") { form.elements.name.value = directory; form.elements.name.dataset.suggested = "true"; }
    saveImportDraft();
    setButton("正在检查文件…", true); setStatus("正在检查可导入的源码…", "loading");
    try {
      var result = await window.ShelfImport.readDirectoryTextFiles(files);
      if (sequence !== readingFiles) return;
      preparedFiles = result; showSummary();
      setStatus(result.length ? "" : "没有找到可导入的文本文件，请重新选择文件夹。", result.length ? "" : "error");
    } catch (error) { if (sequence === readingFiles) setStatus("文件读取失败，请重新选择文件夹。", "error"); }
    finally { if (sequence === readingFiles) setButton("生成项目书", false); }
  }
  form.elements.folder.addEventListener("change", function () { return prepareDirectory(form.elements.folder.files); });
  var dropArea = form.querySelector('[data-folder-pick]');
  if (dropArea) {
    dropArea.addEventListener('dragover', function (event) { if (!busy && !form.elements.folder.disabled) { event.preventDefault(); dropArea.classList.add('is-dragging'); } });
    dropArea.addEventListener('dragleave', function (event) { if (!dropArea.contains(event.relatedTarget)) dropArea.classList.remove('is-dragging'); });
    dropArea.addEventListener('drop', async function (event) {
      event.preventDefault(); dropArea.classList.remove('is-dragging');
      if (busy || form.elements.folder.disabled) return;
      var dropSequence = ++readingFiles; preparedFiles = null; showSummary();
      setButton('正在接收文件夹…', true); setStatus('正在归集拖入的项目文件…', 'loading');
      try { var dropped = await window.ShelfImport.readDroppedDirectory(event.dataTransfer); if (dropSequence === readingFiles) await prepareDirectory(dropped); }
      catch (error) { if (dropSequence === readingFiles) { setStatus(error.message, 'error'); setButton('生成项目书', false); } }
    });
  }
  if (form.elements.readingIntent) form.querySelectorAll('[name="readingIntent"]').forEach(function (choice) { choice.addEventListener("change", saveImportDraft); });
  form.querySelector("[data-new-import]").addEventListener("click", resetImport);
  form.addEventListener("submit", async function (event) {
    event.preventDefault(); if (busy) return;
    if (flow && flow.status === "ready") return playBookOpenTransition(form, mainBookUrl(flow.projectId));
    busy = true;
    var sequence = ++submissionSequence;
    flowReadSequence++;
    var submittedFlow = flow;
    var retryState = flow && (flow.status === "failed" || flow.status === "pending") ? flow.status : null;
    var attemptedRequest = false;
    function isCurrent() { return sequence === submissionSequence && flow === submittedFlow; }
    function showRequestError(error) {
      var message = error.message || "这次没有成功，输入已保留，请重试。";
      if (retryState && flow) {
        flow.requestError = { message: message, generationId: flow.generationId || null };
        saveFlow();
      }
      setStatus(message, "error"); lockFields(Boolean(retryState));
      setButton(retryState === "failed" ? "重试生成主书" : retryState === "pending" ? "开始生成主书" : "生成项目书", false);
    }
    try {
      if (retryState) {
        delete flow.requestError;
        attemptedRequest = true;
        setButton("正在重新开始…", true);
        var restarted = await post("/api/projects/" + encodeURIComponent(flow.projectId) + "/generation");
        if (!isCurrent()) { await loadProjects(); return; }
        flowReadSequence++;
        var project = projects.find(function (item) { return item.id === flow.projectId; }) || { id: flow.projectId, name: flow.name, bookCount: 0 };
        showFlow(project, restarted.generation || { status: "generating" });
        await loadProjects();
        if (isCurrent()) await updateFlow(true);
        return;
      }
      var name = form.elements.name.value.trim();
      var repo = form.elements.repo.value.trim();
      var readingIntent = form.elements.readingIntent ? form.elements.readingIntent.value : "overview";
      if (!name) { form.elements.name.focus(); throw new Error("给项目起个名字，再开始阅读。"); }
      if (source === "local" && (!preparedFiles || !preparedFiles.length)) throw new Error("请先选择一个包含文本源码的文件夹。");
      if (source === "github" && !repo) { form.elements.repo.focus(); throw new Error("请填入公开 GitHub 仓库地址。"); }
      if (source === "github" && !(/github\.com[/:][A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/.test(repo) || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))) {
        form.elements.repo.focus(); throw new Error("请使用 owner/repository，或完整的 GitHub 仓库地址。");
      }
      if (!flow || flow.source !== source || flow.repo !== repo || flow.name !== name || (flow.readingIntent || "overview") !== readingIntent) flow = { projectId: makeProjectId(), name: name, source: source, repo: repo, readingIntent: readingIntent, status: "importing" };
      submittedFlow = flow;
      delete flow.requestError;
      saveFlow(); lockFields(true); setButton("正在导入项目…", true); setStatus(source === "github" ? "正在读取公开仓库…" : "正在保存项目源码…", "loading");
      attemptedRequest = true;
      var result = await post(source === "github" ? "/api/projects/import-github" : "/api/projects/import", source === "github" ? { projectId: flow.projectId, repo: repo, name: name, readingIntent: readingIntent } : { projectId: flow.projectId, name: name, files: preparedFiles, readingIntent: readingIntent });
      if (!isCurrent()) { await loadProjects(); return; }
      flowReadSequence++;
      flow.projectId = result.project.id; saveFlow();
      showFlow(result.project, result.generation || { status: "ready" });
      await loadProjects();
      if (isCurrent()) await updateFlow(true);
    } catch (error) {
      if (!isCurrent()) return;
      if (error.kind === "import-conflict") {
        // 来源冲突不是丢响应：保留原项目，下一次点击才创建新项目。
        flow = { projectId: makeProjectId(), name: form.elements.name.value.trim(), source: source, repo: form.elements.repo.value.trim(), readingIntent: form.elements.readingIntent ? form.elements.readingIntent.value : "overview", status: "importing" };
        saveFlow(); lockFields(false); setButton("作为新项目导入", false);
        setStatus("这份资料与上一次导入不同，原项目仍保留。请点击“作为新项目导入”继续。", "error");
        return;
      }
      // A definite rejection did not accept this attempt. Looking up the old
      // project would replace quota/auth/validation errors with its old status.
      if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.kind !== "generation-running") {
        showRequestError(error); return;
      }
      // A transport failure may happen after acceptance; recover only this flow.
      var found = attemptedRequest && flow && await request("/api/projects/" + encodeURIComponent(flow.projectId), { signal: AbortSignal.timeout(3000) }).catch(function () { return null; });
      if (!isCurrent()) return;
      if (found) {
        await loadProjects();
        if (isCurrent()) await updateFlow(true);
      } else showRequestError(error);
    } finally {
      if (sequence === submissionSequence) { busy = false; flowReadSequence++; }
    }
  });
  var stored = readStored(FLOW_KEY);
  if (stored && /^[a-z0-9-]+$/.test(stored.projectId || "")) { flow = stored; if (form.elements.readingIntent) form.elements.readingIntent.value = stored.readingIntent || "overview"; form.elements.name.value = stored.name || ""; form.elements.repo.value = stored.repo || ""; setSource(stored.source); lockFields(stored.status !== "importing"); }
  else restoreImportDraft();
  window.addEventListener('shelf-import-open', function () {
    if (!busy && flow && flow.status === 'ready') resetImport();
    updateProjectIdentity();
  });
  window.addEventListener('shelf-workspace-ready', updateProjectIdentity);
  var searchInput = document.querySelector("[data-shelf-search]");
  if (searchInput) {
    searchInput.addEventListener("input", function () { catalogQuery = searchInput.value; searchLimit = 60; renderProjects(); });
    searchInput.addEventListener("keydown", function (event) { if (event.key === "Escape" && catalogQuery) { event.preventDefault(); searchInput.value = ""; catalogQuery = ""; renderProjects(); } });
    document.addEventListener("keydown", function (event) { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !document.querySelector("dialog[open]")) { event.preventDefault(); searchInput.focus(); searchInput.select(); } });
  }
  var sortInput = document.querySelector("[data-shelf-sort]");
  if (sortInput) sortInput.addEventListener("change", function () { catalogSort = sortInput.value; catalogLimit = 40; renderProjects(); });
  document.querySelectorAll("[data-catalog-filter]").forEach(function (button) { button.addEventListener("click", function () {
    catalogFilter = button.dataset.catalogFilter;
    catalogLimit = 40; searchLimit = 60;
    document.querySelectorAll("[data-catalog-filter]").forEach(function (item) { item.setAttribute("aria-pressed", String(item === button)); }); renderProjects();
  }); });
  window.addEventListener("pageshow", function () { document.body.classList.remove("shelf-is-opening-book"); document.querySelectorAll(".is-opening").forEach(function (node) { node.classList.remove("is-opening"); }); });
  window.addEventListener("shelf-reveal-project", function (event) {
    var projectId = event.detail && event.detail.projectId;
    if (typeof projectId !== "string" || !/^[a-z0-9-]+$/.test(projectId)) return;
    pendingRevealProjectId = projectId;
    if (expandCatalogForProject()) renderProjects();
  });
  window.addEventListener("shelf-restore-catalog", function (event) {
    var state = event.detail || {};
    catalogLimit = Math.max(40, Math.min(10000, Number(state.catalogLimit) || 40));
    searchLimit = Math.max(60, Math.min(10000, Number(state.searchLimit) || 60));
    renderProjects();
  });
  window.addEventListener("online", loadProjects);
  window.addEventListener("shelf-library-changed", loadProjects);
  document.querySelectorAll("[data-reveal]").forEach(function (node) { node.classList.add("is-visible"); });
  loadProjects();
}());
