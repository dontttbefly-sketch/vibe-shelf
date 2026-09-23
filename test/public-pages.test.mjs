import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

test("homepage is the only project entry before opening the main book", () => {
  const homepage = fs.readFileSync("public/index.html", "utf8");
  const shelfScript = fs.readFileSync("public/shelf.js", "utf8");
  const projectPage = fs.readFileSync("public/project.html", "utf8");

  assert.match(homepage, /data-project-import/);
  assert.match(homepage, /data-primary-start/);
  assert.match(homepage, /data-source-choice="local"/);
  assert.match(homepage, /data-source-choice="github"/);
  assert.match(homepage, /data-github-import/);
  assert.ok(homepage.indexOf("data-primary-start") < homepage.indexOf("data-project-list"));
  assert.match(homepage, /import-files\.js/);
  assert.match(homepage, /shelf\.js/);
  assert.match(shelfScript, /mainBookUrl/);
  assert.doesNotMatch(shelfScript, /project\.html\?id/);
  assert.match(projectPage, /location\.replace/);
  assert.doesNotMatch(projectPage, /project\.js/);
});

test("homepage puts an interactive project launcher before the secondary shelf", () => {
  const homepage = fs.readFileSync("public/index.html", "utf8");
  const styles = fs.readFileSync("public/shelf.css", "utf8");

  assert.match(homepage, /data-project-launcher/);
  assert.match(homepage, /data-launcher-name/);
  assert.match(homepage, /data-reading-journey/);
  assert.ok(homepage.indexOf("data-project-launcher") < homepage.indexOf("data-project-list"));
  assert.match(styles, /\.shelf-launcher:focus-within/);
  assert.match(styles, /@keyframes shelf-launcher-arrive/);
});

test("book reader returns to the unified shelf instead of a project page", () => {
  const compiler = fs.readFileSync("lib/book-compiler.mjs", "utf8");

  assert.match(compiler, /index\.html#bookshelf/);
  assert.match(compiler, /返回书架/);
  assert.doesNotMatch(compiler, /project\.html\?id/);
});

test("opening a project book gives immediate motion feedback before navigation", () => {
  const shelfScript = fs.readFileSync("public/shelf.js", "utf8");
  const styles = fs.readFileSync("public/shelf.css", "utf8");

  assert.match(shelfScript, /playBookOpenTransition/);
  assert.match(shelfScript, /shelf-is-opening-book/);
  assert.match(shelfScript, /prefers-reduced-motion: reduce/);
  assert.match(styles, /\.shelf-book-card\.is-opening/);
  assert.match(styles, /\.shelf-page\.shelf-is-opening-book::before/);
  assert.match(styles, /@keyframes shelf-open-book/);
});

test("reader keeps the shelf return as a quiet secondary control", () => {
  const compiler = fs.readFileSync("lib/book-compiler.mjs", "utf8");
  const readerStyles = fs.readFileSync("public/notes.css", "utf8");

  assert.match(compiler, /data-shelf-reader/);
  assert.match(compiler, /data-shelf-back/);
  assert.match(readerStyles, /\[data-shelf-breadcrumb\]/);
  assert.match(readerStyles, /\[data-shelf-back\]/);
  assert.match(readerStyles, /\[data-shelf-breadcrumb\]\s*\{[^}]*top: 18px;[^}]*right: 22px;[^}]*flex-direction: row-reverse;/s);
  assert.match(readerStyles, /opacity: \.42/);
});

test("project docs describe the book-first project flow", () => {
  const readme = fs.readFileSync("README.md", "utf8");
  const baseline = fs.readFileSync("docs/superpowers/specs/2026-09-20-knowledge-shelf-requirements-baseline.md", "utf8");

  assert.match(readme, /项目是后台空间，主书是用户进入项目后的界面/);
  assert.match(baseline, /决策 2026-09-23/);
  assert.match(baseline, /不再把项目内页作为用户主流程/);
});

test("site supports a persisted dark theme across shelf and reader pages", () => {
  const homepage = fs.readFileSync("public/index.html", "utf8");
  const projectPage = fs.readFileSync("public/project.html", "utf8");
  const compiler = fs.readFileSync("lib/book-compiler.mjs", "utf8");
  const themeScript = fs.readFileSync("public/theme.js", "utf8");
  const shelfStyles = fs.readFileSync("public/shelf.css", "utf8");
  const readerStyles = fs.readFileSync("public/notes.css", "utf8");
  const exploreStyles = fs.readFileSync("public/explore.css", "utf8");
  const pupkitReader = fs.readFileSync("public/projects/pupkit/books/main/index.html", "utf8");

  assert.match(homepage, /theme\.js/);
  assert.match(projectPage, /theme\.js/);
  assert.match(compiler, /theme\.js/);
  assert.match(themeScript, /shelf-theme/);
  assert.match(themeScript, /data-theme-toggle/);
  assert.match(themeScript, /prefers-color-scheme: dark/);
  assert.match(shelfStyles, /html\[data-theme="dark"\]/);
  assert.match(readerStyles, /html\[data-theme="dark"\]/);
  assert.match(exploreStyles, /html\[data-theme="dark"\]/);
  assert.match(pupkitReader, /theme\.js/);
});

