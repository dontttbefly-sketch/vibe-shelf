import crypto from "node:crypto";
import { readStaticSvg } from "./public-svg.mjs";

const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const scriptJson = value => JSON.stringify(value).replaceAll("<", "\\u003c");

function accountBootstrap(context) {
  window.SHELF_ACCOUNT_CONTEXT = Object.freeze(context);
  var originalFetch = window.fetch;
  var warned = false;
  function accountChanged() {
    window.SHELF_ACCOUNT_CHANGED = true;
    if (warned) return;
    warned = true;
    function show() {
      var notice = document.createElement("aside");
      notice.setAttribute("role", "alert");
      notice.style.cssText = "position:fixed;left:20px;right:20px;bottom:20px;z-index:2147483647;padding:16px;background:#fffdf7;color:#151b1e;border:1px solid #ce7b51;border-radius:12px;font:15px/1.6 system-ui,sans-serif";
      notice.textContent = "此页面的登录账户已变化。请刷新后继续；当前页面的草稿仍保留在原账户中。 ";
      var button = document.createElement("button");
      button.textContent = "刷新页面";
      button.addEventListener("click", function () { window.location.reload(); });
      notice.appendChild(button); document.body.appendChild(notice);
    }
    if (document.body) show();
    else document.addEventListener("DOMContentLoaded", show, { once: true });
  }
  if (typeof originalFetch === "function") window.fetch = function (input, init) {
    var url;
    try { url = new URL(typeof input === "string" ? input : input && input.url || String(input), window.location.href); } catch (_) {}
    var owned = url && url.origin === window.location.origin && (url.pathname.indexOf("/api/") === 0 || url.pathname.indexOf("/projects/") === 0 || url.pathname === "/auth/logout");
    if (!owned) return originalFetch.call(window, input, init);
    var options = Object.assign({}, init || {});
    var headers = new Headers(options.headers || input && input.headers || undefined);
    headers.set("X-Shelf-Owner", context.userId); options.headers = headers;
    return originalFetch.call(window, input, options).then(function (response) {
      if (response.status === 401 || response.status === 409) response.clone().json().then(function (body) {
        if (body && body.error && body.error.kind === "account-changed") accountChanged();
      }).catch(function () {});
      return response;
    });
  };
  ["localStorage", "sessionStorage"].forEach(function (name) {
    var raw;
    try { raw = window[name]; } catch (_) {}
    var prefix = "shelf-account:" + context.userId + ":";
    if (raw && name === "sessionStorage" && context.userId !== "guest") {
      // Explicit, one-shot OAuth handoff; never copy notes, files or a library.
      var draftKey = "shelf-login-import-draft", guestKey = "shelf-account:guest:" + draftKey;
      try {
        var saved = raw.getItem(guestKey);
        if (saved && saved.length <= 8192) {
          var input = JSON.parse(saved), draft = {};
          if (input && typeof input === "object" && !Array.isArray(input)) {
            ["name", "repo", "readingIntent", "readingFocus", "sourceType"].forEach(function (key) {
              if (typeof input[key] === "string" && input[key].length <= 1000) draft[key] = input[key];
            });
            raw.setItem(prefix + draftKey, JSON.stringify(draft));
          }
        }
        raw.removeItem(guestKey);
      } catch (_) {}
    }
    function unavailable() { var error = new Error("浏览器存储不可用，内容尚未持久保存。"); error.name = "SecurityError"; throw error; }
    function keys() {
      if (!raw) return [];
      var list = [];
      for (var i = 0; i < raw.length; i++) {
        var key = raw.key(i);
        if (key && key.indexOf(prefix) === 0) list.push(key.slice(prefix.length));
      }
      return list;
    }
    var scoped = {
      getItem: function (key) { return raw ? raw.getItem(prefix + String(key)) : null; },
      setItem: function (key, value) { if (!raw) unavailable(); raw.setItem(prefix + String(key), String(value)); },
      removeItem: function (key) { if (!raw) unavailable(); raw.removeItem(prefix + String(key)); },
      clear: function () { if (!raw) unavailable(); keys().forEach(function (key) { scoped.removeItem(key); }); },
      key: function (index) { return keys()[Number(index)] || null; },
    };
    Object.defineProperty(scoped, "length", { get: function () { return keys().length; } });
    Object.defineProperty(window, name, { configurable: true, value: scoped });
  });
}

