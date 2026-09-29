import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const { createHoverIntent, readingLabel } = require("../public/shelf-stack.js");
const { createPreviewSession } = require("../public/shelf-preview.js");

function clock() {
  let now = 0, next = 0;
  const jobs = new Map();
  return {
    setTimeout(fn, delay) { const id = ++next; jobs.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    advance(duration) {
      const end = now + duration;
      for (;;) {
        const entry = [...jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        now = entry[1].at; jobs.delete(entry[0]); entry[1].fn();
      }
      now = end;
    },
    get pending() { return jobs.size; },
  };
}

function fixture() {
  const time = clock(), changes = [];
  const intent = createHoverIntent({ ...time, open: () => changes.push("open"), close: () => changes.push("close") });
  return { time, changes, intent };
}

test("passing over a book never opens or fetches a preview; dwelling opens once after 180ms", () => {
  const { time, changes, intent } = fixture();
  intent.enter("pointer"); time.advance(179); intent.leave("pointer"); time.advance(200);
  assert.deepEqual(changes, []);
  intent.enter("pointer"); time.advance(180); intent.enter("pointer"); time.advance(500);
  assert.deepEqual(changes, ["open"]);
});

test("pointer can cross the preview bridge during leave grace without closing or refetching", () => {
  const { time, changes, intent } = fixture();
  intent.enter("pointer"); time.advance(180);
  intent.leave("pointer"); time.advance(159); intent.enter("pointer"); time.advance(500);
  assert.deepEqual(changes, ["open"]);
  intent.leave("pointer"); time.advance(159); assert.equal(intent.isOpen(), true);
  time.advance(1); assert.equal(intent.isOpen(), false);
  assert.deepEqual(changes, ["open", "close"]);
});

test("keyboard previews immediately and keeps ownership after pointer leaves", () => {
  const { time, changes, intent } = fixture();
  intent.enter("focus"); assert.deepEqual(changes, ["open"]);
  intent.enter("pointer"); intent.leave("pointer"); time.advance(1000);
  assert.equal(intent.isOpen(), true);
  intent.leave("focus"); time.advance(160);
  assert.deepEqual(changes, ["open", "close"]);
});

test("Escape suppresses reopening until focus and pointer really leave", () => {
  const { time, changes, intent } = fixture();
  intent.enter("focus"); intent.enter("pointer"); intent.dismiss();
  intent.enter("focus"); intent.enter("pointer"); time.advance(500);
  assert.deepEqual(changes, ["open", "close"]);
  intent.leave("focus"); intent.leave("pointer"); intent.enter("focus");
  assert.deepEqual(changes, ["open", "close", "open"]);
});

test("destroy cancels an unopened timer and prevents detached cards from reopening", () => {
  const { time, changes, intent } = fixture();
  intent.enter("pointer"); intent.destroy(); time.advance(1000);
  intent.enter("focus"); intent.enter("pointer"); time.advance(1000);
  assert.deepEqual(changes, []); assert.equal(time.pending, 0);
});

test("a fetch that resolves after closing never repaints; reopening gets a new session", async () => {
  const time = clock(), changes = [], pending = [];
  const session = createPreviewSession(() => new Promise(resolve => pending.push(resolve)), event => changes.push(event.state));
  let request;
  const intent = createHoverIntent({ ...time, open: () => { request = session.open({ id: "book" }); }, close: () => session.close() });
  intent.enter("pointer"); time.advance(180); await Promise.resolve();
  intent.leave("pointer"); time.advance(160);
  pending[0]({ projectId: "book" }); assert.equal((await request).state, "stale");
  assert.deepEqual(changes, ["loading", "closed"]);
  intent.enter("pointer"); time.advance(180); await Promise.resolve();
  pending[1]({ projectId: "book" }); assert.equal((await request).state, "ready");
  assert.deepEqual(changes, ["loading", "closed", "loading", "ready"]);
});

test("reading copy uses validated saved chapters, never inferred percentages or another book's record", () => {
  const project = { id: "project-a", mainBookId: "main" };
  const data = { chapters: [{ id: "overview", title: "从入口理解项目" }, { id: "core", title: "核心机制" }] };
  const record = { projectId: "project-a", bookId: "main", chapterId: "core", scrollY: 900 };
  assert.equal(readingLabel(project, data, null), "未开始阅读");
  assert.equal(readingLabel(project, data, { ...record, projectId: "project-b" }), "未开始阅读");
  assert.equal(readingLabel(project, data, { ...record, bookId: "exploration" }), "未开始阅读");
  assert.equal(readingLabel(project, data, { ...record, scrollY: NaN }), "未开始阅读");
  assert.equal(readingLabel(project, data, record), "读到 · 核心机制");
  assert.equal(readingLabel(project, data, { ...record, chapterId: "removed-chapter" }), "已开始阅读 · 已保存位置");
});

const stackSource = fs.readFileSync(new URL('../public/shelf-stack.js', import.meta.url), 'utf8');
const stackCss = fs.readFileSync(new URL('../public/shelf-stack.css', import.meta.url), 'utf8');
const previewApi = require('../public/shelf-preview.js');
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

// Mount the real module, dispatch its actual DOM/window handlers, and expose
// measured rectangles as a browser would. Bounds assertions below exercise the
// complete open/load/scroll/focus/close path rather than a copy of position().
function mountedStack({ top = 200, bottom = 582, viewportHeight = 836, loadingHeight = 130, readyHeight = 259 } = {}) {
  const time = clock(), frames = new Map(), windowEvents = new Map(), requests = [], observers = [];
  let frameId = 0;
  const geometry = { top, bottom, left: 80, width: 330, loadingHeight, readyHeight };
  function all(node) { return [node, ...node.children.flatMap(all)]; }
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = new Map();
      this.isConnected = true; this.className = ''; this.textContent = '';
      const properties = new Map();
      this.style = { properties, setProperty: (key, value) => properties.set(key, value), getPropertyValue: key => properties.get(key) || '' };
      this.classList = {
        contains: name => this.className.split(' ').includes(name),
        add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
        remove: (...names) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' '); },
        toggle: (name, enabled) => enabled ? this.classList.add(name) : this.classList.remove(name),
      };
    }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    appendChild(child) { this.children.push(child); child.parent = this; child.ownerDocument = doc; return child; }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    hasAttribute(key) { return Object.hasOwn(this.attrs, key); }
    removeAttribute(key) { delete this.attrs[key]; }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    emit(type, data = {}) { for (const fn of this.listeners.get(type) || []) fn({ type, target: this, pointerType: 'mouse', ...data }); }
    querySelector(selector) { return all(this).find(node => node.classList.contains(selector.slice(1))) || null; }
    contains(node) { return all(this).includes(node); }
    matches(selector) { return selector === ':focus-visible'; }
    closest() { return null; }
    focus() { doc.activeElement = this; card.emit('focusin', { target: this }); }
    getBoundingClientRect() {
      if (this === card) return { ...geometry, height: geometry.bottom - geometry.top, right: geometry.left + geometry.width };
      if (this.classList.contains('ss-preview')) {
        const sheet = this.children[0], loading = sheet.getAttribute('aria-busy') === 'true';
        const height = Math.min(loading ? geometry.loadingHeight : geometry.readyHeight, win.innerHeight - 32);
        const top = geometry.bottom - 6 + Number.parseFloat(this.style.getPropertyValue('--ss-preview-y') || '0');
        const left = geometry.left + Number.parseFloat(this.style.getPropertyValue('--ss-preview-x') || '0');
        return { top, bottom: top + height, height, left, right: left + geometry.width, width: geometry.width };
      }
      return { top: 0, height: 0, bottom: 0, left: 0, width: 0, right: 0 };
    }
  }
  const doc = { activeElement: null, createElement: tag => new Element(tag) };
  const win = {
    ...time, innerHeight: viewportHeight, innerWidth: 1470, ShelfPreview: previewApi, AbortController,
    localStorage: { getItem: () => null }, matchMedia: () => ({ matches: true }),
    getComputedStyle: () => ({ getPropertyValue: () => '0px' }),
    requestAnimationFrame(fn) { const id = ++frameId; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id),
    addEventListener(type, fn) { if (!windowEvents.has(type)) windowEvents.set(type, new Set()); windowEvents.get(type).add(fn); },
    removeEventListener(type, fn) { windowEvents.get(type)?.delete(fn); },
    fetch() { return new Promise(resolve => requests.push(resolve)); },
    ResizeObserver: class {
      constructor(fn) { this.callback = fn; this.connected = false; observers.push(this); }
      observe() { this.connected = true; } disconnect() { this.connected = false; }
    },
  };
  doc.defaultView = win;
  const card = new Element('article'), link = new Element('a'); card.ownerDocument = doc;
  link.className = 'shelf-book-card'; link.setAttribute('href', '/projects/geometry/books/main/'); card.appendChild(link);
  const context = { module: { exports: {} } }; vm.runInNewContext(stackSource, context);
  const handle = context.module.exports.mount(card, { id: 'geometry', name: 'Geometry', mainBookId: 'main', bookCount: 1 });
  const panel = card.querySelector('.ss-preview'), sheet = panel.children[0];
  function windowEvent(type) { for (const fn of windowEvents.get(type) || []) fn(); }
  return {
    card, link, panel, sheet, doc, win, handle, geometry, time, requests, observers,
    listenerCount: type => windowEvents.get(type)?.size || 0, frameCount: () => frames.size,
    windowEvent, flushFrames() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); },
    async load() {
      await settle();
      requests[0]({ ok: true, json: async () => ({ projectId: 'geometry', ready: true, title: 'Geometry', summary: '真实摘要', chapters: [{ id: 'entry', title: '项目入口' }] }) });
      await settle();
    },
    focusChapter() { all(panel).find(node => node.tagName === 'A' && node.textContent === '项目入口').focus(); },
  };
}

