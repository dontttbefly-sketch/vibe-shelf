import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const api = () => require('../public/reader-session.js');

test('reading positions belong to the project and book', () => {
  assert.notEqual(api().readingKey({ projectId: 'p', bookId: 'main' }), api().readingKey({ projectId: 'q', bookId: 'main' }));
  assert.notEqual(api().readingKey({ projectId: 'p', bookId: 'main' }), api().readingKey({ projectId: 'p', bookId: 'small' }));
});

test('explicit chapter and exploration destinations take precedence over saved scroll', () => {
  const a = api();
  assert.equal(a.canRestore({ hash: '#chapter-2', search: '' }), false);
  assert.equal(a.canRestore({ hash: '', search: '?exploration=e-1' }), false);
  assert.equal(a.canRestore({ hash: '', search: '' }), true);
});

test('project links are constructed from IDs, never server-provided URLs', () => {
  const a = api();
  const base = 'https://example.test/shelf/';
  assert.equal(a.bookUrl(base, 'project', 'main'), 'https://example.test/shelf/projects/project/books/main/');
  assert.throws(() => a.bookUrl(base, '../escape', 'main'));
  assert.throws(() => a.bookUrl(base, 'project', 'javascript:alert(1)'));
});

test('exploration links return to original book with the agreed deep link', () => {
  const a = api();
  assert.equal(a.explorationUrl('http://localhost:8899/', 'p', { id: 'e-1', originBookId: 'small' }), 'http://localhost:8899/projects/p/books/small/?exploration=e-1#shelf-explore');
  assert.equal(a.explorationUrl('http://localhost:8899/', 'p', { id: 'e-1' }), 'http://localhost:8899/projects/p/books/main/?exploration=e-1#shelf-explore');
});

test('small book source names the question paired with its originating answer', () => {
  const session = { messages: [
    { id: 'q1', role: 'user', content: 'first question' }, { id: 'a1', role: 'assistant', content: 'first answer' },
    { id: 'q2', role: 'user', content: 'actual source question' }, { id: 'a2', role: 'assistant', content: 'second answer' },
  ] };
  assert.equal(api().originQuestion({ originAnswerMessageId: 'a2' }, session), 'actual source question');
});

test('reading record validation rejects invalid positions and unrelated identities', () => {
  const a = api();
  const context = { projectId: 'p', bookId: 'main' };
  assert.equal(a.validRecord({ ...context, scrollY: 250 }, context), true);
  assert.equal(a.validRecord({ ...context, scrollY: -1 }, context), false);
  assert.equal(a.validRecord({ ...context, scrollY: 250, projectId: 'q' }, context), false);
  assert.equal(a.validRecord({ ...context, scrollY: Infinity }, context), false);
});

function mountedReader({ location = { href: 'http://localhost:8899/projects/p/books/small/', hash: '', search: '' }, saved = null } = {}) {
  let focused;
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.textContent = ''; }
    set innerHTML(_) { throw Error('server data must not be parsed as markup'); }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    appendChild(child) { this.children.push(child); return child; }
    insertBefore(child) { this.children.push(child); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(k, v) { this.attrs[k] = v; }
    addEventListener(k, fn) { this.listeners[k] = fn; }
    querySelector(selector) {
      const attr = selector.match(/^\[([^\]]+)\]$/)?.[1];
      return attr ? this.children.find(node => Object.hasOwn(node.attrs, attr)) || null : null;
    }
    focus() { focused = this; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    remove() {}
  }
  const topbar = new Element('header');
  const title = new Element('span'); title.textContent = '小书'; title.setAttribute('data-shelf-book-title', ''); topbar.append(title);
  const body = new Element('body');
  const values = new Map();
  if (saved) values.set('shelf-reading-p-small', JSON.stringify(saved));
  const listeners = {};
  const scrolls = [];
  const requests = [];
  const session = { id: 'e-1', originBookId: 'main', messages: [{ role: 'user', content: '<img src=x onerror=alert(1)>' }] };
  const view = { project: { name: '项目', mainBookId: 'main' }, books: [
    { id: 'main', title: '主书', kind: 'main', url: 'javascript:bad()' },
    { id: 'small', title: '小书', kind: 'exploration', parentBookId: 'main', originExplorationId: 'e-1' },
  ] };
  const doc = {
    currentScript: { src: 'http://localhost:8899/reader-session.js' }, readyState: 'complete', title: '小书', body,
    querySelector: () => topbar, querySelectorAll: () => [], getElementById: () => null,
    createElement: tag => new Element(tag), addEventListener(k, fn) { listeners[`doc:${k}`] = fn; },
  };
  const win = {
    SHELF_CONTEXT: { projectId: 'p', bookId: 'small' }, location, scrollY: 0,
    localStorage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) },
    addEventListener(k, fn) { listeners[k] = fn; }, setTimeout, clearTimeout,
    requestAnimationFrame: fn => fn(), scrollTo: options => { scrolls.push(options.top); win.scrollY = options.top; },
    fetch: async url => { requests.push(url); return { ok: true, json: async () => url.endsWith('/explorations') ? { sessions: [session] } : view }; },
  };
  api().mount(win, doc);
  return { win, doc, topbar, body, values, scrolls, listeners, requests, focused: () => focused };
}

test('mounted library renders source links as safe text and Escape returns focus', async () => {
  const page = mountedReader();
  const trigger = page.topbar.querySelector('[data-project-library]');
  trigger.listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(page.requests, ['/api/projects/p', '/api/projects/p/explorations']);
  const panel = page.body.children.find(n => n.tag === 'dialog');
  const flatten = node => [node, ...node.children.flatMap(flatten)];
  const nodes = flatten(panel);
  assert.ok(nodes.some(n => n.textContent === '<img src=x onerror=alert(1)>'));
  assert.ok(nodes.some(n => n.href === 'http://localhost:8899/projects/p/books/main/?exploration=e-1#shelf-explore'));
  assert.equal(nodes.some(n => n.href?.startsWith('javascript:')), false);
  panel.listeners.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(panel.open, false);
  assert.equal(page.focused(), trigger);
});

test('mounted reader restores the saved position and writes the shared continue-reading record', async () => {
  const page = mountedReader({ saved: { projectId: 'p', bookId: 'small', scrollY: 640 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(page.scrolls, [640]);
  const shared = JSON.parse(page.values.get('shelf-last-read'));
  assert.equal(shared.scrollY, 640);
  assert.equal(shared.url, 'http://localhost:8899/projects/p/books/small/');
});

test('mounted reader never overrides an explicit exploration destination', async () => {
  const page = mountedReader({
    saved: { projectId: 'p', bookId: 'small', scrollY: 640 },
    location: { href: 'http://localhost:8899/projects/p/books/small/?exploration=e-1#shelf-explore', hash: '#shelf-explore', search: '?exploration=e-1' },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(page.scrolls, []);
});
