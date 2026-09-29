import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
const { safeBookUrl, createGate } = createRequire(import.meta.url)('../public/shelf-transition.js');
test('opening accepts only a same-origin book and retains explicit chapter destinations', () => {
  const base = 'https://shelf.example/';
  assert.equal(safeBookUrl('/projects/p-a/books/main/#chapter', base), base + 'projects/p-a/books/main/#chapter');
  assert.equal(safeBookUrl('/examples/pupkit/books/main/', base), base + 'examples/pupkit/books/main/');
  for (const value of ['https://evil.test/projects/a/books/main/', 'javascript:alert(1)', '/auth/github', '/projects/a/books/main/../../secret', '/projects/a/books/main/%2fprivate']) assert.equal(safeBookUrl(value, base), null);
});
test('duplicate opens are gated, cancelled fetches cannot navigate a later selection', () => {
  const gate = createGate(), first = gate.begin();
  assert.equal(gate.begin(), null);
  assert.equal(gate.current(first), true);
  gate.reset();
  const second = gate.begin();
  assert.equal(gate.current(first), false);
  assert.equal(gate.current(second), true);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function mountedTransition({ reducedMotion = false, storedState = null } = {}) {
  let now = 100000, timerId = 0, focused = null, pendingDocument = null, stopCalls = 0;
  const listeners = new Map(), timers = new Map(), frames = [], requests = [], navigations = [], scrolls = [], events = [];
  const storage = new Map();
  if (storedState) storage.set('shelf-return-state', JSON.stringify(storedState));
  class Event {
    constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
    preventDefault() { this.defaultPrevented = true; }
  }
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.dataset = {};
      this.listeners = new Map(); this.style = { setProperty() {} }; this.className = '';
      this.classList = { add: value => { this.className += ' ' + value; } };
      this.isConnected = true; this.textContent = ''; this.value = ''; this.hidden = false;
    }
    append(...nodes) { nodes.forEach(node => { node.parent = this; this.children.push(node); }); }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return this.attrs[name] ?? null; }
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
    dispatchEvent(event) { for (const fn of this.listeners.get(event.type) || []) fn(event); return !event.defaultPrevented; }
    click() { this.dispatchEvent(new Event('click')); }
    querySelector(selector) { return this.children.find(node => selector === 'strong' && node.tagName === 'STRONG') || null; }
    closest(selector) { return selector === '.shelf-book-item' ? this.article || null : null; }
    focus(options) { focused = this; this.focusOptions = options; events.push({ type: 'focus', key: this.getAttribute('data-shelf-focus') }); }
    showModal() { this.open = true; }
    close() { this.open = false; }
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
    getBoundingClientRect() { return { left: 90, top: 120, width: 300, height: 380 }; }
    animate() {}
  }
  const body = new Element('body'), search = new Element('input'), sort = new Element('select'), list = new Element('div');
  sort.value = 'recent'; list.dataset.catalogLimit = '40'; list.dataset.searchLimit = '60';
  const all = new Element('button'), read = new Element('button');
  all.dataset.catalogFilter = 'all'; all.setAttribute('aria-pressed', 'true');
  read.dataset.catalogFilter = 'read'; read.setAttribute('aria-pressed', 'false');
  const filters = [all, read], visibleItems = [];
  const doc = {
    body, createElement: tag => new Element(tag),
    querySelector(selector) {
      return { '[data-shelf-search]': search, '[data-shelf-sort]': sort, '[data-project-list]': list,
        '[data-catalog-filter][aria-pressed="true"]': filters.find(item => item.getAttribute('aria-pressed') === 'true') }[selector] || null;
    },
    querySelectorAll: selector => selector === '[data-catalog-filter]' ? filters : selector === '[data-shelf-focus]' ? visibleItems : [],
  };
  const win = {
    Event, CustomEvent: Event, AbortController, scrollY: 0,
    location: { href: 'https://shelf.test/#library', hash: '#library', assign: url => { navigations.push(url); pendingDocument = url; } },
    stop() { stopCalls++; pendingDocument = null; },
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    matchMedia: () => ({ matches: reducedMotion }),
    getComputedStyle: () => ({ getPropertyValue: name => name === '--cover-paper' ? '#fffdf7' : '#151b1e' }),
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); },
    dispatchEvent(event) { events.push(event); for (const fn of listeners.get(event.type) || []) fn(event); },
    requestAnimationFrame: callback => frames.push(callback),
    scrollTo(options) { scrolls.push(options); events.push({ type: 'scroll', top: options.top }); win.scrollY = options.top; },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch(url, options) { const pending = deferred(); requests.push({ url, options, pending }); return pending.promise; },
  };
  function makeBook(id, focusKey = 'book:' + id) {
    const book = new Element('a'), title = new Element('strong'); title.textContent = 'Book ' + id;
    book.setAttribute('data-shelf-focus', focusKey); book.append(title); book.article = new Element('article');
    return book;
  }
  async function advance(duration) {
    const end = now + duration;
    for (;;) {
      const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      now = entry[1].at; timers.delete(entry[0]); entry[1].fn(); await flush();
    }
    now = end; await flush();
  }
  function flushFrames() { while (frames.length) { events.push({ type: 'frame' }); frames.shift()(); } }
  const context = { module: { exports: {} }, URL, Date: class extends Date { static now() { return now; } } };
  vm.runInNewContext(fs.readFileSync(new URL('../public/shelf-transition.js', import.meta.url), 'utf8'), context);
  const api = context.module.exports;
  api.mount(win, doc);
  return { api, win, doc, body, search, sort, list, filters, visibleItems, storage, requests, navigations, scrolls, events,
    advance, flushFrames, makeBook, focused: () => focused, stopCalls: () => stopCalls,
    commitDocument() { if (pendingDocument) { win.location.href = pendingDocument; pendingDocument = null; } },
    dispatch: (type, detail = {}) => win.dispatchEvent(new Event(type, detail)),
  };
}
function htmlResponse(url, body = async () => '<html>book</html>') {
  return { ok: true, url, headers: new Map([['content-type', 'text/html; charset=utf-8']]), text: body };
}