test("theme toggle is painted after it is mounted", () => {
  const themeScript = fs.readFileSync("public/theme.js", "utf8");
  const storage = new Map();

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.attributes = new Map();
      this.children = [];
      this.dataset = {};
      this.style = {};
      this.className = "";
      this.parentNode = null;
      this.textContent = "";
      this.__listeners = {};
    }

    get isConnected() {
      return Boolean(this.parentNode) || this === document.documentElement;
    }

    set innerHTML(value) {
      this.children = [];
      if (value.includes("data-theme-icon")) {
        const icon = new FakeElement("span");
        icon.setAttribute("data-theme-icon", "");
        this.appendChild(icon);
      }
      if (value.includes("data-theme-text")) {
        const text = new FakeElement("span");
        text.setAttribute("data-theme-text", "");
        this.appendChild(text);
      }
    }

    get innerHTML() {
      return this.children.map((child) => child.textContent).join("");
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    }

    addEventListener(type, handler) {
      this.__listeners[type] = this.__listeners[type] || [];
      this.__listeners[type].push(handler);
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector) {
      const matches = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (selector === "[data-theme-icon]" && child.attributes.has("data-theme-icon")) matches.push(child);
          if (selector === "[data-theme-text]" && child.attributes.has("data-theme-text")) matches.push(child);
          if (selector === "[data-theme-toggle]" && child.attributes.has("data-theme-toggle")) matches.push(child);
          walk(child);
        }
      };
      walk(this);
      return matches;
    }
  }

  const topbar = new FakeElement("div");
  topbar.className = "shelf-topbar";

  const document = {
    readyState: "complete",
    documentElement: new FakeElement("html"),
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    addEventListener() {},
    querySelector(selector) {
      if (selector === ".shelf-topbar") return topbar;
      if (selector === "[data-shelf-breadcrumb]") return null;
      if (selector === "[data-theme-toggle]") return topbar.querySelector(selector);
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-theme-toggle]") return topbar.querySelectorAll(selector);
      return [];
    },
  };

  const localStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
  };

  const context = {
    Array,
    Boolean,
    document,
    localStorage,
    window: {
      localStorage,
      matchMedia() {
        return { matches: false, addEventListener() {} };
      },
    },
  };
  context.window.window = context.window;
  context.window.document = document;
  context.window.ShelfTheme = null;

  vm.runInNewContext(themeScript, context);

  const button = topbar.querySelector("[data-theme-toggle]");
  assert.ok(button);
  assert.equal(button.getAttribute("aria-label"), "切换到夜间模式");
  assert.equal(button.querySelector("[data-theme-text]").textContent, "夜间");
  assert.equal(button.querySelector("[data-theme-icon]").textContent, "☾");

  button.__listeners.click[0]();

  assert.equal(document.documentElement.dataset.theme, "dark");
  assert.equal(storage.get("shelf-theme"), "dark");
  assert.equal(button.getAttribute("aria-label"), "切换到日间模式");
  assert.equal(button.querySelector("[data-theme-text]").textContent, "日间");
});

test("dark reader theme covers the native book header chrome", () => {
  const readerStyles = fs.readFileSync("public/notes.css", "utf8");
  const pupkitReader = fs.readFileSync("public/projects/pupkit/books/main/index.html", "utf8");

  assert.match(pupkitReader, /\.book-header\s*\{[^}]*background:\s*rgba\(251,\s*247,\s*237,\s*0\.92\)/s);
  assert.match(
    readerStyles,
    /html\[data-theme="dark"\]\s+body\[data-shelf-reader\]\s+\.book-header\s*\{[^}]*background:\s*rgba\(18,\s*16,\s*14,\s*\.92\)/s,
  );
  assert.match(
    readerStyles,
    /html\[data-theme="dark"\]\s+body\[data-shelf-reader\]\s+\.book-header\s+\.glyph\s*\{[^}]*border-color:\s*rgba\(238,\s*231,\s*221,\s*\.74\)/s,
  );
});

test("reader header copy leaves room for the floating top controls", () => {
  const readerStyles = fs.readFileSync("public/notes.css", "utf8");

  assert.match(
    readerStyles,
    /body\[data-shelf-reader\]\s+\.book-header\s*\{[^}]*padding-right:\s*clamp\(360px,\s*24vw,\s*460px\)/s,
  );
  assert.match(
    readerStyles,
    /body\[data-shelf-reader\]\s+\.book-header\s+\.sub\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
  );
});