function readerProgress() {
  function update() {
    var element = document.querySelector(".progress");
    if (element) element.style.width = (100 * window.scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight)) + "%";
  }
  window.addEventListener("scroll", update, { passive: true });
  update();
}

export function publicPolicy(nonce) {
  return `default-src 'none'; script-src 'nonce-${nonce}' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://avatars.githubusercontent.com; font-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'self'`;
}

export function renderPublicIndex(html, userId = "guest") {
  const nonce = crypto.randomBytes(24).toString("base64url");
  const boot = `<script nonce="${nonce}">(${accountBootstrap.toString()})(${scriptJson({ mode: "public", userId })});</script>`;
  // Only repository-owned root HTML is allowed here. Generated book HTML never
  // reaches this branch, so adding nonces cannot endorse model-authored scripts.
  const output = html.replace(/<script\b(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`).replace(/<head\b[^>]*>/i, match => match + boot);
  return { html: output, policy: publicPolicy(nonce) };
}

const ALLOWED = new Set("div main section article header footer nav aside span h1 h2 h3 h4 h5 h6 p br hr strong b em i u s del ins small sub sup ul ol li dl dt dd blockquote pre code table thead tbody tfoot tr th td caption colgroup col a details summary abbr mark time figure figcaption".split(" "));
const RAW = new Set(["script", "style", "iframe", "object", "template", "math", "textarea", "xmp", "title"]);
const unsafeCss = css => /[\\<]|url\s*\(|@import|\b(?:image|image-set)\s*\(|expression\s*\(|-moz-binding|(?:^|[;{]\s*)behavior\s*:/i.test(css);
const FALLBACK_STYLE = ":root{--paper:#fffdf7;--ink:#151b1e;--code-bg:#f5f1ea;--code-ink:#151b1e;--line:#ddd7cc}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.8 system-ui,sans-serif}.book-header,.book-layout,footer{max-width:1080px;margin:auto;padding:32px}.book-layout{display:grid;grid-template-columns:180px minmax(0,1fr);gap:36px}.book-toc a{display:block;color:inherit}.chapter{margin-bottom:48px}pre{overflow:auto;background:var(--code-bg);padding:20px}table{max-width:100%;border-collapse:collapse}td,th{padding:8px;border:1px solid var(--line)}@media(max-width:700px){.book-layout{display:block}.book-toc{margin-bottom:32px}}";

// Reconstruct a small reading-only HTML vocabulary. No model URL, script,
// event handler, form control, DOM-clobbering name, or embedded document survives.
export function sanitizePublicBody(source) {
  let output = "", offset = 0, figure = 0;
  const lower = source.toLowerCase();
  while (offset < source.length) {
    const start = source.indexOf("<", offset);
    if (start < 0) { output += source.slice(offset); break; }
    output += source.slice(offset, start);
    if (source.startsWith("<!--", start)) {
      const end = source.indexOf("-->", start + 4); offset = end < 0 ? source.length : end + 3; continue;
    }
    let end = start + 1, quote = null;
    for (; end < source.length; end++) {
      const char = source[end];
      if (quote) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (end === source.length) { output += escape(source.slice(start)); break; }
    const token = source.slice(start, end + 1), match = token.match(/^<(\/?)\s*([a-z][a-z0-9:-]*)\b/i);
    offset = end + 1;
    if (!match) continue;
    const closing = Boolean(match[1]), tag = match[2].toLowerCase();
    if (tag === "svg" && !closing) {
      const drawing = readStaticSvg(source, start, ++figure);
      output += drawing.html; offset = drawing.offset; continue;
    }
    if (RAW.has(tag) && !closing) {
      const closingTag = new RegExp("</" + tag + "\\s*>", "g"); closingTag.lastIndex = offset;
      const found = closingTag.exec(lower); offset = found ? found.index + found[0].length : source.length;
      continue;
    }
    if (!ALLOWED.has(tag)) continue;
    if (closing) { output += `</${tag}>`; continue; }
    const attrs = [];
    for (const attr of token.slice(match[0].length, -1).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      const name = attr[1].toLowerCase(), value = attr[2] ?? attr[3] ?? attr[4] ?? "";
      if (["class", "title", "role", "aria-label", "aria-hidden"].includes(name) && value.length <= 500) attrs.push(`${name}="${escape(value)}"`);
      else if (name === "style" && value.length <= 2000 && !unsafeCss(value) && !value.includes("&")) attrs.push(`style="${escape(value)}"`);
      else if (name === "id" && /^[A-Za-z][A-Za-z0-9_:-]{0,159}$/.test(value) && !/^(?:SHELF_|shelf-|nb-)/i.test(value)) attrs.push(`id="${escape(value)}"`);
      else if (name === "href" && tag === "a" && /^#[A-Za-z][A-Za-z0-9_:-]{0,159}$/.test(value)) attrs.push(`href="${escape(value)}"`);
      else if (["colspan", "rowspan", "start"].includes(name) && /^\d{1,3}$/.test(value)) attrs.push(`${name}="${value}"`);
      else if (name === "data-file" && /^[\w./\-\u0080-\uffff]{1,500}$/.test(value)) attrs.push(`${name}="${escape(value)}"`);
      else if (name === "data-line" && /^\d{1,9}$/.test(value)) attrs.push(`${name}="${value}"`);
      else if (name === "open" && tag === "details") attrs.push("open");
    }
    output += `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}>`;
  }
  return output;
}

function safeStyle(source) {
  const css = source.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i)?.[1] || "";
  // Reject whole unexpected skins instead of trying to normalize CSS escapes.
  return unsafeCss(css) || !css ? FALLBACK_STYLE : css;
}

export function renderPublicBook({ html, book, userId = "guest", readOnly = false }) {
  const nonce = crypto.randomBytes(24).toString("base64url");
  const context = { projectId: book.projectId, bookId: book.id, kind: book.kind || "main", sourceSnapshotId: book.sourceSnapshotId, publicMode: true };
  // The compiled reader contains both the model body and old injected tools.
  // Take only the original progress-to-first-script region, then reconstruct it.
  const start = html.search(/<div\b[^>]*class=["'][^"']*\bprogress\b/i);
  let body = start >= 0 ? html.slice(start) : html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] || "";
  const scriptAt = body.search(/<script\b/i);
  if (scriptAt >= 0) body = body.slice(0, scriptAt);
  body = body.replace(/<section\b[^>]*data-shelf-explore[^>]*>[\s\S]*?<\/section>/gi, "");
  const script = name => `<script nonce="${nonce}" src="/${name}.js"></script>`;
  const output = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(book.title)}</title><link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<script nonce="${nonce}">(${accountBootstrap.toString()})(${scriptJson({ mode: "public", userId, readOnly })});</script>${script("theme")}
<style>${safeStyle(html)}</style><link rel="stylesheet" href="/notes.css"><link rel="stylesheet" href="/explore.css"></head><body data-shelf-reader>
<header class="shelf-topbar" data-shelf-reader-topbar aria-label="书架导航"><a data-shelf-back href="/#library">← 书架</a><span data-shelf-book-title>${escape(book.title)}</span>${readOnly ? '<a data-shelf-example-create href="/#upload">生成自己的读本</a>' : ""}</header>
${sanitizePublicBody(body)}
${readOnly ? "" : '<section data-shelf-explore></section>'}
<script nonce="${nonce}">window.SHELF_CONTEXT=${scriptJson(context)};window.SHELF_BOOK=${scriptJson(book.id)};(${readerProgress.toString()})();</script>
${readOnly ? "" : script("reader-core") + script("notes") + script("explore")}</body></html>`;
  return { html: output, policy: publicPolicy(nonce) };
}
