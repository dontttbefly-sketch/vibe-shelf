/* 低频维护集中在同一个入口；所有写入都保留明确结果。 */
(function () {
  "use strict";
  var opener = document.querySelector("[data-settings-open]");
  if (!opener) return;
  var dialog, status, projectsRoot, restorePreview, restoreButton, restoreData, restoreInput, restoreSequence = 0, busy = false, publicMode = false;
  function node(parent, tag, text, className) { var el = document.createElement(tag); if (text) el.textContent = text; if (className) el.className = className; parent.appendChild(el); return el; }
  function button(parent, text, handler, className) { var el = node(parent, "button", text, className); el.type = "button"; el.addEventListener("click", handler); return el; }
  function notice(message, error) { status.textContent = message; status.classList.toggle("is-error", Boolean(error)); }
  async function request(url, options) {
    if (window.SHELF_ACCOUNT_CHANGED) throw new Error("登录账户已变化，请刷新页面后管理资料。当前选择仍然保留。");
    var response = await fetch(url, Object.assign({ signal: AbortSignal.timeout(25000) }, options || {}));
    if (!response.ok) {
      var data = await response.json().catch(function () { return null; });
      var error = new Error(data && data.error ? data.error.message : "请求没有成功，请稍后重试。");
      error.status = response.status; error.kind = data && data.error ? data.error.kind : null;
      throw error;
    }
    return response;
  }
  async function action(target, work) {
    if (busy) return; busy = true; target.disabled = true;
    if (restoreInput) restoreInput.disabled = true;
    try { await work(); } catch (error) { notice(error.message || (publicMode ? "资料服务暂时不可用，请稍后重试。" : "本地服务暂时不可用，请重新启动知识书架。"), true); }
    finally { busy = false; target.disabled = false; if (restoreInput) restoreInput.disabled = false; }
  }
  async function refreshAfterChange(message) {
    // 写入的成功与后续读取分开反馈；刷新失败不能把已完成的写入说成失败。
    notice(message); window.dispatchEvent(new Event("shelf-library-changed"));
    try { await loadProjects(); }
    catch (error) { notice(message + " 项目列表暂时未刷新，请稍后重新打开设置查看。"); }
  }
  async function download(target, url, filename) {
    await action(target, async function () {
      notice("正在准备资料文件…"); var response = await request(url); var blob = await response.blob();
      var link = document.createElement("a"); var href = URL.createObjectURL(blob); link.href = href; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
      setTimeout(function () { URL.revokeObjectURL(href); }, 60000);
      notice("资料文件已准备，请在浏览器下载中查看。包含已保存的书、源码、旁注与探索。");
    });
  }
  async function loadProjects() {
    var data = await (await request("/api/projects")).json(); projectsRoot.replaceChildren();
    if (!data.projects.length) return node(projectsRoot, "p", "还没有项目，导入后可在这里整理。", "shelf-settings-hint");
    data.projects.forEach(function (project) {
      var row = node(projectsRoot, "div", "", "shelf-settings-project");
      var identity = node(row, "div"); node(identity, "strong", project.name); var state = node(identity, "small", project.archived ? "已收起 · 资料仍然保留" : (project.bookCount || 0) + " 本书");
      var actions = node(row, "div", "", "shelf-settings-actions");
      button(actions, "导出资料", function (event) { download(event.currentTarget, "/api/projects/" + encodeURIComponent(project.id) + "/export", "知识书架-" + project.id + ".json"); });
      button(actions, project.archived ? "放回书架" : "从书架收起", function (event) {
        var target = event.currentTarget;
        action(target, async function () {
          notice("正在整理项目…"); await request("/api/projects/" + encodeURIComponent(project.id) + "/archive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: !project.archived }) });
          project.archived = !project.archived;
          state.textContent = project.archived ? "已收起 · 资料仍然保留" : (project.bookCount || 0) + " 本书";
          target.textContent = project.archived ? "放回书架" : "从书架收起";
          await refreshAfterChange(project.archived ? "已从书架收起，资料仍保留，随时可以放回。" : "已放回书架。");
        });
      });
    });
  }
  function build() {
    dialog = node(document.body, "dialog", "", "shelf-settings"); dialog.setAttribute("aria-labelledby", "shelfSettingsTitle");
    var head = node(dialog, "div", "", "shelf-settings-head"); node(head, "h2", publicMode ? "个人资料管理" : "设置与资料").id = "shelfSettingsTitle"; button(head, "关闭", function () { dialog.close(); }, "shelf-settings-close");
    status = node(dialog, "p", "", "shelf-settings-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    if (publicMode) node(dialog, "p", "只管理当前登录账户的资料。收起项目会保留书、源码、旁注和探索，之后可随时放回。", "shelf-settings-hint");
    else {
      var model = node(dialog, "section"); node(model, "h3", "本地服务与模型"); var info = node(model, "p", "正在读取配置…", "shelf-settings-model"); info.dataset.modelStatus = "";
      button(model, "检查模型连接", function (event) {
        action(event.currentTarget, async function () {
          notice("正在向现有模型发送一次简短检查…");
          var result = await (await request("/api/model/check", { method: "POST" })).json();
          notice("模型连接正常 · 本次检查用时 " + (result.elapsedMs / 1000).toFixed(1) + " 秒。");
        });
      });
      node(model, "p", "继续使用本地 .env 中的接口、模型和 Key。修改配置后重启应用；连接检查会调用一次模型。", "shelf-settings-hint");
    }
    var storage = node(dialog, "section"); node(storage, "h3", "备份与恢复");
    node(storage, "p", publicMode ? "备份只包含当前账户已保存的项目、源码快照、书、旁注和探索，不含尚未同步的浏览器草稿。恢复只向当前账户新增资料；已有项目不会被覆盖。" : "备份包含已保存的项目、源码快照、书、旁注和探索；不含本应用的模型配置，也不含尚未同步的浏览器草稿。", "shelf-settings-hint");
    var storageActions = node(storage, "div", "", "shelf-settings-actions");
    button(storageActions, publicMode ? "备份我的全部资料" : "备份全部资料", function (event) { download(event.currentTarget, "/api/library/backup", "知识书架-备份-" + new Date().toISOString().slice(0, 10) + ".json"); });
    var label = node(storageActions, "label", "选择备份文件", "shelf-settings-file"); var input = restoreInput = node(label, "input"); input.type = "file"; input.accept = ".json,application/json"; input.setAttribute("aria-label", "选择知识书架备份文件");
    restorePreview = node(storage, "p", "", "shelf-settings-hint"); restoreButton = button(storage, "恢复这份资料", function (event) {
      if (!restoreData) return;
      action(event.currentTarget, async function () {
        notice("正在校验并恢复资料，请稍候…");
        var result;
        try {
          result = await (await request("/api/library/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(restoreData), signal: AbortSignal.timeout(90000) })).json();
        } catch (error) {
          if (error.status) throw error;
          // 网络错误既不能证明写入失败，也不能证明成功；保留这份备份以便检查后重试。
          notice("连接中断，暂未确认恢复结果。请重新打开书架检查；再次恢复不会覆盖已有资料。", true);
          window.dispatchEvent(new Event("shelf-library-changed"));
          return;
        }
        restoreData = null; input.value = ""; restoreButton.hidden = true; restorePreview.textContent = "";
        await refreshAfterChange("恢复完成：" + result.projectIds.length + " 个项目、" + result.legacyIds.length + " 份旧版资料。现在可以回书架打开。");
      });
    }, "shelf-settings-primary"); restoreButton.hidden = true;
    input.addEventListener("change", async function () {
      if (busy) return;
      var sequence = ++restoreSequence;
      restoreData = null; restoreButton.hidden = true; restorePreview.textContent = ""; var file = input.files[0]; if (!file) return;
      try {
        if (file.size > 192 * 1024 * 1024) throw new Error("文件超过 192MB，请使用按项目导出的资料文件。");
        var text = await file.text();
        if (sequence !== restoreSequence) return;
        var data = JSON.parse(text);
        if (data.format !== "vibe-shelf-library" || data.version !== 1 || !Array.isArray(data.projectIds) || !Array.isArray(data.projectIndex) || !Array.isArray(data.legacyIds)) throw new Error("这不是受支持的知识书架备份文件。");
        restoreData = data;
        var names = data.projectIndex.slice(0, 5).map(function (project) { return project.name; }).join("、");
        restorePreview.textContent = "准备恢复 " + data.projectIds.length + " 个项目" + (names ? "（" + names + (data.projectIndex.length > 5 ? "等" : "") + "）" : "") + "、" + data.legacyIds.length + " 份旧版资料。同名标识的已有项目会阻止恢复，已有资料不会被覆盖。";
        restoreButton.hidden = false; notice("已读取备份摘要，确认后才会开始恢复。");
      } catch (error) { if (sequence === restoreSequence) notice(error.message || "无法读取这份备份。", true); }
    });
    var projects = node(dialog, "section"); node(projects, "h3", "整理项目"); node(projects, "p", "不常用的项目可以从书架收起，之后随时放回。导出的 JSON 资料可在知识书架恢复。", "shelf-settings-hint"); projectsRoot = node(projects, "div");
    if (!publicMode) { var detail = node(dialog, "details", "", "shelf-settings-details"); node(detail, "summary", "版本与资料位置"); node(detail, "p").dataset.runtimeDetails = ""; }
    dialog.addEventListener("close", function () {
      if (window.ShelfLanding && opener.closest && opener.closest("[data-account-dialog]")) window.ShelfLanding.openAccount(document.querySelector("[data-account-open]"));
      opener.focus();
    });
  }
  opener.addEventListener("click", async function () {
    publicMode = Boolean(window.SHELF_ACCOUNT_CONTEXT && window.SHELF_ACCOUNT_CONTEXT.mode === "public" || document.body.dataset.accountMode === "public");
    if (publicMode) {
      try {
        var account = await (await request("/api/account")).json();
        if (!account.authenticated) throw new Error("请先登录，再管理自己的资料。");
      } catch (error) {
        if (window.ShelfLanding) { window.ShelfLanding.openAccount(); window.ShelfLanding.refreshAccount(); }
        return;
      }
    }
    if (!dialog) build(); dialog.showModal(); notice("");
    var work = [loadProjects()];
    if (!publicMode) work.push(request("/api/status").then(function (response) { return response.json(); }).then(function (data) {
        dialog.querySelector("[data-model-status]").textContent = "本地服务运行中 · " + (data.model.configured ? "已配置 " + data.model.model + (data.model.url ? " · " + data.model.url : "") : "尚未配置模型，请填写 .env 后重启");
        dialog.querySelector("[data-runtime-details]").textContent = "版本 " + data.version + " · 资料位于 " + data.dataDir;
      }));
    var results = await Promise.allSettled(work);
    if (results.some(function (result) { return result.status === "rejected"; })) notice(publicMode ? "暂时无法读取个人资料，请检查连接后重新打开。" : "暂时无法读取本地服务。请重新启动知识书架；静态演示版不提供资料维护。", true);
  });
}());
