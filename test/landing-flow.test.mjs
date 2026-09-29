import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/landing.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function page({ hash = '', account = { mode: 'local' }, bridge = null, savedFlow = 'idle', deferredAccount = null, historyState = null } = {}) {
  const nodes = new Map(), docHandlers = {}, windowHandlers = {}, historyEntries = [], focused = [];
  const session = new Map(bridge ? [['shelf-login-import-draft', JSON.stringify(bridge)]] : []);
  let currentSource = 'local', flow = savedFlow, resets = 0, submissions = 0, firingSubmission = false;
  function node(selector = '') {
    if (nodes.has(selector)) return nodes.get(selector);
    const result = {
      dataset: {}, hidden: false, open: false, value: '', children: [], listeners: {}, isConnected: true,
      classList: { add() {}, remove() {} }, style: { setProperty() {} },
      setAttribute(key, value) { this[key] = value; }, removeAttribute(key) { delete this[key]; },
      appendChild(child) { this.children.push(child); return child; }, replaceChildren(...children) { this.children = children; },
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
      focus() { focused.push(this); }, scrollIntoView() {},
      closest(value) { return value === '[data-import-open]' && this.importTrigger ? this : null; },
      showModal() { this.open = true; }, close() { this.open = false; this.listeners.close?.forEach(fn => fn()); },
      dispatchEvent(event) { this.listeners[event.type]?.forEach(fn => fn.call(this, event)); },
      click() {
        const event = { type: 'click', target: this, preventDefault() {}, stopImmediatePropagation() { this.stopped = true; } };
        for (const fn of docHandlers.click || []) { fn(event); if (event.stopped) return; }
        this.listeners.click?.forEach(fn => fn.call(this, event));
      },
    };
    nodes.set(selector, result); return result;
  }
  const form = node('[data-project-import]');
  form.dataset.launcherState = savedFlow;
  const workspace = node('[data-upload-workspace]'); workspace.tagName = 'MAIN'; workspace.hidden = true;
  form.elements = { name: node('input-name'), repo: node('input-repo'), readingIntent: node('input-intent') };
  form.elements.readingIntent.value = 'overview';
  form.requestSubmit = submitter => {
    if (firingSubmission) return; // Native firing-submission-events guard.
    firingSubmission = true;
    const event = { type: 'submit', target: form, submitter, preventDefault() {}, stopImmediatePropagation() { this.stopped = true; } };
    for (const listener of docHandlers.submit || []) { listener(event); if (event.stopped) break; }
    if (!event.stopped) submissions++;
    // The original event remains active through its microtask checkpoint.
    queueMicrotask(() => { firingSubmission = false; });
  };
  form.querySelector = selector => selector === '[data-source-choice][aria-pressed=true]' ? node('[data-source-choice="' + currentSource + '"]') : node(selector);
  for (const sourceType of ['local', 'github']) {
    const choice = node('[data-source-choice="' + sourceType + '"]'); choice.dataset.sourceChoice = sourceType;
    choice.addEventListener('click', () => { currentSource = sourceType; });
  }
  function reset() {
    resets++; flow = 'idle'; currentSource = 'local';
    form.dataset.launcherState = 'idle';
    form.elements.name.value = ''; form.elements.repo.value = ''; form.elements.readingIntent.value = 'overview';
    window.dispatchEvent({ type: 'shelf-import-reset' });
  }
  node('[data-new-import]').addEventListener('click', reset);
  const trigger = node('[data-import-open]'); trigger.importTrigger = true;
  const location = { href: 'http://localhost/' + hash, origin: 'http://localhost', pathname: '/', search: '', hash };
  function writeHistory(kind, state, next) {
    location.href = new URL(next, location.href).href;
    location.hash = new URL(location.href).hash;
    history.state = state == null ? null : JSON.parse(JSON.stringify(state));
    historyEntries.push({ kind, hash: location.hash });
  }
  const history = {
    state: historyState == null ? null : JSON.parse(JSON.stringify(historyState)),
    pushState(state, _title, next) { writeHistory('push', state, next); },
    replaceState(state, _title, next) { writeHistory('replace', state, next); },
  };
  const document = {
    body: node('body'), activeElement: trigger, title: '',
    querySelector: selector => selector === '[data-import-dialog]' ? null : node(selector),
    querySelectorAll: selector => ['[data-library-open]', '[data-home-open]', '[data-account-open]'].includes(selector) ? [node(selector)] : selector === '[data-examples-open]' ? [] : [],
    createElement: tag => node(Symbol(tag)), createTextNode: text => ({ textContent: text }),
    addEventListener(type, fn) { (docHandlers[type] ||= []).push(fn); },
  };
  document.body.dataset.pageView = 'home';
  const window = {
    location, scrollY: 0, scrollTo({ top }) { this.scrollY = top; },
    addEventListener(type, fn) { (windowHandlers[type] ||= []).push(fn); },
    dispatchEvent(event) { (windowHandlers[event.type] || []).forEach(fn => fn(event)); },
  };
  // shelf.js retains ownership of import resets; landing owns navigation.
  window.addEventListener('shelf-import-open', () => { if (flow === 'ready') reset(); });
  vm.runInNewContext(source, {
    document, window, history, URL, AbortSignal, setTimeout,
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    sessionStorage: { getItem: key => session.get(key) || null, setItem: (key, value) => session.set(key, value), removeItem: key => session.delete(key) },
    fetch: async url => {
      if (url === '/api/account') return { ok: true, json: async () => deferredAccount ? await deferredAccount : account };
      if (url === '/api/examples') return { ok: true, json: async () => ({ projects: [] }) };
      throw new Error('Unexpected URL ' + url);
    },
  });
  return { node, form, workspace, trigger, window, document, session, history, historyEntries, focused, resets: () => resets, submissions: () => submissions, source: () => currentSource,
    route(hash) { location.hash = hash; (windowHandlers.hashchange || []).forEach(fn => fn()); } };
}

