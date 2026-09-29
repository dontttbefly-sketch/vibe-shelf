import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

// Mount all three production modules. Geometry and dialog close events are
// explicit here: close is asynchronous, and a hidden preview has no rectangle.
function page({ reducedMotion = false, storage = new Map(), projectCount = 2 } = {}) {
  const events = [], closeTasks = [], frames = [], timers = new Map(), bookRequests = [], navigations = [];
  const listeners = new Map(); let timerId = 0, doc;
  class Event {
    constructor(type, options = {}) { this.type = type; this.button = 0; Object.assign(this, options); }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this.stopped = true; }
  }
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.dataset = {}; this.listeners = new Map();
      this.className = ''; this.hidden = false; this.value = ''; this._text = ''; this.ownerDocument = doc;
      const values = new Map(); this.style = { setProperty: (key, value) => values.set(key, value), getPropertyValue: key => values.get(key) || '' };
      this.classList = {
        contains: name => this.className.split(/\s+/).includes(name),
        add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
        remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
        toggle: (name, on) => on ? this.classList.add(name) : this.classList.remove(name),
      };
    }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
    set href(value) { this.attrs.href = new URL(value, win.location.href).href; }
    get href() { return this.attrs.href || ''; }
    set target(value) { this.attrs.target = value; }
    get target() { return this.attrs.target || ''; }
    get isConnected() { return this === doc.body || Boolean(this.parentNode?.isConnected); }
    append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
    appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
    replaceChildren(...nodes) { this.children.forEach(node => { node.parentNode = null; }); this.children = []; this.append(...nodes); }
    remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; } }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return this.attrs[name] ?? null; }
    hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
    removeAttribute(name) { delete this.attrs[name]; }
    contains(other) { return other === this || this.children.some(child => child.contains(other)); }
    matches(selector) {
      if (selector === ':focus-visible') return true;
      if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()));
      const ancestor = selector.match(/^(.+) ([^ ]+)$/);
      if (ancestor) return this.matches(ancestor[2]) && Boolean(this.parentNode?.closest(ancestor[1]));
      const parsed = selector.match(/^([a-z][a-z0-9]*)?(?:\.([\w-]+))?((?:\[[^\]]+\])*)$/i);
      if (!parsed) return false;
      return (!parsed[1] || this.tagName === parsed[1].toUpperCase()) && (!parsed[2] || this.classList.contains(parsed[2])) &&
        [...parsed[3].matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)].every(([, name, value]) =>
          (name === 'open' ? this.open : this.hasAttribute(name)) && (value === undefined || this.getAttribute(name) === value));
    }
    closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== fn)); }
    dispatchEvent(event) {
      event.target ||= this; event.currentTarget = this;
      for (const fn of this.listeners.get(event.type) || []) fn(event);
      if (event.bubbles && !event.stopped) this.parentNode?.dispatchEvent(event);
      return !event.defaultPrevented;
    }
    click(options = {}) { const event = new Event('click', { bubbles: true, ...options }); this.dispatchEvent(event); return event; }
    focus(options) { doc.activeElement = this; events.push({ type: 'focus', node: this, options }); }
    showModal() {
      assert.equal(doc.querySelectorAll('dialog[open]').length, 0, 'a preview must close before the opening dialog appears');
      this.open = true; doc.activeElement = this; events.push({ type: 'show', node: this });
    }
    close() { this.open = false; events.push({ type: 'close', node: this }); closeTasks.push(() => this.dispatchEvent(new Event('close'))); }
    getBoundingClientRect() {
      if (this.closest('dialog') && !this.closest('dialog').open) return { left: 0, top: 0, width: 0, height: 0, bottom: 0 };
      return this.classList.contains('sp-cover') ? { left: 140, top: 190, width: 170, height: 250, bottom: 440 } :
        { left: 20, top: 30, width: 800, height: 640, bottom: 670 };
    }
    animate(keyframes) { events.push({ type: 'animate', node: this, keyframes }); }
    getAnimations() { return []; }
  }
  const win = {
    Event, CustomEvent: Event, AbortController, innerHeight: 900, innerWidth: 1280, scrollY: 8420,
    location: { href: 'https://shelf.test/#library', hash: '#library', assign: url => navigations.push(url) },
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    localStorage: { getItem: () => null },
    matchMedia: query => ({ matches: query.includes('reduced-motion') ? reducedMotion : true }),
    getComputedStyle: node => ({ getPropertyValue: key => node.style.getPropertyValue(key) }),
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => frames.push(fn), scrollTo: options => { win.scrollY = options.top; events.push({ type: 'scroll', options }); },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter(item => item !== fn)); },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); },
    fetch: async (url, options) => {
      if (url.includes('/preview')) { const id = url.split('/')[3]; return { ok: true, json: async () => ({ projectId: id, ready: true, readingUrl: '/unused', title: `读本 ${id}`, summary: '真实摘要', styleFingerprint: { colors: ['#fffdf7', '#17352a'] }, chapters: [{ id: 'chapter-2', title: '核心机制' }], books: [{ id: 'small-1', kind: 'exploration', title: `探索 ${id}` }] }) }; }
      const pending = deferred(); bookRequests.push({ url, options, pending }); return pending.promise;
    },
  };
  doc = { defaultView: win, activeElement: null, createElement: tag => new Element(tag), querySelector: selector => doc.body.querySelector(selector), querySelectorAll: selector => doc.body.querySelectorAll(selector) };
  doc.body = new Element('body'); win.document = doc;
  function add(tag, attr, value) { const node = doc.createElement(tag); if (attr) node.setAttribute(attr, value || ''); doc.body.append(node); return node; }
  const search = add('input', 'data-shelf-search'); search.value = '核心';
  const sort = add('select', 'data-shelf-sort'); sort.value = 'name';
  const filter = add('button', 'data-catalog-filter', 'read'); filter.dataset.catalogFilter = 'read'; filter.setAttribute('aria-pressed', 'true');
  const list = add('div', 'data-project-list'); list.dataset.catalogLimit = '80'; list.dataset.searchLimit = '120';
  const projects = Array.from({ length: projectCount }, (_, i) => i === 0 ? 'a' : i === 1 ? 'b' : `p-${i}`).map(id => ({ id, name: `项目 ${id}`, mainBookId: 'main', bookCount: 2 }));
  const covers = projects.map(project => {
    const article = doc.createElement('article'); article.className = 'shelf-book-item'; list.append(article);
    const cover = doc.createElement('a'); cover.className = 'shelf-book-card'; cover.setAttribute('data-shelf-focus', `book:${project.id}`); cover.href = `/projects/${project.id}/books/main/`;
    const title = doc.createElement('strong'); title.textContent = project.name; cover.append(title); article.append(cover);
    const preview = doc.createElement('button'); preview.setAttribute('data-preview-project', project.id); preview.setAttribute('data-shelf-focus', `preview:${project.id}`); article.append(preview);
    return cover;
  });
  const context = vm.createContext({ window: win, globalThis: win, URL, setTimeout, clearTimeout, Date });
  for (const file of ['shelf-preview.js', 'shelf-stack.js', 'shelf-transition.js']) vm.runInContext(fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'), context);
  return {
    win, doc, projects, covers, search, sort, list, filter, storage, events, bookRequests, navigations,
    flushCloses() { while (closeTasks.length) closeTasks.shift()(); },
    flushFrames() { while (frames.length) frames.shift()(); },
    async openPreview(index = 0) { await win.ShelfPreview.open({ project: projects[index], projects, trigger: covers[index] }); },
    async finishBook() { const request = bookRequests.at(-1); request.pending.resolve({ ok: true, url: request.url, headers: new Map([['content-type', 'text/html']]), text: async () => '<html>book</html>' }); await flush(); for (const [id, timer] of timers) if (timer.delay <= 300) { timers.delete(id); timer.fn(); } await flush(); },
  };
}

