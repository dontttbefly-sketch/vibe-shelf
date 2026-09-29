/* 书底探索：连续问答、草稿与历史，让成果下次找得到。 */
(function () {
  "use strict";
  function storageKey(context) { return "shelf-exploration-" + context.projectId + "-" + (context.bookId || "project"); }
  function readLocal(key) { try { return localStorage.getItem(key); } catch (error) { return null; } }
  function writeLocal(key, value) { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); return true; } catch (error) { return false; } }
  function projectPath(context, suffix) { return "/api/projects/" + encodeURIComponent(context.projectId) + suffix; }
  async function request(url, options) {
    var response = await fetch(url, Object.assign({ signal: AbortSignal.timeout(130000) }, options || {}));
    var data = await response.json().catch(function () { return null; });
    if (!response.ok) { var error = new Error(data && data.error ? data.error.message : "请求没有成功"); error.status = response.status; throw error; }
    return data;
  }
  function post(url, body) { return request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }); }
  function textNode(parent, tag, value, className) { var node = document.createElement(tag); node.textContent = value; if (className) node.className = className; parent.appendChild(node); return node; }
  function currentChapterId() { var chapters = Array.from(document.querySelectorAll(".chapter[id]")); var found = chapters.filter(function (node) { return node.getBoundingClientRect().top < 180; }).pop(); return found ? found.id : null; }
  function renderExploreForm() {
    return '<section class="shelf-explore" aria-label="探索这个项目"><div class="shelf-explore-head"><p class="shelf-explore-kicker">继续探索</p>' +
      '<h2>换个方向，再深入一点。</h2><p>从这里展开新的问题。探索会留在本项目里，值得保存时，再让它长成小书。</p></div>' +
      '<div class="shelf-explore-toolbar"><span data-explore-title>新的探索</span><button type="button" data-explore-list aria-expanded="false" aria-controls="shelfExploreSessions">探索历史</button><button type="button" data-explore-new>新探索</button></div>' +
      '<div id="shelfExploreSessions" class="shelf-explore-sessions" data-explore-sessions hidden></div><div class="shelf-explore-history" data-explore-history></div>' +
      '<form class="shelf-explore-form" data-explore-form><label class="shelf-explore-label" for="shelfExploreQuestion">你想弄懂什么？</label>' +
      '<div class="shelf-explore-input"><textarea id="shelfExploreQuestion" maxlength="4000" rows="2" placeholder="例如：这个项目启动时，配置是怎样流动的？"></textarea><button type="submit">开始探索</button></div>' +
      '<p class="shelf-explore-status" data-explore-status role="status" aria-live="polite"></p></form></section>';
  }
  function mount(options) {
    options = options || {}; var root = options.root; var context = options.context || window.SHELF_CONTEXT;
    if (!root || !context || root.dataset.exploreMounted) return null;
    root.dataset.exploreMounted = "true"; root.id = "shelf-explore"; root.innerHTML = renderExploreForm();
    var stored = readLocal(storageKey(context));
    if (!stored) { try { stored = sessionStorage.getItem(storageKey(context)); } catch (error) {} }
    var requested = new URLSearchParams(window.location.search).get("exploration");
    var sessionId = options.sessionId || requested || stored || null;
    if (sessionId && !/^[a-z0-9-]+$/.test(sessionId)) sessionId = null;
    var form = root.querySelector("form"); var textarea = form.querySelector("textarea"); var status = root.querySelector("[data-explore-status]");
    var history = root.querySelector("[data-explore-history]"); var sessionsBox = root.querySelector("[data-explore-sessions]");
    var busy = false; var poll = null; var session = null; var disposed = false; var switching = 0; var actionActive = false; var lifecycle = 0; var resumeVersion = 0;
    function draftKey() { return storageKey(context) + "-draft-" + (sessionId || "new"); }
    function pendingKey() { return draftKey() + "-sending"; }
    function readPending() {
      try {
        var value = JSON.parse(readLocal(pendingKey()) || "null");
        return value && typeof value.question === "string" && Array.isArray(value.beforeIds) ? value : null;
      } catch (error) { return null; }
    }
    var pendingSend = readPending();
    function clearSentDraft(question) {
      // A recovered answer must not erase a different, unsent follow-up draft.
      if (textarea.value.trim() === question) { textarea.value = ""; writeLocal(draftKey(), ""); }
    }
    function updateSessionUrl() {
      var url = new URL(window.location.href);
      if (sessionId) url.searchParams.set("exploration", sessionId);
      else url.searchParams.delete("exploration");
      window.history.replaceState(null, "", url);
    }
    function saveDraft() { if (!writeLocal(draftKey(), textarea.value)) setStatus("草稿暂时只留在当前页，浏览器没有允许本地保存。", true); }
    function setStatus(message, isError) { status.textContent = message || ""; status.classList.toggle("is-error", Boolean(isError)); }
    function setBusy(value, message) {
      busy = value; textarea.disabled = value;
      root.querySelectorAll("button").forEach(function (button) { if (!button.hasAttribute("data-explore-source")) button.disabled = value; });
      form.querySelector("[type=submit]").textContent = value ? "正在整理…" : session && session.messages.length ? "继续追问" : "开始探索";
      if (message !== undefined) setStatus(message);
    }
    function rememberSession() { writeLocal(storageKey(context), sessionId || ""); }
    function appendSources(item, refs) {
      if (!Array.isArray(refs) || !refs.length) return;
      var details = document.createElement("details"); details.className = "shelf-explore-sources"; item.appendChild(details);
      textNode(details, "summary", "参考源码"); var list = document.createElement("ul"); details.appendChild(list);
      refs.forEach(function (ref) {
        var li = document.createElement("li");
        var label = ref.path + ":" + ref.startLine + "–" + ref.endLine;
        var snapshotId = session && session.sourceSnapshotId;
        if (snapshotId && window.ShelfSource && typeof window.ShelfSource.open === "function") {
          var button = textNode(li, "button", label, "shelf-explore-source");
          button.type = "button"; button.setAttribute("data-explore-source", ""); button.title = "在源码面板中查看";
          button.addEventListener("click", function () { return window.ShelfSource.open({ path: ref.path, startLine: ref.startLine, endLine: ref.endLine, sourceSnapshotId: snapshotId }); });
        } else textNode(li, "code", label);
        list.appendChild(li);
      });
    }
    function renderMessage(message) {
      var item = document.createElement("article"); item.className = "shelf-explore-message shelf-explore-message--" + (message.role === "user" ? "user" : "assistant");
      textNode(item, "p", message.role === "user" ? "你的问题" : "探索回答", "shelf-explore-message-role");
      var content = textNode(item, "div", "", "shelf-explore-message-content");
      if (message.role === "assistant" && message.content && window.ShelfMarkdown) content.innerHTML = window.ShelfMarkdown.render(message.content);
      else content.textContent = message.content || (message.status === "pending" ? "正在结合源码整理回答…" : "这次回答没有完成。");
      if (message.role === "assistant") {
        appendSources(item, message.sourceRefs);
        var actions = document.createElement("div"); actions.className = "shelf-explore-message-actions";
        if (message.status === "failed") {
          textNode(item, "p", message.error || "回答中断，问题已经保留。", "shelf-explore-message-error");
          var retry = textNode(actions, "button", "重试这次回答"); retry.type = "button"; retry.addEventListener("click", function () { retryMessage(message.id); });
        }
        if (message.status === "complete") {
          var grow = textNode(actions, "button", "让这个问题长成一本书", "shelf-explore-grow"); grow.type = "button"; grow.addEventListener("click", function () { growIntoBook(message.id); });
        }
        if (actions.childNodes.length) item.appendChild(actions);
      }
      history.appendChild(item);
    }
    function renderSession(value, options) {
      options = options || {};
      session = value; history.replaceChildren(); (value.messages || []).forEach(renderMessage);
      var question = (value.messages || []).find(function (message) { return message.role === "user"; });
      root.querySelector("[data-explore-title]").textContent = question ? question.content : "新的探索";
      var receipt = pendingSend || readPending();
      var accepted = receipt && (receipt.accepted || value.messages.some(function (message) {
        return message.role === "user" && message.content === receipt.question && receipt.beforeIds.indexOf(message.id) < 0;
      }));
      if (accepted) { clearSentDraft(receipt.question); pendingSend = null; writeLocal(pendingKey(), ""); }
      var waiting = value.messages.some(function (message) { return message.status === "pending"; });
      setBusy(waiting || actionActive, waiting ? "问题已保存，正在整理回答。可以先回到正文阅读。" : actionActive ? undefined : "");
      if (options.notice && !accepted) setStatus(options.notice, true);
      else if (accepted && options.recover && !waiting) setStatus("已找回这次回答，无需重复发送。");
      else if (receipt && !accepted && !waiting) setStatus("发送结果还未确认，草稿已保留；恢复连接后会重新核对。", true);
      if (waiting || (receipt && !accepted)) schedulePoll(); else clearTimeout(poll);
      return { accepted: Boolean(accepted), waiting: waiting };
    }
    function schedulePoll() {
      clearTimeout(poll); if (disposed || !sessionId) return;
      poll = setTimeout(function () { resumeSession().catch(function () { setStatus("连接暂时中断，恢复后会找回这次回答。", true); schedulePoll(); }); }, 2000);
    }
    async function resumeSession(options) {
      if (!sessionId || !context.projectId) return;
      var expected = sessionId; var epoch = lifecycle; var version = ++resumeVersion;
      var result = await request(projectPath(context, "/explorations/" + encodeURIComponent(expected)), { signal: AbortSignal.timeout(15000) });
      if (expected !== sessionId || disposed || epoch !== lifecycle || version !== resumeVersion) return;
      var resultState = renderSession(result.session, options); rememberSession(); return resultState;
    }
    async function openSession(id) {
      if (busy || !/^[a-z0-9-]+$/.test(id)) return; saveDraft(); switching++; var version = switching; clearTimeout(poll);
      setBusy(true, "正在找回这次探索…");
      try {
        var result = await request(projectPath(context, "/explorations/" + encodeURIComponent(id)), { signal: AbortSignal.timeout(15000) });
        if (version !== switching || disposed) return;
        sessionId = id; pendingSend = readPending(); rememberSession(); updateSessionUrl();
        textarea.value = readLocal(draftKey()) || "";
        renderSession(result.session); sessionsBox.hidden = true; root.querySelector("[data-explore-list]").setAttribute("aria-expanded", "false");
      }
      catch (error) { if (version === switching) { setBusy(false); setStatus("暂时无法读取这次探索，历史记录仍保留。", true); } }
    }
    async function loadSessions() {
      sessionsBox.hidden = !sessionsBox.hidden; root.querySelector("[data-explore-list]").setAttribute("aria-expanded", String(!sessionsBox.hidden));
      if (sessionsBox.hidden) return;
      sessionsBox.textContent = "正在读取历史…";
      try {
        var result = await request(projectPath(context, "/explorations"), { signal: AbortSignal.timeout(15000) }); sessionsBox.replaceChildren();
        var entries = (result.sessions || []).filter(function (entry) { return entry.messages && entry.messages.length; });
        if (!entries.length) textNode(sessionsBox, "p", "还没有探索记录。第一个问题会从这里开始。");
        entries.forEach(function (entry) {
          var first = entry.messages.find(function (message) { return message.role === "user"; });
          var button = textNode(sessionsBox, "button", first ? first.content : "探索记录"); button.type = "button";
          if (entry.id === sessionId) button.setAttribute("aria-current", "true");
          button.addEventListener("click", function () { openSession(entry.id); });
        });
      } catch (error) { sessionsBox.textContent = "历史暂时无法读取。连接恢复后可再次打开。"; }
    }
    async function sendMessage(prompt) {
      var question = String(prompt || "").trim(); if (!question || busy) return;
      if (!context.projectId) return setStatus("本地运行后才能探索项目。", true);
      if (pendingSend && sessionId) {
        var previousQuestion = pendingSend.question;
        setBusy(true, "正在核对上次发送的结果…");
        try {
          var checked = await resumeSession({ recover: true });
          if (busy || (checked && checked.accepted && question === previousQuestion)) return;
        } catch (error) { setBusy(false); return setStatus("还不能确认上次是否送达，草稿已保留。请恢复连接后再试。", true); }
      }
      var epoch = lifecycle;
      saveDraft(); actionActive = true; setBusy(true, "正在结合项目源码整理回答…");
      renderMessage({ role: "user", content: question }); renderMessage({ role: "assistant", status: "pending" });
      try {
        if (!sessionId) {
          var previousDraftKey = draftKey();
          var created = await post(projectPath(context, "/explorations"), { originBookId: context.bookId || null, sourceSnapshotId: context.sourceSnapshotId || null, originChapterId: currentChapterId(), originReadingPosition: window.scrollY });
          if (disposed || epoch !== lifecycle) return;
          sessionId = created.session.id; session = created.session; rememberSession(); updateSessionUrl();
          if (writeLocal(draftKey(), textarea.value)) writeLocal(previousDraftKey, "");
        }
        pendingSend = { question: question, beforeIds: (session && session.messages || []).map(function (message) { return message.id; }), createdAt: Date.now() };
        writeLocal(pendingKey(), JSON.stringify(pendingSend));
        await post(projectPath(context, "/explorations/" + encodeURIComponent(sessionId) + "/messages"), { prompt: question });
        if (disposed || epoch !== lifecycle) return;
        if (pendingSend) { pendingSend.accepted = true; writeLocal(pendingKey(), JSON.stringify(pendingSend)); }
        clearSentDraft(question); actionActive = false; await resumeSession();
      } catch (error) {
        if (disposed || epoch !== lifecycle) return;
        var notice = (error.message || "连接中断") + "；问题草稿已保留。";
        setStatus(notice, true);
        if (sessionId) {
          var recovered = await resumeSession({ notice: notice, recover: true }).catch(function () { schedulePoll(); });
          if (recovered && !recovered.accepted && error.status) { pendingSend = null; writeLocal(pendingKey(), ""); if (!recovered.waiting) clearTimeout(poll); }
        }
        else { history.replaceChildren(); if (session) renderSession(session); }
      } finally {
        if (epoch === lifecycle) {
          actionActive = false;
          if (!disposed) setBusy(Boolean(session && session.messages.some(function (message) { return message.status === "pending"; })));
        }
      }
    }
    async function retryMessage(messageId) {
      if (busy || !sessionId) return; var epoch = lifecycle; actionActive = true; setBusy(true, "正在重试这次回答…");
      try {
        await post(projectPath(context, "/explorations/" + encodeURIComponent(sessionId) + "/messages/" + encodeURIComponent(messageId) + "/retry"));
        if (disposed || epoch !== lifecycle) return;
        actionActive = false; await resumeSession();
      }
      catch (error) {
        if (disposed || epoch !== lifecycle) return;
        setStatus(error.message, true);
        await resumeSession({ notice: error.message, recover: true }).catch(function () { schedulePoll(); });
      } finally {
        if (epoch === lifecycle) {
          actionActive = false;
          if (!disposed) setBusy(Boolean(session && session.messages.some(function (message) { return message.status === "pending"; })));
        }
      }
    }
    async function growIntoBook(messageId) {
      if (busy || !sessionId) return; var epoch = lifecycle; actionActive = true; setBusy(true, "正在整理小书，完成后将打开阅读…");
      try {
        var result = await post(projectPath(context, "/explorations/" + encodeURIComponent(sessionId) + "/books"), { answerMessageId: messageId, parentBookId: context.bookId || null });
        if (!disposed && epoch === lifecycle) window.location.assign("/projects/" + encodeURIComponent(context.projectId) + "/books/" + encodeURIComponent(result.book.id) + "/");
      } catch (error) { if (disposed || epoch !== lifecycle) return; actionActive = false; setBusy(false); setStatus(error.message, true); }
    }
    textarea.value = readLocal(draftKey()) || "";
    textarea.addEventListener("input", saveDraft);
    textarea.addEventListener("keydown", function (event) { if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); sendMessage(textarea.value); } });
    form.addEventListener("submit", function (event) { event.preventDefault(); sendMessage(textarea.value); });
    root.querySelector("[data-explore-list]").addEventListener("click", loadSessions);
    root.querySelector("[data-explore-new]").addEventListener("click", function () {
      if (busy) return; saveDraft(); clearTimeout(poll); sessionId = null; session = null; pendingSend = readPending(); rememberSession(); history.replaceChildren();
      root.querySelector("[data-explore-title]").textContent = "新的探索"; textarea.value = readLocal(draftKey()) || ""; setBusy(false, "");
      updateSessionUrl(); textarea.focus();
    });
    window.addEventListener("pagehide", function () { saveDraft(); disposed = true; actionActive = false; lifecycle++; switching++; clearTimeout(poll); });
    window.addEventListener("pageshow", function () { disposed = false; if (sessionId) resumeSession().catch(function () {}); });
    window.addEventListener("online", function () { if (sessionId) resumeSession().catch(function () {}); });
    if (sessionId) {
      setBusy(true, "正在找回上次探索…");
      resumeSession().catch(function (error) {
        setBusy(false);
        if (error.status === 404) {
          var orphanDraft = textarea.value;
          sessionId = null; pendingSend = null; rememberSession(); updateSessionUrl();
          textarea.value = orphanDraft || readLocal(draftKey()) || ""; saveDraft();
          setStatus("这次探索暂时不可用，草稿已保留，可以从新问题继续。", true);
        }
        else setStatus("暂时无法读取上次探索。请检查本地服务，再打开探索历史。", true);
      });
    }
    if (!context.projectId) setStatus("本地运行后才能探索项目。", true);
    if (window.location.hash === "#shelf-explore" || (requested && !window.location.hash)) {
      window.requestAnimationFrame(function () { if (!disposed) root.scrollIntoView({ block: "start", behavior: "auto" }); });
    }
    return { sendMessage: sendMessage, growIntoBook: growIntoBook, retryMessage: retryMessage, openSession: openSession };
  }
  window.ShelfExplore = { mount: mount };
  var root = document.querySelector("[data-shelf-explore]");
  if (root && window.SHELF_CONTEXT) window.ShelfExplore.current = mount({ root: root });
}());