test('legacy reader return hash opens the library immediately on initial navigation', async () => {
  for (const hash of ['#library', '#bookshelf', '#shelfTitle']) {
    const app = page({ hash }); await settle();
    assert.equal(app.node('.shelf-home').hidden, false, hash);
    assert.equal(app.node('[data-landing]').hidden, true, hash);
  }
});

test('a returning account keeps its OAuth import draft even when its previous flow was ready', async () => {
  const app = page({
    account: { mode: 'public', authenticated: true, user: { name: 'Reader', login: 'reader' } }, savedFlow: 'ready',
    bridge: { name: 'New project', repo: 'owner/new-project', readingIntent: 'core', sourceType: 'github' },
  });
  await settle(); await settle();
  assert.equal(app.resets(), 1);
  assert.equal(app.workspace.hidden, false);
  assert.equal(app.workspace.tagName, 'MAIN');
  assert.equal(app.document.body.dataset.pageView, 'upload');
  assert.equal(app.window.location.hash, '#upload');
  assert.equal(app.node('[data-account-dialog]').open, false);
  assert.equal(app.form.elements.name.value, 'New project');
  assert.equal(app.form.elements.repo.value, 'owner/new-project');
  assert.equal(app.form.elements.readingIntent.value, 'core');
  assert.equal(app.source(), 'github');
  assert.equal(app.session.has('shelf-login-import-draft'), false);
});

test('a direct upload route immediately enters the workspace and resolves sign-in inside it', async () => {
  let resolve;
  const deferredAccount = new Promise(done => { resolve = done; });
  const app = page({ hash: '#upload', deferredAccount });
  assert.equal(app.workspace.hidden, false);
  assert.equal(app.document.body.dataset.pageView, 'upload');
  assert.equal(app.form.hidden, true, 'unknown account state cannot reveal a working upload form');
  assert.equal(app.node('[data-upload-access]').hidden, false);
  assert.match(app.node('[data-upload-access-status]').textContent, /正在连接/);
  assert.equal(app.document.querySelector('[data-import-dialog]'), null);
  resolve({ mode: 'public', authenticated: false, login: { configured: true } });
  await settle();
  assert.equal(app.workspace.hidden, false);
  assert.equal(app.form.hidden, true);
  assert.equal(app.node('[data-account-dialog]').open, false);
  assert.equal(app.node('[data-upload-signin]').hidden, false);
  app.window.ShelfLanding.showLibrary();
  assert.equal(app.workspace.hidden, true);
  app.route('#upload'); await settle();
  assert.equal(app.workspace.hidden, false, 'history must reopen the requested workspace');
  assert.equal(app.node('[data-upload-access]').hidden, false);
  assert.equal(app.node('[data-account-dialog]').open, false);
});

