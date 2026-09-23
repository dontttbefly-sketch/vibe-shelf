/* 知识书架 · 主题切换：默认跟随系统，用户选择后本地持久化 */
(function () {
  "use strict";

  var STORAGE_KEY = "shelf-theme";
  var DARK_QUERY = "(prefers-color-scheme: dark)";
  var media = window.matchMedia ? window.matchMedia(DARK_QUERY) : null;
  var buttons = [];

  function storedTheme() {
    try {
      var value = localStorage.getItem(STORAGE_KEY);
      return value === "dark" || value === "light" ? value : null;
    } catch (error) {
      return null;
    }
  }

  function systemTheme() {
    return media && media.matches ? "dark" : "light";
  }

  function currentTheme() {
    return storedTheme() || systemTheme();
  }

  function buttonText(theme) {
    return theme === "dark" ? "日间" : "夜间";
  }

  function buttonLabel(theme) {
    return theme === "dark" ? "切换到日间模式" : "切换到夜间模式";
  }

  function updateButtons(theme) {
    buttons = buttons.filter(function (button) { return button && button.isConnected; });
    buttons.forEach(function (button) {
      button.setAttribute("aria-label", buttonLabel(theme));
      button.setAttribute("title", buttonLabel(theme));
      button.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
      var icon = button.querySelector("[data-theme-icon]");
      var text = button.querySelector("[data-theme-text]");
      if (icon) icon.textContent = theme === "dark" ? "☼" : "☾";
      if (text) text.textContent = buttonText(theme);
    });
  }

  function applyTheme(theme) {
    var next = theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    updateButtons(next);
    return next;
  }

  function setTheme(theme) {
    var next = theme === "dark" ? "dark" : "light";
    try { localStorage.setItem(STORAGE_KEY, next); } catch (error) {}
    return applyTheme(next);
  }

  function toggleTheme() {
    return setTheme(currentTheme() === "dark" ? "light" : "dark");
  }

  function createButton() {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "shelf-theme-toggle";
    button.setAttribute("data-theme-toggle", "");
    button.innerHTML = '<span data-theme-icon aria-hidden="true"></span><span data-theme-text></span>';
    button.addEventListener("click", toggleTheme);
    buttons.push(button);
    return button;
  }

  function mountThemeToggle() {
    if (document.querySelector("[data-theme-toggle]")) {
      buttons = Array.from(document.querySelectorAll("[data-theme-toggle]"));
      updateButtons(currentTheme());
      return;
    }
    var topbar = document.querySelector(".shelf-topbar");
    var breadcrumb = document.querySelector("[data-shelf-breadcrumb]");
    if (topbar) {
      topbar.appendChild(createButton());
      updateButtons(currentTheme());
      return;
    }
    if (breadcrumb) {
      breadcrumb.appendChild(createButton());
      updateButtons(currentTheme());
    }
  }

  applyTheme(currentTheme());

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountThemeToggle, { once: true });
  } else {
    mountThemeToggle();
  }

  if (media && typeof media.addEventListener === "function") {
    media.addEventListener("change", function () {
      if (!storedTheme()) applyTheme(systemTheme());
    });
  }

  window.ShelfTheme = {
    apply: applyTheme,
    current: currentTheme,
    mount: mountThemeToggle,
    set: setTheme,
    toggle: toggleTheme,
  };
}());
