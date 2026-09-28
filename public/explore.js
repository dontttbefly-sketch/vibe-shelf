/* 知识书架 · 项目探索会话（独立于旁注层） */
(function () {
  "use strict";

  function storageKey(context) {
    return "shelf-exploration-" + context.projectId + "-" + (context.bookId || "project");
  }

  function currentChapterId() {
    var node = document.elementFromPoint(window.innerWidth / 2, 80);
    var chapter = node && node.closest ? node.closest(".chapter") : null;
    return chapter ? chapter.id : null;
  }

  async function request(url, options) {
    var response = await fetch(url, options);
    var data;
    try { data = await response.json(); } catch (error) { data = null; }
    if (!response.ok) {
      throw new Error(data && data.error && data.error.message ? data.error.message : "请求没有成功");
    }
    return data;
  }

  function post(url, body) {
    return request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  function projectPath(context, suffix) {
    return "/api/projects/" + encodeURIComponent(context.projectId) + suffix;
  }

  function renderExploreForm() {
    return '<section class="shelf-explore" aria-label="探索这个项目">' +
      '<div class="shelf-explore-head"><p class="shelf-explore-kicker">继续探索</p>' +
      '<h2>这本书之外，你还想弄懂什么？</h2>' +
      '<p>问一个具体问题，回答会先留在这次探索里；只有你确认后，它才会长成一本小书。</p></div>' +
      '<div class="shelf-explore-history" data-explore-history></div>' +
      '<form class="shelf-explore-form" data-explore-form>' +
      '<label class="shelf-explore-label" for="shelfExploreQuestion">提出一个问题</label>' +
      '<div class="shelf-explore-input"><textarea id="shelfExploreQuestion" rows="2" placeholder="例如：这个项目启动时，配置是怎样流动的？"></textarea>' +
      '<button type="submit">开始探索</button></div>' +
      '<p class="shelf-explore-status" data-explore-status></p></form>' +
      '</section>';
  }

  function historyRoot(root) {
    return root.querySelector("[data-explore-history]");
  }

  function statusRoot(root) {
    return root.querySelector("[data-explore-status]");
  }

  function formRoot(root) {
    return root.querySelector("[data-explore-form]");
  }

  function appendSourceRefs(container, refs) {
    if (!Array.isArray(refs) || !refs.length) return;
    var details = document.createElement("details");
    details.className = "shelf-explore-sources";
    var summary = document.createElement("summary");
    summary.textContent = "这次回答参考的源码";
    details.appendChild(summary);
    var list = document.createElement("ul");
    refs.forEach(function (ref) {
      var item = document.createElement("li");
      var code = document.createElement("code");
      code.textContent = ref.path + ":" + ref.startLine + "-" + ref.endLine;
      item.appendChild(code);
      list.appendChild(item);
    });
    details.appendChild(list);
    container.appendChild(details);
  }

  function renderMessage(root, message, handlers) {
    var history = historyRoot(root);
    if (!history || !message) return;
    var item = document.createElement("article");
    item.className = "shelf-explore-message shelf-explore-message--" + (message.role || "assistant");
    var role = document.createElement("p");
    role.className = "shelf-explore-message-role";
    role.textContent = message.role === "user" ? "你的问题" : "探索回答";
    var content = document.createElement("div");
    content.className = "shelf-explore-message-content";
    var text = message.content || (message.status === "pending" ? "正在查阅项目源码…" : "暂时没有内容");
    // 回答本身是 Markdown（标题/列表/代码块），当纯文本读会满屏 ### 和 **；
    // 用户自己写的问题则原样显示，免得问句里的星号被当成语法
    if (message.role === "assistant" && message.content && window.ShelfMarkdown) {
      content.innerHTML = window.ShelfMarkdown.render(message.content);
    } else {
      content.textContent = text;
    }
    item.appendChild(role);
    item.appendChild(content);

    if (message.role === "assistant") {
      appendSourceRefs(item, message.sourceRefs || []);
      var actions = document.createElement("div");
      actions.className = "shelf-explore-message-actions";
      if (message.status === "failed") {
        var retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = "重试这次回答";
        retry.addEventListener("click", function () { handlers.retryMessage(message.id); });
        actions.appendChild(retry);
      }
      if (message.status === "complete") {
        var grow = document.createElement("button");
        grow.type = "button";
        grow.className = "shelf-explore-grow";
        grow.textContent = "让这个问题长成一本书";
        grow.addEventListener("click", function () { handlers.growIntoBook(message.id); });
        actions.appendChild(grow);
      }
      if (actions.childNodes.length) item.appendChild(actions);
    }
    history.appendChild(item);
  }

  function renderSession(root, session, handlers) {
    var history = historyRoot(root);
    if (!history) return;
    history.replaceChildren();
    (session.messages || []).forEach(function (message) { renderMessage(root, message, handlers); });
  }

  function setBusy(root, busy, message) {
    var form = formRoot(root);
    if (form) {
      form.querySelector("textarea").disabled = busy;
      form.querySelector("button[type=submit]").disabled = busy;
    }
    var status = statusRoot(root);
    if (status) status.textContent = message || "";
  }

  // 只在"根本没有本地服务"时用：表单永久禁用是对的，因为重试也不会成功
  function showLocalOnly(root, error) {
    var form = formRoot(root);
    if (form) {
      form.querySelector("textarea").disabled = true;
      form.querySelector("button[type=submit]").disabled = true;
    }
    var status = statusRoot(root);
    if (status) {
      status.className = "shelf-explore-status is-local-only";
      status.textContent = "需要本地运行后才能探索项目。" + (error && error.message ? "（" + error.message + "）" : "");
    }
  }

  // 一次请求失败（模型超时、5xx）不该把整个会话锁死：提示原因，表单保持可用
  function showError(root, error) {
    setBusy(root, false, "");
    var status = statusRoot(root);
    if (!status) return;
    status.className = "shelf-explore-status is-error";
    status.textContent = (error && error.message ? error.message : "这次没有成功") + " · 可以再试一次";
  }

  function mount(options) {
    options = options || {};
    var context = options.context || window.SHELF_CONTEXT;
    var root = options.root;
    if (!root || !context) return null;

    var sessionId = options.sessionId || sessionStorage.getItem(storageKey(context)) || null;
    if (sessionId) sessionStorage.setItem(storageKey(context), sessionId);
    root.innerHTML = renderExploreForm();

    function handlers() {
      return { sendMessage: sendMessage, retryMessage: retryMessage, growIntoBook: growIntoBook };
    }

    async function resumeSession() {
      if (!sessionId || !context.projectId) return;
      var result = await request(projectPath(context, "/explorations/" + encodeURIComponent(sessionId)));
      renderSession(root, result.session, handlers());
    }

    async function sendMessage(prompt) {
      var question = String(prompt || "").trim();
      if (!question) return;
      if (!context.projectId) {
        showLocalOnly(root);
        return;
      }
      setBusy(root, true, "正在结合项目源码整理回答…");
      var history = historyRoot(root);
      var pending = document.createElement("p");
      pending.className = "shelf-explore-pending";
      pending.textContent = "正在查阅项目源码…";
      if (history) history.appendChild(pending);
      try {
        if (!sessionId) {
          var created = await post(projectPath(context, "/explorations"), {
            originBookId: context.bookId || null,
            sourceSnapshotId: context.sourceSnapshotId || null,
            originChapterId: context.bookId ? currentChapterId() : null,
            originReadingPosition: window.scrollY,
          });
          sessionId = created.session.id;
          sessionStorage.setItem(storageKey(context), sessionId);
        }
        var result = await post(
          projectPath(context, "/explorations/" + encodeURIComponent(sessionId) + "/messages"),
          { prompt: question },
        );
        if (pending.parentNode) pending.remove();
        renderMessage(root, { id: "local-question", role: "user", content: question }, handlers());
        renderMessage(root, result.assistantMessage, handlers());
        var form = formRoot(root);
        if (form) form.querySelector("textarea").value = "";
        setBusy(root, false, result.assistantMessage.status === "failed" ? "这次回答失败了，可以重试。" : "");
      } catch (error) {
        if (pending.parentNode) pending.remove();
        showError(root, error);
      }
    }

    async function retryMessage(messageId) {
      if (!context.projectId || !sessionId) return showLocalOnly(root);
      setBusy(root, true, "正在重试这次回答…");
      try {
        var result = await post(
          projectPath(context, "/explorations/" + encodeURIComponent(sessionId) + "/messages/" + encodeURIComponent(messageId) + "/retry"),
          {},
        );
        var session = await request(projectPath(context, "/explorations/" + encodeURIComponent(sessionId)));
        renderSession(root, session.session, handlers());
        setBusy(root, false, result.assistantMessage.status === "failed" ? "仍未成功，可以稍后再试。" : "");
      } catch (error) {
        showError(root, error);
      }
    }

    async function growIntoBook(messageId) {
      if (!context.projectId || !sessionId) return showLocalOnly(root);
      setBusy(root, true, "正在把这次探索整理成一本小书…");
      try {
        var result = await post(
          projectPath(context, "/explorations/" + encodeURIComponent(sessionId) + "/books"),
          { answerMessageId: messageId, parentBookId: context.bookId || null },
        );
        var url = result.book.url || (
          "/projects/" + encodeURIComponent(context.projectId) + "/books/" + encodeURIComponent(result.book.id) + "/"
        );
        window.location.assign(url);
      } catch (error) {
        showError(root, error);
      }
    }

    var form = formRoot(root);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      sendMessage(form.querySelector("textarea").value);
    });

    if (sessionId) {
      resumeSession().catch(function (error) {
        // 会话过期/被删是常态，丢掉这个 id 让下一次提问新建会话即可，别锁死表单
        sessionId = null;
        sessionStorage.removeItem(storageKey(context));
        showError(root, error);
      });
    }
    return { sendMessage: sendMessage, growIntoBook: growIntoBook, retryMessage: retryMessage };
  }

  window.ShelfExplore = { mount: mount };
  var bookRoot = document.querySelector("[data-shelf-explore]");
  if (bookRoot && window.SHELF_CONTEXT) mount({ root: bookRoot });
}());