test('the upload CTA enters immediately, deduplicates repeated clicks and restores its source scroll and focus', async () => {
  for (const view of ['home', 'library']) {
    const app = page({ hash: view === 'library' ? '#library' : '' }); await settle();
    app.window.scrollY = 640;
    app.trigger.click(); app.trigger.click(); app.trigger.click();
    assert.equal(app.document.body.dataset.pageView, 'upload');
    assert.equal(app.workspace.hidden, false);
    assert.equal(app.form.hidden, false);
    assert.equal(app.window.scrollY, 0);
    assert.equal(app.historyEntries.filter(entry => entry.kind === 'push' && entry.hash === '#upload').length, 1);
    assert.equal(app.node('[data-account-dialog]').open, false);
    app.node('[data-upload-back]').click();
    assert.equal(app.document.body.dataset.pageView, view);
    assert.equal(app.workspace.hidden, true);
    assert.equal(app.window.scrollY, 640);
    assert.equal(app.focused.at(-1), app.trigger);
  }
});

test('generation replaces the upload route and direct generation refresh opens the workspace', async () => {
  const app = page(); await settle(); app.trigger.click();
  app.window.ShelfLanding.showGeneration();
  assert.equal(app.document.body.dataset.pageView, 'generate');
  assert.equal(app.workspace.hidden, false);
  assert.deepEqual(app.historyEntries, [{ kind: 'push', hash: '#upload' }, { kind: 'replace', hash: '#generate' }]);
  const restored = page({ hash: '#generate', savedFlow: 'generating' }); await settle();
  assert.equal(restored.workspace.hidden, false);
  assert.equal(restored.document.body.dataset.pageView, 'generate');
  assert.equal(restored.historyEntries.length, 0, 'restoring a route must not append another history entry');
});

test('reopening a task from the library returns to that visit instead of its earlier home origin', async () => {
  const app = page(); await settle();
  app.window.scrollY = 120;
  app.trigger.click();
  app.window.ShelfLanding.showGeneration();
  app.window.ShelfLanding.showLibrary();
  app.window.scrollY = 880;
  const taskTrigger = app.node('[data-active-generation]');
  app.document.activeElement = taskTrigger;
  app.window.ShelfLanding.showGeneration({ focus: true, trigger: taskTrigger });
  assert.equal(app.document.body.dataset.pageView, 'generate');
  assert.equal(app.window.scrollY, 0);
  assert.equal(app.history.state.shelfWorkspaceReturn.view, 'library');
  assert.equal(app.history.state.shelfWorkspaceReturn.libraryScroll, 880);
  app.node('[data-upload-back]').click();
  assert.equal(app.document.body.dataset.pageView, 'library');
  assert.equal(app.window.scrollY, 880);
  assert.equal(app.focused.at(-1), taskTrigger);
});

test('the workspace skip link preserves both upload and generation views', async () => {
  for (const view of ['upload', 'generate']) {
    const app = page({ hash: '#' + view }); await settle();
    assert.equal(app.node('.landing-skip').href, '#uploadTitle');
    app.route(app.node('.landing-skip').href);
    assert.equal(app.document.body.dataset.pageView, view);
    assert.equal(app.workspace.hidden, false);
    assert.equal(app.node('[data-landing]').hidden, true);
    assert.equal(app.node('.shelf-home').hidden, true);
  }
});

test('sign-in carries the library return context through a full-page OAuth round trip', async () => {
  const guest = page({ hash: '#library', account: { mode: 'public', authenticated: false, login: { configured: true } } });
  await settle();
  guest.window.scrollY = 730;
  guest.trigger.click();
  guest.form.elements.name.value = 'OAuth draft';
  guest.node('[data-upload-signin]').click();
  const bridge = JSON.parse(guest.session.get('shelf-login-import-draft'));
  assert.equal(bridge.returnView, 'library');
  assert.equal(bridge.libraryScroll, 730);
  const signedIn = page({ hash: '#upload', account: { mode: 'public', authenticated: true, user: { login: 'reader' } }, bridge });
  await settle(); await settle();
  assert.equal(signedIn.document.body.dataset.pageView, 'upload');
  assert.equal(signedIn.form.elements.name.value, 'OAuth draft');
  assert.equal(signedIn.history.state.shelfWorkspaceReturn.view, 'library');
  assert.equal(signedIn.history.state.shelfWorkspaceReturn.libraryScroll, 730);
  signedIn.node('[data-upload-back]').click();
  assert.equal(signedIn.document.body.dataset.pageView, 'library');
  assert.equal(signedIn.window.scrollY, 730);
});