test('mounted reduced-motion opening resets after bfcache return so a second book actually navigates', async () => {
  const h = mountedTransition({ reducedMotion: true });
  const a = h.makeBook('a'), b = h.makeBook('b'); h.visibleItems.push(a, b);
  await h.api.open(a, '/projects/a/books/main/');
  h.dispatch('pageshow', { persisted: true }); h.flushFrames();
  await h.api.open(b, '/projects/b/books/main/');
  assert.deepEqual(h.navigations, ['https://shelf.test/projects/a/books/main/', 'https://shelf.test/projects/b/books/main/']);
  assert.equal(h.requests.length, 0, 'reduced motion navigates directly without an opening request');
  assert.equal(h.body.children.length, 0, 'reset must work even when no opening overlay was created');
});

test('cancelling a mounted opening ignores a late response and only the new selected book navigates', async () => {
  const h = mountedTransition();
  const a = h.makeBook('a'), b = h.makeBook('b');
  const first = h.api.open(a, '/projects/a/books/main/');
  await h.api.open(b, '/projects/b/books/main/');
  assert.equal(h.requests.length, 1, 'a second click while opening is ignored');
  const overlay = h.body.children[0];
  overlay.dispatchEvent({ type: 'cancel', preventDefault() {} });
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(h.focused(), a);
  assert.equal(h.body.children.length, 0);
  const second = h.api.open(b, '/projects/b/books/main/');
  h.requests[0].pending.resolve(htmlResponse(h.requests[0].url)); await first;
  assert.deepEqual(h.navigations, [], 'a late cancelled response cannot open the old book');
  await h.advance(301);
  h.requests[1].pending.resolve(htmlResponse(h.requests[1].url)); await second;
  assert.deepEqual(h.navigations, ['https://shelf.test/projects/b/books/main/']);
  assert.equal(JSON.parse(h.storage.get('shelf-book-entry')).title, 'Book b');
});

