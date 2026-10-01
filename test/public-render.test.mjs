import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import { renderPublicBook, renderPublicIndex, sanitizePublicBody } from "../lib/public-render.mjs";

function storage() {
  const map = new Map();
  return { get length() { return map.size; }, key: index => [...map.keys()][index] ?? null, getItem: key => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key), clear: () => map.clear() };
}
function open(userId, localStorage, sessionStorage, extra = {}) {
  const page = renderPublicIndex("<html><head></head><body></body></html>", userId);
  const code = page.html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  const window = { localStorage, sessionStorage, ...extra };
  vm.runInNewContext(code, { window, URL, Headers });
  return window;
}

test("synchronous public bootstrap namespaces all storage methods and preserves original local data", () => {
  const local = storage(), session = storage();
  local.setItem("shelf-notes-same", "local-owner");
  const a = open("github-1", local, session);
  a.localStorage.setItem("shelf-notes-same", "A");
  a.localStorage.setItem("draft", "A draft");
  assert.equal(a.localStorage.length, 2); assert.equal(a.localStorage.key(0), "shelf-notes-same");
  const b = open("github-2", local, session);
  assert.equal(b.localStorage.length, 0); assert.equal(b.localStorage.getItem("shelf-notes-same"), null);
  b.localStorage.setItem("shelf-notes-same", "B");
  b.localStorage.clear();
  assert.equal(a.localStorage.getItem("shelf-notes-same"), "A");
  assert.equal(local.getItem("shelf-notes-same"), "local-owner");
  assert.equal(a.SHELF_ACCOUNT_CONTEXT.userId, "github-1");
});

test("unavailable browser storage cannot report in-memory writes as durable success", () => {
  const user = open("github-1", undefined, undefined);
  assert.equal(user.localStorage.getItem("draft"), null);
  assert.throws(() => user.localStorage.setItem("draft", "text"), error => error.name === "SecurityError");
  assert.throws(() => user.localStorage.removeItem("draft"), error => error.name === "SecurityError");
  assert.throws(() => user.sessionStorage.clear(), error => error.name === "SecurityError");
});

test("bootstrap binds API fetches to the page account, preserves headers, and never leaks the owner header cross-origin", async () => {
  const calls = [];
  const user = open("github-1", storage(), storage(), {
    location: { href: "https://shelf.example/", origin: "https://shelf.example" },
    fetch: async (input, init) => { calls.push({ input, init }); return new Response("ok"); },
  });
  await user.fetch("/api/projects/p/preview", { headers: { Accept: "application/json", "X-Shelf-Owner": "github-2" } });
  await user.fetch(new Request("https://shelf.example/api/projects", { headers: { Accept: "application/json" } }));
  await user.fetch("/auth/logout", { method: "POST" });
  await user.fetch("/projects/p/books/main/");
  await user.fetch("https://elsewhere.example/api/projects", { headers: { Accept: "text/plain" } });
  for (const call of calls.slice(0, 4)) assert.equal(call.init.headers.get("X-Shelf-Owner"), "github-1");
  assert.equal(calls[0].init.headers.get("Accept"), "application/json");
  assert.equal(calls[1].init.headers.get("Accept"), "application/json");
  assert.equal(new Headers(calls[4].init.headers).get("X-Shelf-Owner"), null);
});

test("OAuth draft handoff copies only explicit lightweight fields once, without moving guest notes", () => {
  const local = storage(), session = storage(), guest = open("guest", local, session);
  guest.sessionStorage.setItem("shelf-login-import-draft", JSON.stringify({ name: "Project", repo: "o/r", readingIntent: "core", readingFocus: "讲清调度", sourceType: "github", files: ["private source"] }));
  guest.sessionStorage.setItem("shelf-notes-p-main", "guest notes");
  const user = open("github-1", local, session);
  assert.deepEqual(JSON.parse(user.sessionStorage.getItem("shelf-login-import-draft")), { name: "Project", repo: "o/r", readingIntent: "core", readingFocus: "讲清调度", sourceType: "github" });
  assert.equal(guest.sessionStorage.getItem("shelf-login-import-draft"), null);
  assert.equal(user.sessionStorage.getItem("shelf-notes-p-main"), null);
  assert.equal(guest.sessionStorage.getItem("shelf-notes-p-main"), "guest notes");
});