test('mounted keyboard preview remains inside the viewport after the reproduced wheel displacement and resize', async () => {
  const h = mountedStack();
  assert.equal(h.listenerCount('scroll'), 0); assert.equal(h.listenerCount('resize'), 0);
  h.link.focus(); await h.load(); h.focusChapter();
  assert.equal(h.listenerCount('scroll'), 1); assert.equal(h.listenerCount('resize'), 1);
  assert.equal(h.card.classList.contains('ss-preview-above'), false);
  // The observed native wheel moved the card down by about 253 CSS pixels.
  h.geometry.top += 253; h.geometry.bottom += 253;
  for (let i = 0; i < 8; i++) h.windowEvent('scroll');
  assert.equal(h.frameCount(), 1, 'one active preview batches a scroll burst into one frame');
  h.flushFrames();
  let rect = h.panel.getBoundingClientRect();
  assert.ok(rect.top >= 16 && rect.bottom <= 820, JSON.stringify(rect));
  assert.equal(h.card.classList.contains('ss-is-previewing'), true);
  assert.equal(h.doc.activeElement.textContent, '项目入口');
  assert.equal(h.card.style.properties.size, 0, 'positioning must not modify the card/grid geometry');
  h.win.innerHeight = 620; h.win.innerWidth = 390; h.geometry.left = 50;
  h.windowEvent('resize'); h.flushFrames(); rect = h.panel.getBoundingClientRect();
  assert.ok(rect.top >= 16 && rect.bottom <= 604 && rect.left >= 16 && rect.right <= 374, JSON.stringify(rect));
  assert.equal(h.requests.length, 1, 'scrolling and resizing do not fetch or mutate reading state');
  h.windowEvent('scroll'); h.handle.close();
  assert.equal(h.frameCount(), 0); assert.equal(h.listenerCount('scroll'), 0); assert.equal(h.listenerCount('resize'), 0);
  assert.equal(h.observers[0].connected, false);
  h.windowEvent('scroll'); assert.equal(h.frameCount(), 0);
  h.handle.destroy();
});