test('cancelling after response headers also prevents a late response body from navigating', async () => {
  const h = mountedTransition(), a = h.makeBook('a');
  const body = deferred();
  const opening = h.api.open(a, '/projects/a/books/main/');
  h.requests[0].pending.resolve(htmlResponse(h.requests[0].url, () => body.promise)); await flush();
  h.body.children[0].dispatchEvent({ type: 'cancel', preventDefault() {} });
  body.resolve('<html>late old book</html>'); await opening;
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.deepEqual(h.navigations, []);
  assert.equal(h.storage.has('shelf-book-entry'), false);
});

test('mounted return restores captured page limits before locating the saved book and scrolling', async () => {
  const outgoing = mountedTransition({ reducedMotion: true });
  const source = outgoing.makeBook('project-80', 'search:project-80:main');
  outgoing.search.value = 'core'; outgoing.sort.value = 'name';
  outgoing.filters[0].setAttribute('aria-pressed', 'false'); outgoing.filters[1].setAttribute('aria-pressed', 'true');
  outgoing.list.dataset.catalogLimit = '80'; outgoing.list.dataset.searchLimit = '120'; outgoing.win.scrollY = 8420;
  await outgoing.api.open(source, '/projects/project-80/books/main/');
  const state = JSON.parse(outgoing.storage.get('shelf-return-state'));
  assert.equal(state.catalogLimit, 80); assert.equal(state.searchLimit, 120);
  assert.equal(state.focus, 'search:project-80:main');

  const returned = mountedTransition({ storedState: state });
  const destination = returned.makeBook('project-80', state.focus);
  returned.search.addEventListener('input', () => { returned.list.dataset.searchLimit = '60'; });
  returned.sort.addEventListener('change', () => { returned.list.dataset.catalogLimit = '40'; });
  returned.filters.forEach(filter => filter.addEventListener('click', () => {
    returned.list.dataset.catalogLimit = '40'; returned.list.dataset.searchLimit = '60';
    returned.filters.forEach(item => item.setAttribute('aria-pressed', String(item === filter)));
  }));
  returned.win.addEventListener('shelf-restore-catalog', event => {
    assert.equal(event.detail.catalogLimit, 80); assert.equal(event.detail.searchLimit, 120);
    // Simulate the catalog's synchronous render: the distant item did not exist
    // until the restore event extended the first 40/60 entries.
    returned.list.dataset.catalogLimit = String(event.detail.catalogLimit);
    returned.list.dataset.searchLimit = String(event.detail.searchLimit);
    returned.visibleItems.push(destination);
  });
  returned.dispatch('shelf-projects-loaded');
  assert.equal(returned.focused(), null, 'focus waits for the restored catalog render');
  returned.flushFrames();
  assert.equal(returned.search.value, 'core'); assert.equal(returned.sort.value, 'name');
  assert.equal(returned.filters[1].getAttribute('aria-pressed'), 'true');
  assert.equal(returned.list.dataset.catalogLimit, '80'); assert.equal(returned.list.dataset.searchLimit, '120');
  assert.equal(returned.focused(), destination);
  assert.equal(destination.focusOptions.preventScroll, true);
  assert.equal(returned.scrolls.length, 1); assert.equal(returned.scrolls[0].top, 8420);
  assert.equal(returned.scrolls[0].behavior, 'instant');
  assert.equal(returned.storage.has('shelf-return-state'), false);
  returned.dispatch('shelf-projects-loaded'); returned.flushFrames();
  assert.equal(returned.scrolls.length, 1, 'subsequent polling cannot keep pulling the reader back to the saved position');
});

function returnButton(dialog) {
  const nodes = node => [node, ...node.children.flatMap(nodes)];
  return nodes(dialog).find(node => node.tagName === 'BUTTON' && node.textContent === '返回书架');
}
async function finishOpening(h, trigger, id) {
  const opening = h.api.open(trigger, '/projects/' + id + '/books/main/');
  await h.advance(301);
  const request = h.requests.at(-1); request.pending.resolve(htmlResponse(request.url)); await opening;
}