test("reading sanitizer reconstructs only safe elements and source attributes", () => {
  const output = sanitizePublicBody('<section class="chapter" id="ch1"><h2>Heading</h2><a href="&#106;avascript:alert(1)" onfocus=alert(1)>bad</a><pre data-file="src/a.js" data-line="12"><code>&lt;script&gt;</code></pre><svg><script>alert(1)</script></svg><form name="SHELF_CONTEXT"><input></form></section>');
  assert.ok(!output.includes("javascript")); assert.ok(!output.includes("alert")); assert.ok(!output.includes("<script")); assert.ok(!output.includes("<form"));
  assert.match(output, /data-file="src\/a.js" data-line="12"/);
  assert.ok(output.includes("&lt;script&gt;"));
});

test("malformed quoted markup is escaped in full, including nested image, style and form tokens", () => {
  for (const tag of ['<img src=/auth/github onerror=evil()>', '<style>body{background:red}</style>', '<form action=/api/write>']) {
    const input = '<p>Safe text</p><a title="unfinished ' + tag;
    const output = sanitizePublicBody(input);
    assert.ok(output.startsWith("<p>Safe text</p>"));
    assert.ok(!output.includes(tag));
    assert.ok(!/<(?:img|style|form)\b/i.test(output));
    assert.ok(output.includes("&lt;a title=&quot;unfinished"));
  }
});

test("public renderer preserves ordinary child selectors and scroll behavior while refusing network-bearing skins", () => {
  const render = css => renderPublicBook({ html: `<style>${css}</style><div class="progress"></div><main class="book-main"><p>正文</p></main><script>evil()</script>`, book: { id: "main", projectId: "test", title: "Test" } }).html;
  const normal = "html{scroll-behavior:smooth}.chapter > h2{color:#222}";
  assert.ok(render(normal).includes(`<style>${normal}</style>`));
  for (const css of ['body{background:url(https://evil.example)}', 'body{background:image-set("/api/side-effect" 1x)}', '@import "https://evil.example";']) {
    const page = render(css);
    assert.ok(!page.includes(css)); assert.ok(page.includes("--paper:#fffdf7")); assert.ok(page.includes("正文"));
  }
});

test("static SVG keeps diagram geometry, labels and validated local marker and clip references", () => {
  const input = '<svg viewBox="0 0 100 80" role="img" aria-label="diagram"><defs><marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="var(--ink)"/></marker><clipPath id="window"><rect width="50" height="40"/></clipPath></defs><g clip-path="url(#window)"><line x1="0" y1="0" x2="80" y2="40" marker-end="url(#arrow)" stroke="var(--fig-green)"/><text x="20" y="15" text-anchor="middle">K &amp; V<tspan dx="2">缓存</tspan></text><ellipse cx="20" cy="20" rx="5" ry="3"/><polyline points="1,2 3,4"/></g></svg><p>after</p>';
  const output = sanitizePublicBody(input);
  assert.match(output, /<svg viewBox="0 0 100 80" role="img" aria-label="diagram">/);
  assert.match(output, /<marker id="shelf-figure-1-arrow"/);
  assert.match(output, /<clipPath id="shelf-figure-1-window">/);
  assert.match(output, /clip-path="url\(#shelf-figure-1-window\)"/);
  assert.match(output, /marker-end="url\(#shelf-figure-1-arrow\)"/);
  assert.match(output, /<text x="20" y="15" text-anchor="middle">K &amp; V<tspan dx="2">缓存<\/tspan><\/text>/);
  assert.ok(output.endsWith('</svg><p>after</p>'));
});