test('mounted loading preview grows without flipping away from a pointer already inside it', async () => {
  const h = mountedStack({ top: 350, bottom: 746, viewportHeight: 900, loadingHeight: 130, readyHeight: 320 });
  h.card.emit('pointerenter'); h.time.advance(180); await settle();
  assert.equal(h.card.classList.contains('ss-preview-above'), false);
  const before = h.panel.getBoundingClientRect(), pointerY = 800;
  assert.ok(before.top < pointerY && before.bottom > pointerY);
  h.panel.emit('pointerenter'); await h.load();
  const after = h.panel.getBoundingClientRect();
  assert.equal(h.card.classList.contains('ss-preview-above'), false, 'an occupied preview keeps its original side');
  assert.ok(after.top < pointerY && after.bottom > pointerY, JSON.stringify(after));
  assert.ok(after.top >= 16 && after.bottom <= 884);
  h.time.advance(500); assert.equal(h.card.classList.contains('ss-is-previewing'), true);
  h.handle.destroy(); assert.equal(h.listenerCount('scroll'), 0);
});

test('mounted oversized preview has a keyboard-scrollable viewport region and destroys queued geometry work', async () => {
  const h = mountedStack({ viewportHeight: 400, readyHeight: 1200 });
  h.link.focus(); await h.load();
  assert.equal(h.sheet.tabIndex, 0); assert.equal(h.sheet.getAttribute('role'), 'region');
  assert.match(stackCss, /\.ss-preview-sheet\s*\{[^}]*max-height:\s*calc\(100dvh - 45px\);[^}]*overflow-y:\s*auto;/);
  assert.match(stackCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.ss-preview, \.ss-preview-above \.ss-preview \{ transform: translate\(/);
  const rect = h.panel.getBoundingClientRect();
  assert.ok(rect.top >= 16 && rect.bottom <= 384, JSON.stringify(rect));
  h.sheet.focus(); assert.equal(h.card.classList.contains('ss-is-previewing'), true);
  h.observers[0].callback(); assert.equal(h.frameCount(), 1);
  h.handle.destroy();
  assert.equal(h.frameCount(), 0); assert.equal(h.observers[0].connected, false);
  assert.equal(h.listenerCount('scroll'), 0); assert.equal(h.listenerCount('resize'), 0);
});