test('refreshing an upload retains its library return destination and scroll position through history state', async () => {
  const original = page({ hash: '#library' }); await settle();
  original.window.scrollY = 640;
  original.trigger.click();
  assert.equal(original.window.location.hash, '#upload');
  assert.equal(original.history.state?.shelfWorkspaceReturn?.view, 'library');
  assert.equal(original.history.state?.shelfWorkspaceReturn?.libraryScroll, 640);
  const refreshed = page({ hash: original.window.location.hash, historyState: original.history.state }); await settle();
  assert.equal(refreshed.document.body.dataset.pageView, 'upload');
  assert.equal(refreshed.workspace.hidden, false);
  refreshed.node('[data-upload-back]').click();
  assert.equal(refreshed.document.body.dataset.pageView, 'library');
  assert.equal(refreshed.window.location.hash, '#library');
  assert.equal(refreshed.window.scrollY, 640);
});

test('local preview account access uses the inline local account step and preserves the pending draft', async () => {
  const app = page({ hash: '#upload', account: { mode: 'public', authenticated: false, preview: { local: true, live: true }, login: { configured: false } } });
  await settle();
  assert.equal(app.node('[data-upload-local-login]').hidden, false);
  assert.equal(app.node('[data-upload-signin]').hidden, true);
  assert.match(app.node('[data-upload-access-status]').textContent, /真实模型/);
  app.form.elements.name.value = 'Pending local project';
  app.node('[data-upload-local-login]').dispatchEvent({ type: 'submit' });
  assert.equal(JSON.parse(app.session.get('shelf-login-import-draft')).name, 'Pending local project');
  assert.equal(app.node('[data-account-dialog]').open, false);
});


test('an already authenticated account lets the original native submit run synchronously', async () => {
  const app = page({ account: { mode: 'public', authenticated: true, user: { login: 'reader' } } });
  await settle();
  app.form.requestSubmit(app.node('[type=submit]'));
  assert.equal(app.submissions(), 1, 'known authorization must not cancel then recursively submit');
});

test('an unresolved account replays native submit on a later task after authorization', async () => {
  let resolve;
  const deferredAccount = new Promise(done => { resolve = done; });
  const app = page({ deferredAccount });
  app.form.requestSubmit(app.node('[type=submit]'));
  assert.equal(app.submissions(), 0);
  resolve({ mode: 'public', authenticated: true, user: { login: 'reader' } });
  await new Promise(done => setTimeout(done, 15));
  assert.equal(app.submissions(), 1);
});

test('repeated submits while account access is unresolved replay only one authorized submission', async () => {
  let resolve;
  const deferredAccount = new Promise(done => { resolve = done; });
  const app = page({ hash: '#upload', deferredAccount });
  app.form.requestSubmit(app.node('[type=submit]'));
  await settle();
  app.form.requestSubmit(app.node('[type=submit]'));
  assert.equal(app.submissions(), 0);
  resolve({ mode: 'public', authenticated: true, user: { login: 'reader' } });
  await new Promise(done => setTimeout(done, 15));
  assert.equal(app.submissions(), 1);
  assert.equal(app.form.hidden, false);
});

test('a denied pending submission remains in the inline access step without losing the draft', async () => {
  let resolve;
  const deferredAccount = new Promise(done => { resolve = done; });
  const app = page({ hash: '#upload', deferredAccount });
  app.form.elements.name.value = 'My pending book';
  app.form.elements.repo.value = 'owner/project';
  app.form.requestSubmit(app.node('[type=submit]'));
  resolve({ mode: 'public', authenticated: false, login: { configured: true } });
  await settle();
  assert.equal(app.submissions(), 0);
  assert.equal(app.form.elements.name.value, 'My pending book');
  assert.equal(app.form.elements.repo.value, 'owner/project');
  assert.equal(app.workspace.hidden, false);
  assert.equal(app.form.hidden, true);
  assert.equal(app.node('[data-upload-signin]').hidden, false);
  assert.equal(app.node('[data-account-dialog]').open, false);
});

test('account panel exposes personal-data management to signed-in users while preserving local settings and hiding guest controls', async () => {
  for (const [account, shown, label] of [
    [{ mode: 'public', authenticated: true, user: { login: 'reader' } }, true, '个人资料管理'],
    [{ mode: 'public', authenticated: false, login: { configured: true } }, false, '个人资料管理'],
    [{ mode: 'local' }, true, '模型设置与本机资料'],
  ]) {
    const app = page({ account }); await settle();
    assert.equal(app.node('[data-account-settings]').hidden, !shown);
    assert.equal(app.node('[data-account-settings-label]').textContent, label);
  }
});