test("SVG sanitizer rejects active elements, namespace tricks, external and ambiguous fragment references", () => {
  const output = sanitizePublicBody('<svg viewBox="0 0 10 10" onload="evil()" xmlns:xlink="evil"><script>evil()</script><foreignObject><div>foreign payload</div></foreignObject><image href="/auth/github"/><use href="#target"/><a xlink:href="javascript:evil()"><text>linked payload</text></a><animate attributeName="href" values="evil"/><set attributeName="onload" to="evil"/><path id="target" d="M0 0L1 1" style="fill:url(/auth/github)" fill="url(https://evil.test)" stroke="url(&#35;target)" marker-end="url(#missing)"/><defs><marker id="same"/><marker id="same"/></defs><line marker-end="url(#same)"/><text onmouseover="evil()">Safe</text></svg>');
  assert.ok(!/evil|foreign payload|linked payload|href=|onload|onmouseover|<script|<foreignObject|<image|<use|<animate|<set|xmlns|style=|url\(/i.test(output));
  assert.match(output, /<path id="shelf-figure-1-target" d="M0 0L1 1"><\/path>/);
  assert.match(output, /<text>Safe<\/text>/);
  assert.equal((output.match(/id=/g) || []).length, 1);
  const wrongType = sanitizePublicBody('<svg><path id="notMarker" d="M0 0"/><line marker-end="url(#notMarker)"/><g id="notClip"/><rect clip-path="url(#notClip)"/></svg>');
  assert.ok(!wrongType.includes('url('));
  const separate = sanitizePublicBody('<svg><defs><marker id="arrow"/></defs></svg><svg><line marker-end="url(#arrow)"/></svg>');
  assert.ok(!separate.includes('marker-end='));
});

test("SVG reconstructs balanced static markup and escapes malformed quoted tails without namespace breakout", () => {
  for (const input of [
    '<svg><g><text>Safe</g></text><foreignObject><script>evil()</script></foreignObject></svg><p>After</p>',
    '<svg><title><img src=/auth/github onerror=evil()></title><desc><iframe src=/auth/github></iframe></desc></svg>',
    '<svg><g title="unfinished <image href=/auth/github onload=evil()>',
    '<svg><g><![CDATA[<script>evil()</script>]]></g></svg>',
  ]) {
    const output = sanitizePublicBody(input);
    assert.ok(!/<(?:script|img|image|iframe|foreignObject)\b/i.test(output), output);
    for (const tag of output.matchAll(/<[^>]*>/g)) assert.ok(!/\s(?:href|src|onload|onerror)=/.test(tag[0]), output);
    assert.equal((output.match(/<svg\b/g) || []).length, (output.match(/<\/svg>/g) || []).length);
  }
});

test("all 11 real evolution-course diagrams preserve every static element, label and presentation attribute", t => {
  const file = new URL('../public/projects/llm-evolution-course/books/main/index.html', import.meta.url);
  if (!fs.existsSync(file)) return t.skip('The locally retained evolution-course example is absent in this checkout.');
  const original = fs.readFileSync(file, 'utf8');
  const diagrams = [...original.matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi)].map(match => match[0]);
  assert.equal(diagrams.length, 11);
  for (const diagram of diagrams) {
    const actual = sanitizePublicBody(diagram);
    // These real diagrams require no filtering or ID rewriting. Self-closing
    // geometry normalizes to explicit closing tags; every original attribute
    // and every teaching label must otherwise survive byte for byte.
    const normalized = diagram.replace(/<([a-zA-Z]+)([^>]*?)\s*\/>/g, '<$1$2></$1>');
    assert.equal(actual, normalized);
  }
  const page = renderPublicBook({ html: original, book: { projectId: 'llm-evolution-course', id: 'main', title: '进化馆' }, readOnly: true });
  assert.equal((page.html.match(/<svg\b/g) || []).length, 11);
  assert.equal((page.html.match(/<text\b/g) || []).length, 177);
  assert.ok(page.policy.includes("'strict-dynamic'"));
  for (const script of page.html.matchAll(/<script\b([^>]*)>/g)) assert.match(script[1], /nonce="[A-Za-z0-9_-]+"/);
});