for (const kind of ['main', 'chapter', 'small']) {
  test(`explicit preview ${kind} navigation closes preview and carries the current book and shelf state`, async () => {
    const h = page(); await h.openPreview();
    h.doc.querySelectorAll('.sp-nav')[1].click(); await flush();
    const selector = { main: '.sp-read', chapter: '.sp-chapter-list a', small: '.sp-book-list a' }[kind];
    const link = h.doc.querySelector(selector), click = link.click();
    assert.equal(click.defaultPrevented, true, 'preview reading must enter the shared transition');
    assert.equal(h.doc.querySelector('.shelf-preview').open, false);
    const opening = h.doc.querySelector('.shelf-opening'); assert.equal(opening.open, true);
    const expectedTitle = kind === 'small' ? '探索 b' : '读本 b';
    assert.equal(opening.querySelector('h1').textContent, expectedTitle);
    const state = JSON.parse(h.storage.get('shelf-return-state'));
    assert.equal(state.focus, 'book:b'); assert.equal(state.scrollY, 8420); assert.equal(state.query, '核心');
    assert.equal(state.sort, 'name'); assert.equal(state.filter, 'read'); assert.equal(state.catalogLimit, 80); assert.equal(state.searchLimit, 120);
    const motion = h.events.filter(event => event.type === 'animate' && event.node.classList.contains('shelf-opening-page'));
    assert.equal(motion.length, 1, 'preview geometry must be captured before the dialog becomes hidden');
    assert.match(motion[0].keyframes[0].transform, /translate\(120px,160px\)/);
    h.flushCloses(); assert.equal(h.doc.activeElement, opening, 'the deferred preview close event must not steal opening focus');
    await h.finishBook(); assert.deepEqual(h.navigations, [link.href]);
    assert.equal(JSON.parse(h.storage.get('shelf-book-entry')).title, expectedTitle);
    const returned = page({ storage: h.storage }); returned.win.dispatchEvent(new returned.win.Event('shelf-projects-loaded')); returned.flushFrames();
    assert.equal(returned.doc.activeElement, returned.covers[1]); assert.equal(returned.win.scrollY, 8420);
  });
}

