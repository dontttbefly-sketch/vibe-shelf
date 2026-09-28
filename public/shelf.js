/* 知识书架首页：导入本地项目，并以“书”呈现已有项目。 */
(function () {
  "use strict";

  function makeProjectId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return "p-" + window.crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    }
    return "p-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  async function request(url, options) {
    var response = await fetch(url, options);
    var data;
    try { data = await response.json(); } catch (error) { data = null; }
    if (!response.ok) throw new Error(data && data.error && data.error.message ? data.error.message : "请求没有成功");
    return data;
  }

  function setStatus(form, text, type) {
    var status = form.querySelector("[data-import-status]");
    status.textContent = text || "";
    status.dataset.state = type || "";
  }

  function setFileLabel(form, selector, text) {
    var label = form.querySelector(selector);
    if (label) label.textContent = text;
  }

  function setPickState(form, pickerSelector, actionSelector, selected) {
    var picker = form.querySelector(pickerSelector);
    if (!picker) return;
    picker.classList.toggle("is-complete", Boolean(selected));
    var action = picker.querySelector(actionSelector);
    if (action) action.textContent = selected ? "已添加" : "选择";
  }

  function refreshLauncherState(form) {
    var hasName = Boolean(form.elements.name.value.trim());
    var hasFolder = Boolean(form.elements.folder.files.length);
    form.dataset.launcherState = hasName && hasFolder
      ? "ready"
      : hasFolder
        ? "source"
        : hasName
          ? "named"
          : "idle";
  }

  function bindImportAffordances(form) {
    var folderInput = form.elements.folder;
    var nameInput = form.elements.name;
    var githubImport = form.querySelector("[data-github-import]");

    nameInput.addEventListener("input", function () { refreshLauncherState(form); });

    folderInput.addEventListener("change", function () {
      var files = folderInput.files;
      var root = files[0] && files[0].webkitRelativePath ? files[0].webkitRelativePath.split("/")[0] : "";
      setFileLabel(form, "[data-folder-label]", root
        ? root + " · 已选择 " + files.length + " 个文件"
        : "添加项目源码");
      setPickState(form, "[data-folder-pick]", "[data-folder-action]", files.length);
      refreshLauncherState(form);
    });

    if (githubImport) {
      githubImport.addEventListener("click", async function () {
        githubImport.classList.remove("is-noticing");
        void githubImport.offsetWidth;
        githubImport.classList.add("is-noticing");
        githubImport.addEventListener("animationend", function () { githubImport.classList.remove("is-noticing"); }, { once: true });

        var repo = window.prompt("GitHub 仓库（支持 owner/name 或完整仓库地址）", "");
        if (!repo) return;
        repo = repo.trim();
        if (!repo) return;
        githubImport.disabled = true;
        setStatus(form, "正在从 GitHub 拉取仓库文件…", "loading");
        try {
          var data = await request("/api/projects/import-github", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repo: repo }),
          });
          var project = data.project || {};
          setStatus(form, "仓库「" + (project.name || repo) + "」已导入，开始生成主书…", "loading");
          showGenerating(form, GENERATION_STAGE_COPY.reading);
          startPolling(form, project.id);
          // 项目卡片即时上书架，不用等生成
          var list = document.querySelector("[data-project-list]");
          if (list && list.firstElementChild && list.firstElementChild.classList.contains("shelf-empty")) list.replaceChildren();
          if (list) list.prepend(makeBookCard(project));
        } catch (error) {
          setStatus(form, "GitHub 导入失败：" + (error.message || "未知原因"), "error");
        } finally {
          githubImport.disabled = false;
        }
      });
    }

    refreshLauncherState(form);
  }

  function timeAgo(ts) {
    if (!ts) return "";
    var minutes = Math.floor((Date.now() - ts) / 60000);
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return minutes + " 分钟前";
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + " 小时前";
    var days = Math.floor(hours / 24);
    if (days < 30) return days + " 天前";
    return Math.floor(days / 30) + " 个月前";
  }

  function projectState(project) {
    return project.generationStatus || "ready";
  }

  // 主书只喂给模型一部分源码：丢了多少必须说出来，否则书缺了半本而界面一片正常
  function skippedSourceCount(coverage) {
    if (!coverage) return 0;
    return Number(coverage.skippedTooLarge || 0)
      + Number(coverage.skippedOverBudget || 0)
      + Number(coverage.skippedUnreadable || 0);
  }

  function skippedSourceDetail(coverage) {
    var parts = [];
    if (Number(coverage.skippedTooLarge || 0)) parts.push(Number(coverage.skippedTooLarge) + " 个超出单文件上限");
    if (Number(coverage.skippedOverBudget || 0)) parts.push(Number(coverage.skippedOverBudget) + " 个超出总量预算");
    if (Number(coverage.skippedUnreadable || 0)) parts.push(Number(coverage.skippedUnreadable) + " 个读取失败");
    return parts.join("，");
  }

  function mainBookUrl(projectOrId) {
    var projectId = typeof projectOrId === "string" ? projectOrId : projectOrId.id;
    var bookId = typeof projectOrId === "string" ? "main" : (projectOrId.mainBookId || "main");
    return "projects/" + encodeURIComponent(projectId) + "/books/" + encodeURIComponent(bookId) + "/";
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function playBookOpenTransition(trigger, url) {
    if (!url) return;
    if (document.body.classList.contains("shelf-is-opening-book")) return;
    if (prefersReducedMotion()) {
      window.location.assign(url);
      return;
    }
    if (trigger && trigger.classList) trigger.classList.add("is-opening");
    document.body.classList.add("shelf-is-opening-book");
    window.setTimeout(function () { window.location.assign(url); }, 220);
  }

  function disableBookLink(link) {
    link.href = "#";
    link.setAttribute("aria-disabled", "true");
    link.addEventListener("click", function (event) { event.preventDefault(); });
  }

  // 生成中的项目卡片：在导入表单里轮询是不够的——刷新页面后表单没了，
  // 卡片就永远停在"主书生成中…"且点不动，只能靠用户自己再刷一次。
  var pollingCards = {};
  function pollGeneratingCard(link, projectId) {
    if (pollingCards[projectId]) return;
    pollingCards[projectId] = true;
    var attempts = 0;
    var timer = setInterval(async function () {
      attempts += 1;
      if (attempts > 200) { clearInterval(timer); delete pollingCards[projectId]; return; }
      try {
        var data = await request("/api/projects/" + encodeURIComponent(projectId) + "/generation");
        var generation = data.generation || {};
        if (generation.status === "ready" || generation.status === "failed") {
          clearInterval(timer);
          delete pollingCards[projectId];
          loadProjects();
          return;
        }
        var detail = link.querySelector("small");
        if (detail) detail.textContent = GENERATION_STAGE_COPY[generation.stage] || "主书生成中…";
      } catch (error) {
        clearInterval(timer);
        delete pollingCards[projectId];
      }
    }, 1500);
  }

  function makeBookCard(project) {
    var state = projectState(project);
    var link = document.createElement("a");
    link.className = "shelf-book-card";
    link.href = mainBookUrl(project);
    link.dataset.projectId = project.id;
    var spine = document.createElement("span");
    spine.className = "shelf-book-spine";
    spine.textContent = (project.name || "书").trim().charAt(0) || "书";
    var content = document.createElement("span");
    content.className = "shelf-book-card-content";
    var title = document.createElement("strong");
    title.textContent = project.name;
    var detail = document.createElement("small");
    var stateBadge = null;
    if (state === "generating") {
      detail.textContent = "主书生成中…";
      link.classList.add("is-generating");
      disableBookLink(link);
      pollGeneratingCard(link, project.id);
    } else if (state === "failed") {
      detail.textContent = "主书生成失败";
      link.classList.add("is-failed");
      disableBookLink(link);
      stateBadge = document.createElement("span");
      stateBadge.className = "shelf-book-retry";
      stateBadge.setAttribute("role", "button");
      stateBadge.textContent = "重试生成";
      stateBadge.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        stateBadge.textContent = "重试中…";
        request("/api/projects/" + encodeURIComponent(project.id) + "/generation", { method: "POST" })
          .then(function () { loadProjects(); })
          .catch(function (error) { stateBadge.textContent = error.message; });
      });
    } else {
      var count = project.bookCount || 0;
      detail.textContent = count > 0
        ? count + " 本书 · " + (project.lastOpenedAt ? timeAgo(project.lastOpenedAt) : "继续阅读")
        : "主书还没有生成";
      if (count <= 0) disableBookLink(link);
      else {
        link.addEventListener("click", function (event) {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
          event.preventDefault();
          playBookOpenTransition(link, link.href);
        });
      }
    }
    content.appendChild(title);
    content.appendChild(detail);
    if (stateBadge) content.appendChild(stateBadge);
    var skippedSources = skippedSourceCount(project.sourceCoverage);
    if (state !== "generating" && state !== "failed" && skippedSources > 0) {
      var sourceNote = document.createElement("small");
      sourceNote.className = "shelf-book-note";
      sourceNote.textContent = "另有 " + skippedSources + " 个源码文件未参与生成";
      sourceNote.title = skippedSourceDetail(project.sourceCoverage);
      content.appendChild(sourceNote);
    }
    link.appendChild(spine);
    link.appendChild(content);
    return link;
  }

  function renderProjects(projects) {
    var root = document.querySelector("[data-project-list]");
    root.replaceChildren();
    if (!projects.length) {
      var empty = document.createElement("p");
      empty.className = "shelf-empty";
      empty.textContent = "还没有项目。选一个本地文件夹，从第一本书开始。";
      root.appendChild(empty);
      return;
    }
    projects.forEach(function (project) { root.appendChild(makeBookCard(project)); });
  }

  const GENERATION_STAGE_COPY = {
    reading: "正在读取源码文件…",
    writing: "AI 正在写项目主书…这可能需要一两分钟",
  };

  function showGenerating(form, stageText) {
    form.querySelector("[data-generating]").hidden = false;
    form.querySelector("[data-generating-stage]").textContent = stageText;
  }

  function startPolling(form, projectId) {
    var attempts = 0;
    var timer = setInterval(async function () {
      attempts += 1;
      if (attempts > 200) {
        clearInterval(timer);
        setStatus(form, "生成超时了。项目已保存，稍后可以在书架里重试。", "error");
        form.querySelector("button[type=submit]").disabled = false;
        return;
      }
      try {
        var data = await request("/api/projects/" + encodeURIComponent(projectId) + "/generation");
        var generation = data.generation || {};
        if (generation.status === "ready") {
          clearInterval(timer);
          var skipped = skippedSourceCount(generation.sourceCoverage);
          setStatus(form, skipped
            ? "主书生成完成（另有 " + skipped + " 个源码文件未参与），正在打开…"
            : "主书生成完成，正在打开…", "loading");
          playBookOpenTransition(form, mainBookUrl(projectId));
          return;
        }
        if (generation.status === "failed") {
          clearInterval(timer);
          showGenerating(form, "");
          setStatus(form, "生成失败：" + (generation.error || "未知原因") + " · 点击按钮重试", "error");
          var retryButton = form.querySelector("button[type=submit]");
          retryButton.disabled = false;
          retryButton.dataset.retry = "1";
          return;
        }
        showGenerating(form, GENERATION_STAGE_COPY[generation.stage] || "正在生成项目主书…");
      } catch (error) {
        clearInterval(timer);
        setStatus(form, error.message, "error");
        form.querySelector("button[type=submit]").disabled = false;
      }
    }, 1500);
  }

  async function loadProjects() {
    var root = document.querySelector("[data-project-list]");
    try {
      var data = await request("/api/projects");
      renderProjects(data.projects || []);
    } catch (error) {
      root.textContent = "暂时无法读取项目书架。请确认本地服务正在运行。";
    }
  }

  function bindImport() {
    var form = document.querySelector("[data-project-import]");
    if (!form) return;
    bindImportAffordances(form);
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      var button = form.querySelector("button[type=submit]");
      var folder = form.elements.folder.files;
      var name = form.elements.name.value.trim();
      if (!folder.length || !name) {
        setStatus(form, "请先填写项目名，并选择项目源码文件夹。", "error");
        return;
      }

      button.disabled = true;
      if (button.dataset.retry === "1") {
        // 重试：项目已存在，只重新触发生成
        button.dataset.retry = "";
        setStatus(form, "正在重新生成主书…", "loading");
        startPolling(form, form.dataset.projectId);
        try {
          await request("/api/projects/" + encodeURIComponent(form.dataset.projectId) + "/generation", { method: "POST" });
        } catch (error) {
          setStatus(form, error.message, "error");
          button.disabled = false;
        }
        return;
      }

      button.disabled = true;
      setStatus(form, "正在读取源码文件…", "loading");
      try {
        var files = await window.ShelfImport.readDirectoryTextFiles(folder);
        if (!files.length) {
          throw new Error(files.skipped
            ? "所选文件夹里没有可导入的文本源码（跳过了 " + files.skipped + " 个依赖目录/二进制/超大文件）"
            : "所选文件夹中没有可导入的文本源码文件");
        }
        setStatus(form, "正在创建项目…" + (files.truncated ? "（文件较多，只导入前 " + files.length + " 个）" : ""), "loading");
        var projectId = makeProjectId();
        form.dataset.projectId = projectId;
        var result = await request("/api/projects/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: name, projectId: projectId, files: files }),
        });
        setStatus(form, "项目已创建，开始生成主书…", "loading");
        startPolling(form, result.project.id);
      } catch (error) {
        setStatus(form, error.message, "error");
        button.disabled = false;
      }
    });
  }

  // 滚动入场：data-reveal 元素进入视口时依次浮现
  if ("IntersectionObserver" in window) {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: .12 });
    document.querySelectorAll("[data-reveal]").forEach(function (el, index) {
      el.style.transitionDelay = (index % 3) * 90 + "ms";
      revealObserver.observe(el);
    });
  } else {
    document.querySelectorAll("[data-reveal]").forEach(function (el) { el.classList.add("is-visible"); });
  }

  bindImport();
  loadProjects();
}());