test('returning to the shelf cancels a document navigation already issued after a successful prefetch', async () => {
  const h = mountedTransition(), a = h.makeBook('a');
  await finishOpening(h, a, 'a');
  assert.equal(h.navigations.length, 1, 'the HTML prefetch has completed and assign has already started the document request');
  assert.equal(h.win.location.href, 'https://shelf.test/#library', 'slow document navigation has not committed yet');
  returnButton(h.body.children[0]).click();
  assert.equal(h.stopCalls(), 1, 'aborting fetch alone cannot cancel a document request');
  h.commitDocument();
  assert.equal(h.win.location.href, 'https://shelf.test/#library');
  assert.equal(h.body.children.length, 0); assert.equal(h.focused(), a);
  assert.equal(h.storage.has('shelf-book-entry'), false, 'the cancelled reader entry cannot animate a later unrelated visit');
});

test('a stale opening cancel button cannot stop a later document navigation', async () => {
  const h = mountedTransition(), a = h.makeBook('a'), b = h.makeBook('b');
  await finishOpening(h, a, 'a');
  const oldReturn = returnButton(h.body.children[0]); oldReturn.click();
  await finishOpening(h, b, 'b');
  oldReturn.click();
  assert.equal(h.stopCalls(), 1, 'the old button belongs only to the cancelled navigation');
  assert.equal(h.body.children.length, 1, 'the new opening remains active');
  h.commitDocument(); assert.equal(h.win.location.href, 'https://shelf.test/projects/b/books/main/');
});

test('cancel before document navigation and bfcache lifecycle cleanup never stop unrelated loading', async () => {
  const h = mountedTransition(), a = h.makeBook('a'), b = h.makeBook('b');
  await finishOpening(h, a, 'a'); h.commitDocument();
  h.dispatch('pagehide', { persisted: true });
  h.win.location.href = 'https://shelf.test/#library'; h.dispatch('pageshow', { persisted: true }); h.flushFrames();
  assert.equal(h.stopCalls(), 0, 'returning to a cached page cleans up old state without stopping restored-page resources');
  const opening = h.api.open(b, '/projects/b/books/main/');
  returnButton(h.body.children[0]).click();
  assert.equal(h.stopCalls(), 0, 'a new pending prefetch has no document navigation to stop');
  h.requests.at(-1).pending.resolve(htmlResponse(h.requests.at(-1).url)); await opening;
  assert.equal(h.navigations.length, 1);
});

test('a timeout from an aborted prefetch cannot abort the next opening controller', async () => {
  const h = mountedTransition(), a = h.makeBook('a'), b = h.makeBook('b');
  const first = h.api.open(a, '/projects/a/books/main/');
  returnButton(h.body.children[0]).click();
  await h.advance(5000);
  const second = h.api.open(b, '/projects/b/books/main/');
  await h.advance(15001); // A's timeout fires; B still has almost five seconds.
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(h.requests[1].options.signal.aborted, false);
  h.requests[0].pending.resolve(htmlResponse(h.requests[0].url)); await first;
  h.requests[1].pending.resolve(htmlResponse(h.requests[1].url)); await second;
  assert.deepEqual(h.navigations, ['https://shelf.test/projects/b/books/main/']);
});

test('network failure leaves a readable recovery message and a working retry for the same book', async () => {
  const h = mountedTransition(), a = h.makeBook('a');
  const opening = h.api.open(a, '/projects/a/books/main/');
  h.requests[0].pending.reject(new TypeError('Failed to fetch')); await opening;
  const nodes = node => [node, ...node.children.flatMap(nodes)];
  const children = nodes(h.body.children[0]);
  const status = children.find(node => node.className === 'shelf-opening-status');
  assert.match(status.textContent, /检查网络后重试/);
  assert.doesNotMatch(status.textContent, /Failed to fetch/);
  const retry = children.find(node => node.textContent === '重新打开');
  assert.equal(retry.hidden, false); retry.click();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].url, h.requests[0].url);
  await h.advance(301);
  h.requests[1].pending.resolve(htmlResponse(h.requests[1].url)); await flush();
  assert.deepEqual(h.navigations, ['https://shelf.test/projects/a/books/main/']);
});