test('modified and new-tab preview links preserve native navigation and the open preview', async () => {
  const h = page(); await h.openPreview();
  for (const selector of ['.sp-read', '.sp-chapter-list a', '.sp-book-list a']) {
    const link = h.doc.querySelector(selector);
    for (const options of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) assert.equal(Boolean(link.click(options).defaultPrevented), false);
    link.target = '_blank'; assert.equal(Boolean(link.click().defaultPrevented), false); link.target = '';
  }
  assert.equal(h.doc.querySelector('.shelf-preview').open, true); assert.equal(h.bookRequests.length, 0); assert.equal(h.storage.has('shelf-return-state'), false);
});

test('hover preview chapters share the cover transition and dismiss the expanded preview first', async () => {
  const h = page(); const cover = h.covers[0], article = cover.parentNode;
  h.win.ShelfStack.mount(article, h.projects[0]);
  article.dispatchEvent(new h.win.Event('focusin', { target: cover })); await flush();
  assert.equal(article.classList.contains('ss-is-previewing'), true);
  const link = article.querySelector('.ss-preview-chapters a');
  assert.equal(link.click({ metaKey: true }).defaultPrevented, undefined); assert.equal(article.classList.contains('ss-is-previewing'), true);
  assert.equal(link.click().defaultPrevented, true);
  assert.equal(article.classList.contains('ss-is-previewing'), false); assert.equal(article.querySelector('.ss-preview').inert, true);
  assert.equal(JSON.parse(h.storage.get('shelf-return-state')).focus, 'book:a');
  assert.equal(h.doc.querySelector('.shelf-opening-title').textContent, '读本 a');
  await h.finishBook(); assert.deepEqual(h.navigations, [link.href]);
});

test('reduced-motion preview navigation still stores the current shelf state and closes the dialog', async () => {
  const h = page({ reducedMotion: true }); await h.openPreview(); const link = h.doc.querySelector('.sp-read');
  assert.equal(link.click().defaultPrevented, true);
  assert.equal(h.doc.querySelector('.shelf-preview').open, false); assert.equal(h.doc.querySelector('.shelf-opening'), null);
  assert.deepEqual(h.navigations, [link.href]); assert.equal(JSON.parse(h.storage.get('shelf-return-state')).focus, 'book:a');
});

test('cancelling preview navigation returns focus to the currently previewed book and ignores late loading', async () => {
  const h = page(); await h.openPreview(); h.doc.querySelectorAll('.sp-nav')[1].click(); await flush();
  h.doc.querySelector('.sp-read').click(); h.flushCloses();
  h.doc.querySelector('.shelf-opening').dispatchEvent(new h.win.Event('cancel'));
  assert.equal(h.doc.querySelectorAll('dialog[open]').length, 0); assert.equal(h.doc.activeElement, h.covers[1]);
  assert.equal(h.bookRequests[0].options.signal.aborted, true);
  await h.finishBook(); assert.deepEqual(h.navigations, []);
});

test('previewing beyond the displayed page retains enough catalog entries to restore the selected book', async () => {
  const h = page({ projectCount: 75 }); h.list.dataset.catalogLimit = '40';
  await h.openPreview(73); h.covers.slice(40).forEach(cover => cover.parentNode.remove());
  h.doc.querySelectorAll('.sp-nav')[1].click(); await flush();
  h.doc.querySelector('.sp-read').click();
  const state = JSON.parse(h.storage.get('shelf-return-state'));
  assert.equal(state.focus, 'book:p-74'); assert.equal(state.catalogLimit, 75); assert.equal(state.scrollY, 8420);
  assert.equal(h.doc.querySelector('.shelf-opening-title').textContent, '读本 p-74');
  await h.finishBook(); assert.deepEqual(h.navigations, ['https://shelf.test/projects/p-74/books/main/']);
});
