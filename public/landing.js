/* Public home and account entry. The existing shelf owns imports and generation. */
(function () {
  "use strict";
  var home = document.querySelector("[data-landing]");
  var library = document.querySelector(".shelf-home");
  if (!home || !library) return;
  var form = document.querySelector("[data-project-import]");
  var accountDialog = document.querySelector("[data-account-dialog]");
  var workspace = document.querySelector("[data-upload-workspace]");
  var account = null;
  var accountPromise;
  var accountTrigger = null;
  var replaying = false;
  var accessPending = false;
  var pendingImport = false;
  var examplesLoading = false;
  var homeScroll = 0;
  var libraryScroll = 0;
  var returnView = 'home', returnTrigger = null;
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  var navigationEpoch = 0;
  var exampleIds = ["pupkit", "learn-claude-code", "llm-evolution-course"];
  // GitHub Pages serves this page with no server behind it: the workspace can be
  // tried in full, generating needs a local run, and the examples come from a
  // snapshot published with the site.
  var staticDemo = Boolean(window.location && /\.github\.io$/i.test(window.location.hostname || ""));
  var staticNotice = "这是 GitHub Pages 上的静态演示，不能生成。把仓库 clone 到本地运行，就能为自己的项目写一本书。";
  var exampleLabels = { pupkit: "前端项目", "learn-claude-code": "Agent 工程", "llm-evolution-course": "AI 架构课程" };
  var exampleGlyphs = { pupkit: "P.", "learn-claude-code": "⌘", "llm-evolution-course": "智" };
  // The right page is the title page of the book being made: the project name
  // and the reader's own focus are set on it as they are typed, nothing invented.
  var identity = {};
  var headings = {
    access: ['你的阅读空间', '让这本书，有自己的归处。', '登录后，把项目、书和阅读时的每一个疑问，留在你的书架。'],
    idle: ['新建项目书', '下一本，写你的项目。', '放进项目，再写下你最想读懂的地方。'],
    pending: ['项目已保存', '这一本，随时可以开写。', '源码已经保存，点“开始生成主书”继续。'],
    generating: ['正在成为你的书', '理解，正在成形。', '阶段随实际任务更新。写书需要一些时间，可以先逛书架。'],
    ready: ['已成书', '这本书，写好了。', '从第一章开始读，疑问留在页边。'],
    failed: ['生成中断', '这次没写完。', '项目和侧重点都还在，可以直接重试。'],
  };
  var bookNotes = { idle: '放好项目就能开始', pending: '项目已保存，随时可以开始', generating: '', ready: '已成书，可以开始读了', failed: '这次没写完，可以重试' };

  function q(selector) { return document.querySelector(selector); }
  function text(selector, value) { var node = q(selector); if (node) node.textContent = value; }
  function visible(selector, show) { var node = q(selector); if (node) node.hidden = !show; }
  function element(tag, className, value) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }
  function safePath(value, fallback) {
    try {
      // Links stay on this site and under its own base path (/vibe-shelf/ on Pages).
      var url = new URL(value, window.location.href), base = new URL(".", window.location.href).pathname;
      if (url.origin === window.location.origin && url.pathname.indexOf(base) === 0 && /^(?:examples|projects)\//.test(url.pathname.slice(base.length))) return url.pathname + url.search + url.hash;
    } catch (error) {}
    return fallback;
  }
  async function json(url) {
    var response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) { var error = new Error("请求失败"); error.status = response.status; throw error; }
    return response.json();
  }
  function isLibraryHash(hash) { return ["#library", "#shelfTitle", "#bookshelf"].includes(hash); }
  function libraryTitle() { return account && account.mode === "public" && !account.authenticated ? "公开案例 · 知识书架" : "我的书架 · 知识书架"; }
  function isWorkspace(view) { return view === 'upload' || view === 'generate'; }
  function pane(view) { return view === 'library' ? library : isWorkspace(view) ? workspace : home; }
  function switchView(view, options) {
    options = options || {};
    var oldView = document.body.dataset.pageView;
    if (oldView !== view) {
      if (oldView === "library") libraryScroll = window.scrollY;
      else if (oldView === 'home') homeScroll = window.scrollY;
    }
    var crossing = isWorkspace(oldView) !== isWorkspace(view);
    var animate = crossing && options.animate && window.ShelfUploadMotion;
    var snapshot = animate ? window.ShelfUploadMotion.capture(pane(oldView), options.trigger || returnTrigger) : null;
    var token = ++navigationEpoch;
    window.ShelfUploadMotion?.cancel();
    home.hidden = view !== 'home';
    library.hidden = view !== 'library';
    if (workspace) workspace.hidden = !isWorkspace(view);
    document.body.dataset.pageView = view;
    var libraryLink = q("[data-library-open]");
    if (view === 'library') libraryLink.setAttribute("aria-current", "page");
    else libraryLink.removeAttribute("aria-current");
    var skip = q(".landing-skip");
    if (skip) skip.href = isWorkspace(view) ? '#uploadTitle' : view === 'library' ? '#shelfTitle' : '#landingTitle';
    visible('[data-upload-back]', isWorkspace(view));
    text('[data-upload-back]', returnView === 'library' ? '返回书架' : '返回首页');
    document.title = view === 'library' ? libraryTitle() : view === 'upload' ? '上传项目 · 知识书架' : view === 'generate' ? '正在成书 · 知识书架' : '知识书架 · 把你的项目，读成一本书';
    if (view !== 'library') window.ShelfStack?.closeAll();
    if (options.restore || crossing) window.scrollTo({ top: isWorkspace(view) ? 0 : view === 'library' ? libraryScroll : homeScroll, behavior: 'instant' });
    function focusTarget() {
      if (token !== navigationEpoch || !options.focus) return;
      var target = options.returnFocus && returnTrigger && returnTrigger.isConnected ? returnTrigger : q(isWorkspace(view) ? '#uploadTitle' : view === 'library' ? '#shelfTitle' : '#landingTitle');
      target?.focus({ preventScroll: true });
    }
    if (animate) window.ShelfUploadMotion.run(isWorkspace(view) ? 'enter' : 'leave', snapshot, pane(view), focusTarget);
    else focusTarget();
    window.dispatchEvent(new CustomEvent('shelf-view-changed', { detail: { view: view } }));
  }
  function writeRoute(hash, replace) {
    var state = isWorkspace(hash.slice(1)) ? { shelfWorkspaceReturn: { view: returnView, homeScroll: homeScroll, libraryScroll: libraryScroll } } : null;
    if (window.location.hash !== hash) history[replace ? 'replaceState' : 'pushState'](state, '', hash || window.location.pathname + window.location.search);
    else if (replace) history.replaceState(state, '', hash || window.location.pathname + window.location.search);
  }
  function showLibrary(options) {
    writeRoute('#library');
    switchView('library', Object.assign({ restore: true }, options || {}));
  }
  function showHome(options) {
    writeRoute('');
    switchView('home', Object.assign({ restore: true }, options || {}));
  }
  function showUpload(options) {
    options = options || {};
    if (isWorkspace(document.body.dataset.pageView)) return;
    returnView = document.body.dataset.pageView === 'library' ? 'library' : 'home';
    if (returnView === 'library') libraryScroll = window.scrollY;
    else homeScroll = window.scrollY;
    returnTrigger = options.trigger || document.activeElement;
    window.dispatchEvent(new CustomEvent('shelf-import-open'));
    var view = form && ['generating', 'failed', 'pending'].includes(form.dataset.launcherState) ? 'generate' : 'upload';
    writeRoute('#' + view);
    switchView(view, Object.assign({ focus: true }, options));
  }
  function showGeneration(options) {
    if (!isWorkspace(document.body.dataset.pageView)) {
      returnView = document.body.dataset.pageView === 'library' ? 'library' : 'home';
      returnTrigger = options && options.trigger || document.activeElement;
      if (returnView === 'library') libraryScroll = window.scrollY;
      else homeScroll = window.scrollY;
    }
    writeRoute('#generate', document.body.dataset.pageView === 'upload');
    switchView('generate', options);
  }
  function backFromUpload() {
    writeRoute(returnView === 'library' ? '#library' : '');
    switchView(returnView, { animate: true, restore: true, focus: true, returnFocus: true });
  }
  function route() {
    var hash = window.location.hash;
    var view = hash === '#uploadTitle' ? (isWorkspace(document.body.dataset.pageView) ? document.body.dataset.pageView : 'upload') : hash === '#upload' ? 'upload' : hash === '#generate' ? 'generate' : isLibraryHash(hash) ? 'library' : 'home';
    var saved = history.state && history.state.shelfWorkspaceReturn;
    if (isWorkspace(view) && saved) {
      returnView = saved.view === 'library' ? 'library' : 'home';
      homeScroll = Number.isFinite(saved.homeScroll) ? saved.homeScroll : 0;
      libraryScroll = Number.isFinite(saved.libraryScroll) ? saved.libraryScroll : 0;
    }
    switchView(view, { restore: true });
    if (window.location.hash === "#examples") q("#examples").scrollIntoView();
  }
  document.querySelectorAll("[data-library-open]").forEach(function (node) {
    node.addEventListener("click", function (event) { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); showLibrary({ focus: true }); });
  });
  document.querySelectorAll("[data-home-open]").forEach(function (node) {
    node.addEventListener("click", function (event) { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); homeScroll = 0; showHome({ focus: true }); });
  });
  document.querySelectorAll("[data-examples-open]").forEach(function (node) {
    node.addEventListener("click", function () { switchView('home'); });
  });
  var browse = q("[data-generation-browse]");
  if (browse) browse.addEventListener("click", function () { showLibrary({ focus: true }); });
  window.addEventListener("hashchange", route);
  window.addEventListener("popstate", route);
  route();
  q('[data-upload-back]')?.addEventListener('click', backFromUpload);
  document.querySelectorAll('[data-import-dismiss]').forEach(function (node) { node.addEventListener('click', function () { showLibrary({ focus: true }); }); });
  window.addEventListener('shelf-import-reset', function () {
    if (workspace) workspace.dataset.phase = 'idle';
    renderHeading(); renderTitlePage();
    if (isWorkspace(document.body.dataset.pageView)) { writeRoute('#upload', true); switchView('upload'); }
  });

  function renderAccount() {
    var state = account || { mode: "unavailable" };
    var publicMode = state.mode === "public";
    var local = state.mode === "local";
    var preview = Boolean(state.preview && state.preview.local);
    var signedIn = publicMode && state.authenticated;
    document.body.dataset.accountMode = state.mode;
    document.body.dataset.authenticated = String(Boolean(signedIn));
    visible("[data-account-identity]", Boolean(signedIn && state.user));
    visible("[data-account-usage]", Boolean(signedIn && state.usage && state.usage.generation));
    visible("[data-account-signin]", Boolean(publicMode && !signedIn && state.login && state.login.configured));
    visible("[data-account-settings]", local || signedIn);
    text("[data-account-settings-label]", local ? "模型设置与本机资料" : "个人资料管理");
    visible("[data-account-logout]", signedIn);
    visible("[data-account-retry]", state.mode === "unavailable");
    text("[data-account-label]", local ? "本机空间" : signedIn ? "账户与用量" : "账户与用量");
    text("[data-account-title]", local ? "这台设备上的书架" : signedIn ? "你的账户与用量" : publicMode ? "为你的项目，留一个位置。" : "暂时连不上你的空间");
    text("[data-account-description]", local ? "当前运行的是本地版本。项目、旁注与探索保存在这台设备，生成使用已配置的模型。" : signedIn ? "项目、旁注与探索保存在你登录后的独立空间。" : publicMode ? "使用 GitHub 登录后，上传自己的项目，生成属于你的定制读本。" : "目前无法确认登录状态。输入仍保留，连接恢复后可以继续。");
    text("[data-account-footnote]", local ? "本地模式不提供跨设备账户同步；模型调用以你的模型服务实际计费为准。" : signedIn ? "主书生成失败会释放成书额度。旁注、探索与小书计入 AI 使用次数，失败尝试也计入；这里不代表付费余额。" : "访客可以直接阅读公开案例。只读取你主动提交的项目。");
    text("[data-storage-note]", local ? "资料保存在本机 · 生成时会将相关源码发送给你配置的模型" : publicMode ? "资料保存在你的账户空间 · 生成时会将相关源码发送给模型" : "生成时会将相关源码发送给已配置的模型。连接恢复后可继续。" );
    text("[data-footer-space]", local ? "当前为本机空间" : signedIn ? "你的项目 · 你的阅读空间" : "从项目出发，向理解生长。");
    if (preview) {
      text('[data-account-label]', '本机体验');
      text('[data-account-description]', state.preview.live ? '当前使用真实模型。项目和阅读资料持久保存在这台设备。' : '当前是流程验收环境，生成使用受控示例。');
      text('[data-storage-note]', state.preview.live ? '资料保存在本机 · 生成将调用已配置的模型服务' : '流程验收模式 · 生成使用受控示例');
    }
    if (state.mode === "static") {
      text("[data-account-label]", "静态演示");
      text("[data-account-title]", "这是一份静态演示");
      text("[data-account-description]", "首页、开书动效、上传页和示例书都可以试；生成项目书与 AI 回答需要把仓库 clone 到本地运行。");
      text("[data-account-footnote]", "静态演示不保存账户，也不会上传你选择的文件。");
      text("[data-storage-note]", "静态演示 · 不会上传文件；生成需要在本地运行");
      text("[data-footer-space]", "静态演示 · 本地运行可以生成自己的书");
    }
    renderUploadAccess();
    if (signedIn && state.user) {
      var name = state.user.name || state.user.login || "GitHub 用户";
      text("[data-account-name]", name);
      text("[data-account-login]", "@" + (state.user.login || "GitHub"));
      text("[data-account-avatar]", Array.from(name)[0]);
    }
    if (signedIn && state.usage && state.usage.generation) {
      var usage = state.usage.generation;
      text("[data-account-period]", (state.usage.period || "本月") + " · 项目主书额度");
      text("[data-account-remaining]", usage.remaining + " 本主书可生成");
      text("[data-account-usage-detail]", "总额度 " + usage.limit + " 本 · 已完成 " + usage.used + " 本" + (usage.reserved ? " · 生成中 " + usage.reserved + " 本" : ""));
      var modelUsage = state.usage.model;
      text("[data-account-model-usage]", modelUsage ? "今日 AI 使用 " + modelUsage.used + " / " + modelUsage.limit + " 次" : "");
    }
    if (publicMode && !signedIn && state.login && !state.login.configured) text("[data-account-status]", state.login.reason || "本站还未配置 GitHub 登录。暂时可以阅读下方公开案例。");
    else text("[data-account-status]", "");
    if (publicMode && !signedIn) {
      text("#shelfTitle", "公开案例");
      text(".shelf-library-heading .shelf-eyebrow", "登录后，开始建立自己的项目书架");
    } else {
      var title = q("#shelfTitle");
      title.replaceChildren(document.createTextNode("我的书架"));
      var dot = element("span", "", "。"); dot.setAttribute("aria-hidden", "true"); title.appendChild(dot);
      text(".shelf-library-heading .shelf-eyebrow", "属于你的知识，慢慢成书");
    }
    if (document.body.dataset.pageView === "library") document.title = libraryTitle();
    window.dispatchEvent(new CustomEvent("shelf-account-ready", { detail: state }));
    return state;
  }
  async function loadAccount() {
    if (staticDemo) { account = { mode: "static", authenticated: false }; return renderAccount(); }
    try {
      var result = await json("/api/account");
      if (!result || (result.mode !== "public" && result.mode !== "local")) throw new Error("账户响应无效");
      account = result;
    } catch (error) {
      // Only an absent endpoint in a non-public shell identifies the older local server.
      account = error.status === 404 && !(window.SHELF_ACCOUNT_CONTEXT && window.SHELF_ACCOUNT_CONTEXT.mode === "public") ? { mode: "local", authenticated: false } : { mode: "unavailable", authenticated: false };
    }
    return renderAccount();
  }
  function refreshAccount() {
    accountPromise = loadAccount();
    if (window.ShelfLanding) window.ShelfLanding.accountReady = accountPromise;
    return accountPromise;
  }
  function openAccount(trigger) {
    accountTrigger = trigger || document.activeElement;
    if (!accountDialog.open) accountDialog.showModal();
  }
  function isDemo() { return Boolean(account && account.mode === "static"); }
  function canGenerate() {
    return !window.SHELF_ACCOUNT_CHANGED && account && (account.mode === "local" || account.mode === "public" && account.authenticated);
  }
  async function requireGenerationAccess(options) {
    await accountPromise;
    if (canGenerate()) return true;
    pendingImport = true;
    if (!isWorkspace(document.body.dataset.pageView)) showUpload({ trigger: options && options.trigger });
    renderUploadAccess();
    q('[data-upload-access-status]')?.focus({ preventScroll: true });
    return false;
  }
  function renderUploadAccess() {
    var state = account || { mode: 'loading' };
    // The static demo shows the whole workspace; only its submission is turned away.
    var allowed = canGenerate() || isDemo(), preview = state.preview && state.preview.local;
    if (form) form.hidden = !allowed;
    visible('[data-upload-access]', !allowed);
    visible('[data-upload-signin]', !allowed && !preview && Boolean(state.login && state.login.configured));
    visible('[data-upload-local-login]', !allowed && Boolean(preview));
    visible('[data-upload-retry]', !allowed && state.mode === 'unavailable');
    text('[data-upload-access-status]', allowed ? '' : state.mode === 'loading' ? '正在连接你的空间…' : state.mode === 'unavailable' ? '暂时连不上你的空间。连接恢复后可以继续，已有输入会保留。' : preview ? state.preview.live ? '使用本机账户继续。生成会调用已配置的真实模型，资料保存在这台设备。' : '使用本机体验账户继续，先试试项目成书的完整过程。' : state.login && state.login.configured ? '先登录，为你的项目和阅读记录留一个位置。' : state.login && state.login.reason || '本站暂未配置 GitHub 登录，可以先阅读已有案例。');
    renderHeading();
  }
  document.querySelectorAll("[data-account-open]").forEach(function (node) { node.addEventListener("click", function () { openAccount(node); refreshAccount(); }); });
  q("[data-account-close]").addEventListener("click", function () { accountDialog.close(); });
  accountDialog.addEventListener("close", function () { if (accountTrigger && accountTrigger.isConnected) accountTrigger.focus({ preventScroll: true }); });
  q("[data-account-retry]").addEventListener("click", async function () {
    var button = this; button.disabled = true; text("[data-account-status]", "正在重新连接…");
    await refreshAccount(); button.disabled = false;
  });
  q("[data-account-settings]").addEventListener("click", function () { accountDialog.close(); }, true);
  function saveLoginDraft() {
    if (!pendingImport || !form) return;
    var selected = form.querySelector("[data-source-choice][aria-pressed=true]");
    var draft = { name: form.elements.name.value, repo: form.elements.repo.value, readingFocus: form.elements.readingFocus ? form.elements.readingFocus.value : "", sourceType: selected ? selected.dataset.sourceChoice : "local", returnView: returnView, homeScroll: homeScroll, libraryScroll: libraryScroll };
    try { sessionStorage.setItem("shelf-login-import-draft", JSON.stringify(draft)); } catch (error) {}
  }
  q('[data-account-signin]').addEventListener('click', saveLoginDraft);
  q('[data-upload-signin]')?.addEventListener('click', function () { pendingImport = true; saveLoginDraft(); });
  q('[data-upload-local-login]')?.addEventListener('submit', function () { pendingImport = true; saveLoginDraft(); });
  q('[data-upload-retry]')?.addEventListener('click', refreshAccount);
  q("[data-account-logout]").addEventListener("click", async function () {
    var button = this; button.disabled = true;
    try {
      var response = await fetch("/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("退出未成功");
      window.location.assign("/");
    } catch (error) { text("[data-account-status]", "暂时未能确认退出结果，请刷新页面确认，或重试。"); button.disabled = false; }
  });
  // Enter the workspace immediately; account access is handled inside it.
  document.addEventListener("click", function (event) {
    var trigger = event.target.closest && event.target.closest("[data-import-open]");
    if (!trigger || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); event.stopImmediatePropagation();
    showUpload({ trigger: trigger, animate: event.detail !== 0 });
  }, true);
  if (form) document.addEventListener("submit", async function (event) {
    if (event.target === form && isDemo()) {
      event.preventDefault(); event.stopImmediatePropagation();
      text("[data-import-status]", staticNotice);
      return;
    }
    if (event.target !== form || replaying || canGenerate()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (accessPending) return;
    accessPending = true;
    var submitter = event.submitter;
    try {
      if (await requireGenerationAccess({ trigger: submitter })) {
        // Native forms suppress requestSubmit during the same submission event,
        // including its microtask checkpoint. Replay only on the next task.
        await new Promise(function (resolve) {
          setTimeout(function () {
            replaying = true;
            try { form.requestSubmit(submitter || undefined); } finally { replaying = false; resolve(); }
          }, 0);
        });
      }
    } finally { accessPending = false; }
  }, true);

  function buildExample(project, preview, index, isPublic) {
    var article = element("article", "landing-example"); article.dataset.exampleProject = project.id;
    var readingUrl = safePath(preview.readingUrl, (isPublic ? "/examples/" : "/projects/") + project.id + "/books/" + (project.mainBookId || "main") + "/");
    var palette = window.ShelfPreview ? window.ShelfPreview.coverPalette(preview.styleFingerprint || project.mainBook && project.mainBook.styleFingerprint) : {};
    if (palette.paper) article.style.setProperty("--example-paper", palette.paper);
    if (palette.ink) article.style.setProperty("--example-ink", palette.ink);
    if (palette.accent) article.style.setProperty("--example-accent", palette.accent);
    var top = element("div", "landing-example-top");
    top.appendChild(element("span", "landing-example-number", "0" + (index + 1) + " / 真实读本"));
    top.appendChild(element("span", "landing-example-domain", exampleLabels[project.id] || "项目读本"));
    var cover = element("a", "landing-example-cover"); cover.href = readingUrl; cover.setAttribute("aria-label", "阅读“" + (preview.title || project.name) + "”");
    cover.appendChild(element("small", "", "KNOWLEDGE SHELF"));
    var glyph = element("span", "landing-example-glyph", exampleGlyphs[project.id] || "书"); glyph.setAttribute("aria-hidden", "true"); cover.appendChild(glyph);
    cover.appendChild(element("strong", "", project.name)); cover.appendChild(element("i"));
    cover.appendChild(element("span", "", isPublic ? "项目主书 · 公开阅读" : "项目主书 · 源码可回看")); top.appendChild(cover); article.appendChild(top);
    var heading = element("div", "landing-example-heading"); heading.appendChild(element("h3", "", project.name));
    var read = element("a", "", "翻开读本 ↗"); read.href = readingUrl; heading.appendChild(read); article.appendChild(heading);
    article.appendChild(element("p", "landing-example-summary", preview.summary || "这本书暂未提供摘要，可以直接翻开阅读。"));
    if (Array.isArray(preview.chapters) && preview.chapters.length) {
      var chapters = element("ol", "landing-example-chapters");
      preview.chapters.slice(0, 3).forEach(function (chapter, chapterIndex) {
        if (!chapter || !chapter.title) return;
        var item = element("li"); item.appendChild(element("span", "", "0" + (chapterIndex + 1)));
        var link = element(chapter.id ? "a" : "span", "", chapter.title);
        if (chapter.id) link.href = readingUrl.replace(/#.*$/, "") + "#" + encodeURIComponent(chapter.id);
        item.appendChild(link); chapters.appendChild(item);
      });
      article.appendChild(chapters);
    }
    return article;
  }
  async function loadExamples() {
    if (examplesLoading) return;
    examplesLoading = true;
    var list = q("[data-example-list]");
    list.setAttribute("aria-busy", "true");
    try {
      var data, isPublic = true;
      if (staticDemo) data = await json("static-demo.json");
      else try { data = await json("/api/examples"); }
      catch (error) {
        if (error.status !== 404) throw error;
        if (window.SHELF_ACCOUNT_CONTEXT && window.SHELF_ACCOUNT_CONTEXT.mode === "public") throw error;
        isPublic = false; data = await json("/api/projects?view=shelf");
      }
      var projects = exampleIds.map(function (id) { return (data.projects || []).find(function (project) { return project.id === id && project.bookCount; }); }).filter(Boolean);
      if (!projects.length) throw new Error("案例暂未发布");
      var entries = await Promise.all(projects.map(async function (project, index) {
        try {
          var preview = staticDemo ? project.preview : await json((isPublic ? "/api/examples/" : "/api/projects/") + project.id + "/preview");
          if (!preview.ready || preview.projectId !== project.id) return null;
          return buildExample(project, preview, index, isPublic);
        } catch (error) { return null; }
      }));
      var nodes = entries.filter(Boolean);
      if (!nodes.length) throw new Error("案例预览未能加载");
      list.replaceChildren.apply(list, nodes);
    } catch (error) {
      var status = element("p", "landing-example-status", "暂时未能取到案例预览。连接恢复后再试一次。");
      var retry = element("button", "", "重新读取"); retry.type = "button"; retry.addEventListener("click", loadExamples); status.appendChild(retry); list.replaceChildren(status);
    } finally { list.setAttribute("aria-busy", "false"); examplesLoading = false; }
  }
  window.ShelfLanding = { showLibrary: showLibrary, showHome: showHome, showUpload: showUpload, showGeneration: showGeneration, requireGenerationAccess: requireGenerationAccess, refreshAccount: refreshAccount, openAccount: openAccount, accountReady: null };
  function restoreLoginDraft(state) {
    if (state.mode !== "public" || !state.authenticated || !form) return;
    var draft;
    try { draft = JSON.parse(sessionStorage.getItem("shelf-login-import-draft") || "null"); } catch (error) { return; }
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) return;
    // Login can return to an account with an older ready or active flow. Start
    // the requested new import before writing the bridge fields, so opening
    // the launcher cannot reset them. Existing server jobs stay on the shelf.
    var newImport = form.querySelector("[data-new-import]");
    if (newImport) newImport.click();
    var sourceButton = form.querySelector('[data-source-choice="' + (draft.sourceType === "github" ? "github" : "local") + '"]');
    if (sourceButton) sourceButton.click();
    if (typeof draft.repo === "string") { form.elements.repo.value = draft.repo; form.elements.repo.dispatchEvent(new Event("input", { bubbles: true })); }
    if (typeof draft.name === "string") { form.elements.name.value = draft.name; form.elements.name.dispatchEvent(new Event("input", { bubbles: true })); }
    if (typeof draft.readingFocus === "string" && form.elements.readingFocus) { form.elements.readingFocus.value = draft.readingFocus.slice(0, 500); form.elements.readingFocus.dispatchEvent(new Event("input", { bubbles: true })); }
    returnView = draft.returnView === 'library' ? 'library' : 'home';
    homeScroll = Number.isFinite(draft.homeScroll) ? draft.homeScroll : homeScroll;
    libraryScroll = Number.isFinite(draft.libraryScroll) ? draft.libraryScroll : libraryScroll;
    writeRoute('#upload', true); switchView('upload', { focus: true });
    try { sessionStorage.removeItem("shelf-login-import-draft"); } catch (error) {}
  }
  function phase() { return workspace && workspace.dataset.phase || 'idle'; }
  // Long project names break after _ - . / rather than between any two letters.
  function breakable(node, value) {
    var part = '';
    node.replaceChildren();
    Array.from(value).forEach(function (char) {
      part += char;
      if ('_-./'.indexOf(char) === -1) return;
      node.appendChild(document.createTextNode(part)); node.appendChild(document.createElement('wbr')); part = '';
    });
    if (part) node.appendChild(document.createTextNode(part));
  }
  function lengthClass(value, long, xlong) { var length = Array.from(value).length; return length > xlong ? 'xlong' : length > long ? 'long' : 'short'; }
  function renderTitlePage() {
    var name = (identity.name || '').trim();
    var nameNode = q('[data-upload-project-name]');
    if (nameNode) {
      if (name) breakable(nameNode, name); else nameNode.textContent = '你的项目';
      nameNode.dataset.empty = String(!name);
      nameNode.dataset.length = lengthClass(name, 12, 24);
    }
    // The focus is the subtitle. shelf.js restores it by assignment, so read the live value.
    var focus = form && form.elements.readingFocus ? form.elements.readingFocus.value.trim() : '';
    var focusNode = q('[data-upload-focus-line]');
    if (focusNode) {
      focusNode.textContent = focus || '先看清全貌。';
      focusNode.dataset.empty = String(!focus);
      focusNode.dataset.length = lengthClass(focus, 18, 54);
    }
    if (workspace) workspace.dataset.hasProject = String(Boolean(name));
    // The contents fill in from what is really there; nothing is marked done ahead of it.
    var current = phase(), saved = current !== 'idle';
    var source = identity.source === 'github' ? (identity.repo ? 'GitHub · ' + identity.repo : '') : identity.fileCount ? identity.folderName + ' · ' + identity.fileCount + ' 个文本文件' : '';
    contentsRow('source', saved || Boolean(source), source || (saved ? '源码已保存' : '选文件夹，或填 GitHub 地址'));
    contentsRow('focus', Boolean(focus), focus ? '已写 ' + Array.from(focus).length + ' 字' : '可不填，不填就先讲清全貌');
    var note = current in bookNotes ? bookNotes[current] : bookNotes.idle;
    contentsRow('book', current === 'ready', current === 'idle' && source ? '可以开始了' : note);
  }
  function contentsRow(name, done, detail) {
    var row = q('[data-contents-row="' + name + '"]');
    if (row) row.dataset.done = String(done);
    text('[data-contents-row="' + name + '"] [data-contents-detail]', detail);
  }
  function renderHeading() {
    var copy = headings[!canGenerate() && !isDemo() ? 'access' : phase()] || headings.idle;
    text('[data-upload-kicker]', copy[0]);
    text('[data-upload-heading]', copy[1]);
    text('[data-upload-lede]', copy[2]);
  }
  window.addEventListener('shelf-import-identity', function (event) { identity = event.detail || {}; renderTitlePage(); });
  window.addEventListener('shelf-generation-state', function () { renderTitlePage(); renderHeading(); });
  if (form) form.addEventListener('input', function (event) { if (event.target && event.target.name === 'readingFocus') renderTitlePage(); });
  // iOS applies :active press styles only once a touch listener exists.
  document.addEventListener('touchstart', function () {}, { passive: true });
  renderUploadAccess();
  refreshAccount().then(restoreLoginDraft);
  window.dispatchEvent(new CustomEvent('shelf-workspace-ready'));
  loadExamples();
}());
