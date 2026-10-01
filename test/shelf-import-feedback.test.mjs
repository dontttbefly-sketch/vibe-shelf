import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = () => fs.readFileSync(new URL('../public/shelf.js', import.meta.url), 'utf8');
function submitHarness(kind) {
  let submit;
  const calls = [];
  const statuses = [];
  const buttons = [];
  const context = vm.createContext({
    busy: false, flowReadSequence: 0, submissionSequence: 0, projects: [], updateFlow: async () => calls.push(['flow-refresh']), preparedFiles: [{ path: 'new.js', content: 'B' }], source: 'local', folderName: 'new-folder',
    flow: { projectId: 'p-old', name: 'Same Name', source: 'local', repo: '', status: 'importing' },
    form: { elements: { name: { value: 'Same Name', focus() {} }, repo: { value: '', focus() {} } }, addEventListener: (_name, fn) => { submit = fn; } },
    makeProjectId: () => 'p-new', saveFlow() {}, lockFields: locked => calls.push(['lock', locked]),
    setButton: text => buttons.push(text), setStatus: text => statuses.push(text), showFlow() {},
    post: async (url, body) => { calls.push(['post', url, body]); throw Object.assign(Error('资料冲突'), { status: 409, kind }); },
    request: async url => { calls.push(['get', url]); return { project: { id: 'p-old' } }; },
    loadProjects: async () => calls.push(['refresh']), AbortSignal,
  });
  const text = source();
  const handler = text.slice(text.indexOf('  form.addEventListener("submit"'), text.indexOf('  var stored = readStored(FLOW_KEY);'));
  vm.runInContext(handler, context);
  return { context, calls, statuses, buttons, submit: () => submit({ preventDefault() {} }) };
}

test('import transport preserves HTTP status and error kind for recovery decisions', async () => {
  const c = vm.createContext({ AbortSignal, fetch: async () => ({ ok: false, status: 409, json: async () => ({ error: { kind: 'import-conflict', message: '来源冲突' } }) }) });
  vm.runInContext(source().match(/  async function request\([^]*?\n  \}/)[0], c);
  await assert.rejects(c.request('/import'), error => error.status === 409 && error.kind === 'import-conflict');
});

test('different source with a reused import ID is not reported as successful response recovery', async () => {
  const harness = submitHarness('import-conflict');
  await harness.submit();
  assert.equal(harness.calls.filter(call => call[0] === 'refresh').length, 0);
  assert.equal(harness.calls.filter(call => call[0] === 'get').length, 0);
  assert.equal(harness.calls.filter(call => call[0] === 'post').length, 1, 'same submit must not silently create a second project');
  assert.equal(harness.context.flow.projectId, 'p-new');
  assert.match(harness.statuses.at(-1), /原项目|上一次/);
  assert.match(harness.buttons.at(-1), /新项目/);
  assert.equal(harness.context.busy, false);
});

test('generation-running remains eligible to find the actual active project', async () => {
  const harness = submitHarness('generation-running');
  await harness.submit();
  assert.equal(harness.calls.filter(call => call[0] === 'get').length, 1);
  assert.equal(harness.calls.filter(call => call[0] === 'refresh').length, 1);
  assert.equal(harness.context.flow.projectId, 'p-old');
});

test('saved source without a generation file offers starting the original project', () => {
  const buttons = [], notices = [], nodes = {};
  const form = { querySelector: selector => nodes[selector] || (nodes[selector] = {}) };
  const c = vm.createContext({
    flow: { projectId: 'p-idle', status: 'importing' }, saveFlow() {}, clearImportDraft() {}, lockFields() {},
    form, part: selector => form.querySelector(selector), stageCopy: {},
    setButton: (...args) => buttons.push(args), setStatus: text => notices.push(text),
  });
  vm.runInContext(source().match(/  function showFlow\([^]*?\n  \}/)[0], c);
  c.showFlow({ id: 'p-idle', bookCount: 0 }, { status: 'idle' });
  assert.equal(c.flow.status, 'pending');
  assert.deepEqual(buttons.at(-1), ['开始生成主书', false]);
  assert.match(notices.at(-1), /已保存/);
});

test('pending generation starts the existing project rather than importing again', async () => {
  const harness = submitHarness('generation-running');
  harness.context.flow.status = 'pending';
  harness.context.preparedFiles = null;
  await harness.submit();
  const posts = harness.calls.filter(call => call[0] === 'post');
  assert.equal(posts.length, 1);
  assert.equal(posts[0][1], '/api/projects/p-old/generation');
  assert.equal(harness.context.flow.projectId, 'p-old');
});

test('an idle project card starts its saved source without creating another project', async () => {
  const calls = [];
  function element(tag) {
    return { tag, children: [], listeners: {}, classList: { add() {} },
      appendChild(child) { this.children.push(child); }, removeAttribute() {}, setAttribute() {},
      addEventListener(name, callback) { this.listeners[name] = callback; } };
  }
  const c = vm.createContext({
    document: { createElement: element }, mainBookUrl: () => '/projects/p-idle/books/main/',
    post: async url => calls.push(['post', url]), loadProjects: async () => calls.push(['refresh']),
  });
  vm.runInContext(source().match(/  function addText\([^]*?\n  function renderProjects/)[0].replace(/  function renderProjects$/, ''), c);
  const card = c.makeBookCard({ id: 'p-idle', name: 'Saved', bookCount: 0, generationStatus: 'idle' });
  const start = card.children.find(node => node.tag === 'button');
  assert.ok(start, 'the bookshelf must have a recovery action without the import form');
  assert.match(start.textContent, /开始生成/);
  await start.listeners.click();
  assert.deepEqual(calls, [['post', '/api/projects/p-idle/generation'], ['refresh']]);
});

function pageHarness({ stored = new Map(), storageUnavailable = false, serverProjects = [] } = {}) {
  function element(tag = 'div') {
    return { tag, children: [], listeners: {}, dataset: {}, value: '', files: [], hidden: false, disabled: false, textContent: '',
      classList: { add() {}, remove() {}, contains: () => false }, style: { setProperty() {} },
      appendChild(child) { this.children.push(child); return child; }, replaceChildren() { this.children = []; },
      addEventListener(name, listener) { this.listeners[name] = listener; },
      setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; }, focus() {}, select() {}, showModal() { this.open = true; }, close() { this.open = false; this.listeners.close?.(); } };
  }
  const nodes = new Map();
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  const form = element('form'); form.elements = { name: element('input'), repo: element('input'), folder: element('input') };
  const filterButtons = ['all', 'read'].map(filter => { const result = element('button'); result.dataset.catalogFilter = filter; return result; });
  const callbacks = [], windowListeners = {}, events = [];
  const choices = ['local', 'github'].map(source => { const result = element('button'); result.dataset.sourceChoice = source; return result; });
  form.querySelector = node;
  form.querySelectorAll = selector => selector === '[data-source-choice]' ? choices : Object.values(form.elements).concat(choices);
  form.reset = () => { for (const input of Object.values(form.elements)) { input.value = ''; input.files = []; } };
  node('[type=submit]').querySelector = () => node('submit-span');
  const calls = [];
  const projectList = [...serverProjects];
  const localStorage = {
    getItem(key) { if (storageUnavailable) throw Error('storage denied'); return stored.get(key) || null; },
    setItem(key, value) { if (storageUnavailable) throw Error('storage denied'); stored.set(key, value); },
    removeItem(key) { if (storageUnavailable) throw Error('storage denied'); stored.delete(key); },
  };
  const fetch = async (url, options = {}) => {
    calls.push([url, options.method || 'GET']);
    let data;
    if (url === '/api/projects' || url === '/api/projects?view=shelf') data = { projects: projectList };
    else if (url.endsWith('/generation')) data = { generation: { status: projectList[0]?.generationStatus || 'idle' } };
    else if (url === '/api/projects/import' || url === '/api/projects/import-github') {
      const submitted = JSON.parse(options.body);
      const project = { id: submitted.projectId, name: submitted.name, bookCount: 1, generationStatus: 'ready' };
      projectList.push(project); data = { project, generation: { status: 'ready' } };
    } else throw Error('Unexpected request ' + url);
    return { ok: true, json: async () => data };
  };
  const crypto = { randomUUID: () => '12345678-1234-1234-1234-123456789012' };
  vm.runInNewContext(source(), {
    document: { body: element('body'), createElement: element, addEventListener() {}, querySelector: selector => selector === '[data-project-import]' ? form : selector === 'dialog[open]' ? null : node(selector), querySelectorAll: selector => selector === '[data-catalog-filter]' ? filterButtons : [] },
    window: { crypto, addEventListener(name, fn) { windowListeners[name] = fn; }, dispatchEvent(event) { events.push(event); }, ShelfImport: { readDirectoryTextFiles: async files => files.map(file => ({ path: file.name, content: file.content })) } },
    crypto, localStorage, fetch, AbortSignal, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    setTimeout(fn) { callbacks.push(fn); return callbacks.length; }, clearTimeout() {},
  });
  return { form, node, stored, calls, projectList, callbacks, windowListeners, events, filters: filterButtons, choice: source => choices.find(choice => choice.dataset.sourceChoice === source),
    type: (name, value) => { form.elements[name].value = value; form.elements[name].listeners.input(); },
    select: async () => { form.elements.folder.files = [{ name: 'main.js', webkitRelativePath: 'Original Folder/main.js', content: 'SECRET_SOURCE_CONTENT' }]; await form.elements.folder.listeners.change(); },
    submit: () => form.listeners.submit({ preventDefault() {} }),
  };
}
const settlePage = () => new Promise(resolve => setImmediate(resolve));

test('unfinished project name and GitHub source are restored after a page reload', async () => {
  const first = pageHarness();
  first.choice('github').listeners.click();
  first.type('repo', 'owner/repository');
  first.type('name', 'My custom name');
  const restored = pageHarness({ stored: first.stored });
  await settlePage();
  assert.equal(restored.form.elements.name.value, 'My custom name');
  assert.equal(restored.form.elements.repo.value, 'owner/repository');
  assert.equal(restored.node('[data-github-source]').hidden, false);
  assert.equal(restored.node('[data-local-source]').hidden, true);
  assert.equal(restored.calls.some(([, method]) => method === 'POST'), false);
});

test('local folder draft keeps only lightweight input and clearly requires reselection after reload', async () => {
  const first = pageHarness();
  await first.select();
  first.type('name', 'My local project');
  const restored = pageHarness({ stored: first.stored });
  await settlePage();
  assert.equal(restored.form.elements.name.value, 'My local project');
  assert.equal(restored.form.elements.folder.files.length, 0);
  assert.match(restored.node('[data-folder-label]').textContent, /Original Folder/);
  assert.match(restored.node('[data-import-status]').textContent, /请重新选择原文件夹/);
  const draft = JSON.parse(first.stored.get('shelf-import-draft'));
  assert.deepEqual(Object.keys(draft).sort(), ['folderName', 'name', 'repo', 'source']);
  assert.doesNotMatch(JSON.stringify([...first.stored]), /SECRET_SOURCE_CONTENT|main\.js/);
});

test('saved generation flow takes priority over an older import draft and clears that draft', async () => {
  const stored = new Map([
    ['shelf-import-flow', JSON.stringify({ projectId: 'p-active', name: 'Active project', source: 'github', repo: 'owner/active', status: 'generating' })],
    ['shelf-import-draft', JSON.stringify({ name: 'Old draft', source: 'local', repo: '', folderName: 'Old folder' })],
  ]);
  const h = pageHarness({ stored, serverProjects: [{ id: 'p-active', name: 'Active project', bookCount: 0, generationStatus: 'generating' }] });
  await settlePage();
  assert.equal(h.form.elements.name.value, 'Active project');
  assert.equal(h.form.elements.repo.value, 'owner/active');
  assert.equal(h.node('[data-github-source]').hidden, false);
  assert.equal(h.node('[type=submit]').disabled, true);
  assert.doesNotMatch(h.node('[data-import-status]').textContent, /重新选择/);
  assert.equal(stored.has('shelf-import-draft'), false);
});

test('import another project clears the previous draft without recreating it', async () => {
  const first = pageHarness({ stored: new Map([['shelf-import-draft', JSON.stringify({ name: 'Old name', repo: '', source: 'local', folderName: 'Original Folder' })]]) });
  await first.select();
  first.type('name', 'Old name');
  first.node('[data-new-import]').listeners.click();
  assert.equal(first.stored.has('shelf-import-draft'), false);
  const restored = pageHarness({ stored: first.stored });
  await settlePage();
  assert.equal(restored.form.elements.name.value, '');
  assert.equal(restored.form.elements.repo.value, '');
  assert.doesNotMatch(restored.node('[data-import-status]').textContent, /重新选择/);
});

test('a confirmed import clears input draft and next reload resumes its existing book', async () => {
  const first = pageHarness({ stored: new Map([['shelf-import-draft', JSON.stringify({ name: 'Old name', repo: '', source: 'local', folderName: 'Original Folder' })]]) });
  first.choice('github').listeners.click();
  first.type('repo', 'owner/repository');
  await first.submit();
  assert.equal(first.stored.has('shelf-import-draft'), false);
  const restored = pageHarness({ stored: first.stored, serverProjects: first.projectList });
  await settlePage();
  assert.equal(restored.node('submit-span').textContent, '打开项目主书');
  assert.equal(restored.calls.some(([, method]) => method === 'POST'), false);
});

test('unavailable browser storage explains current-page-only input without blocking import', async () => {
  const h = pageHarness({ storageUnavailable: true });
  h.type('name', 'Unsaved draft');
  await h.select();
  assert.equal(h.form.elements.name.value, 'Unsaved draft');
  assert.match(h.node('[data-import-status]').textContent, /仅.*当前页/);
  assert.equal(h.node('[type=submit]').disabled, false);
  await h.submit();
  assert.ok(h.calls.some(([url, method]) => url === '/api/projects/import' && method === 'POST'));
  assert.equal(h.node('submit-span').textContent, '打开项目主书');
});

function walkNodes(node) { return [node, ...node.children.flatMap(walkNodes)]; }
const sampleProject = (id, title = id) => ({ id, name: title, bookCount: 1, generationStatus: 'ready', books: [{ id: 'main', title, kind: 'main' }] });
test('search distinguishes pending projects from readable books and still reaches child book titles', async () => {
  const h = pageHarness({ serverProjects: [
    { id: 'pending', name: 'Alpha pending', bookCount: 0, books: [], generationStatus: 'generating' },
    { ...sampleProject('ready', 'Alpha engine'), bookCount: 2, books: [{ id: 'main', title: 'Alpha engine', kind: 'main' }, { id: 'queue', title: '队列里的重试', kind: 'exploration' }] },
  ] });
  await settlePage();
  h.node('[data-shelf-search]').value = 'pending'; h.node('[data-shelf-search]').listeners.input();
  assert.match(h.node('[data-search-status]').textContent, /1 个待完成项目/);
  assert.equal(walkNodes(h.node('[data-project-list]')).filter(node => node.href).length, 0, 'pending projects must never acquire a fabricated reading URL');
  assert.ok(walkNodes(h.node('[data-project-list]')).some(node => node.textContent === '查看状态'));
  h.node('[data-shelf-search]').value = '重试'; h.node('[data-shelf-search]').listeners.input();
  assert.match(h.node('[data-search-status]').textContent, /1 本书/);
  assert.ok(walkNodes(h.node('[data-project-list]')).some(node => node.href === '/projects/ready/books/queue/'));
});
test('large shelves bound rendered covers and search all metadata beyond the visible page', async () => {
  const h = pageHarness({ serverProjects: Array.from({ length: 150 }, (_, i) => sampleProject('p-' + i, '项目 ' + String(i).padStart(3, '0'))) });
  await settlePage();
  const root = h.node('[data-project-list]');
  assert.equal(root.children.filter(node => node.tag === 'article').length, 40);
  const more = root.children.find(node => node.className === 'shelf-load-more');
  assert.ok(more); more.listeners.click();
  assert.equal(root.children.filter(node => node.tag === 'article').length, 80);
  h.node('[data-shelf-search]').value = '项目'; h.node('[data-shelf-search]').listeners.input();
  assert.match(h.node('[data-search-status]').textContent, /150 本书/);
  assert.equal(root.children.filter(node => node.tag === 'a').length, 60);
  h.node('[data-shelf-search]').value = '项目 149'; h.node('[data-shelf-search]').listeners.input();
  assert.equal(root.children.filter(node => node.tag === 'a').length, 1);
  assert.equal(root.children[0].href, '/projects/p-149/books/main/');
});


test('an empty recent-reading filter still explains how to start', async () => {
  const h = pageHarness(); await settlePage();
  h.filters.find(button => button.dataset.catalogFilter === 'read').listeners.click();
  assert.match(h.node('[data-project-list]').children[0].textContent, /读过的项目会留在这里/);
});
test('unchanged background polls keep existing book nodes, and real changes update the shelf', async () => {
  const h = pageHarness({ serverProjects: [{ id: 'waiting', name: 'Waiting', bookCount: 0, books: [], generationStatus: 'generating' }, sampleProject('readable')] });
  await settlePage();
  const root = h.node('[data-project-list]'); const first = root.children[0]; const second = root.children[1];
  assert.ok(h.callbacks.length > 0);
  await h.callbacks[0]();
  assert.equal(root.children[0], first); assert.equal(root.children[1], second);
  h.projectList[0].generationStatus = 'failed'; await h.windowListeners['shelf-library-changed']();
  assert.notEqual(root.children[0], first);
  assert.ok(walkNodes(root).some(node => node.textContent === '重试生成'));
});

test('an obviously invalid GitHub address is rejected before any import request and keeps the input', async () => {
  const h = pageHarness(); await settlePage();
  h.choice('github').listeners.click(); h.type('repo', '这不是仓库地址'); h.type('name', '保留这个项目名');
  await h.submit();
  assert.equal(h.calls.some(([, method]) => method === 'POST'), false);
  assert.equal(h.form.elements.repo.value, '这不是仓库地址');
  assert.equal(h.form.elements.name.value, '保留这个项目名');
  assert.match(h.node('[data-import-status]').textContent, /owner\/repository/);
});

test('local validation failure never recovers an unrelated previous import as its result', async () => {
  const h = submitHarness('generation-running');
  h.context.preparedFiles = null;
  await h.submit();
  assert.equal(h.calls.some(call => call[0] === 'get' || call[0] === 'post' || call[0] === 'refresh'), false);
  assert.match(h.statuses.at(-1), /选择.*文件夹/);
});


test('definite quota and authorization rejections preserve the existing retry target and server message', async () => {
  for (const state of ['failed', 'pending']) for (const status of [429, 403]) {
    const h = submitHarness('generation-quota');
    h.context.flow.status = state; h.context.flow.generationId = 'generation-old';
    h.context.post = async () => { throw Object.assign(new Error('本次请求被拒绝：额度或身份不允许'), { status, kind: 'generation-quota' }); };
    await h.submit();
    assert.equal(h.context.flow.projectId, 'p-old');
    assert.equal(h.context.flow.status, state);
    assert.equal(h.calls.some(call => ['get', 'refresh', 'flow-refresh'].includes(call[0])), false);
    assert.match(h.statuses.at(-1), /本次请求被拒绝/);
    assert.equal(h.buttons.at(-1), state === 'failed' ? '重试生成主书' : '开始生成主书');
    assert.equal(h.context.flow.requestError.generationId, 'generation-old');
    assert.equal(h.calls.at(-1)[1], true, 'an existing project keeps its locked source fields');
  }
});

test('a rejected retry message survives a poll of the same failed generation', () => {
  const notices = [];
  const c = vm.createContext({
    flow: { projectId: 'p-old', status: 'failed', generationId: 'old', requestError: { message: '额度不足，请稍后重试', generationId: 'old' } },
    form: { querySelector: () => ({}) }, part: () => ({}), saveFlow() {}, clearImportDraft() {}, lockFields() {}, setButton() {}, setStatus: message => notices.push(message),
  });
  vm.runInContext(source().match(/  function showFlow\([^]*?\n  \}/)[0], c);
  c.showFlow({ id: 'p-old' }, { status: 'failed', generationId: 'old', error: '上一轮的模型错误' });
  assert.equal(notices.at(-1), '额度不足，请稍后重试');
  c.showFlow({ id: 'p-old' }, { status: 'failed', generationId: 'new', error: '新一轮模型错误' });
  assert.equal(notices.at(-1), '新一轮模型错误');
  assert.equal(c.flow.requestError, undefined);
});

function flowReadHarness() {
  const pending = [], shown = [], notices = [], events = [];
  const c = vm.createContext({
    flow: { projectId: 'p-old', generationId: 'generation-old', status: 'generating' }, projects: [{ id: 'p-old', bookCount: 0 }],
    busy: false, flowReadSequence: 0, submissionSequence: 0, readingFiles: 0, preparedFiles: null, folderName: '',
    request: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    showFlow: (project, generation) => shown.push({ project, generation }), setStatus: message => notices.push(message),
    saveFlow() {}, clearImportDraft() {}, lockFields() {}, setSource() {}, setButton() {},
    form: { querySelector: () => ({}), reset() {}, elements: { name: { focus() {} } } }, part: () => ({}),
    window: { dispatchEvent: event => events.push(event) }, CustomEvent: class { constructor(type) { this.type = type; } },
  });
  vm.runInContext(source().match(/  async function updateFlow\([^]*?\n  \}/)[0], c);
  vm.runInContext(source().match(/  function resetImport\([^]*?\n  \}/)[0], c);
  return { c, pending, shown, notices, events };
}

test('overlapping generation readbacks apply only the newest request', async () => {
  const h = flowReadHarness();
  const old = h.c.updateFlow(), fresh = h.c.updateFlow();
  h.pending[1].resolve({ generation: { status: 'generating', stage: 'compiling', generationId: 'generation-new' } }); await fresh;
  h.pending[0].resolve({ generation: { status: 'ready', generationId: 'generation-old' } }); await old;
  assert.equal(h.shown.length, 1);
  assert.equal(h.shown[0].generation.stage, 'compiling');
});

test('reset invalidates pending success and failure readbacks and notifies generation UI', async () => {
  for (const fail of [false, true]) {
    const h = flowReadHarness(), read = h.c.updateFlow();
    h.c.resetImport();
    if (fail) h.pending[0].reject(new Error('old connection failure'));
    else h.pending[0].resolve({ generation: { status: 'ready' } });
    await read;
    assert.equal(h.shown.length, 0);
    assert.equal(h.notices.at(-1), '', 'old transport error cannot replace the fresh form');
    assert.equal(h.events.at(-1).type, 'shelf-import-reset');
    assert.equal(h.c.submissionSequence, 1);
  }
});

test('same project id with a new flow or new generation does not accept an old readback', async () => {
  for (const newObject of [false, true]) {
    const h = flowReadHarness(), read = h.c.updateFlow();
    if (newObject) h.c.flow = { ...h.c.flow };
    else h.c.flow.generationId = 'generation-new';
    h.pending[0].resolve({ generation: { status: 'ready', generationId: 'generation-old' } });
    await read;
    assert.equal(h.shown.length, 0);
  }
});

test('an old import response cannot overwrite a reset form or unlock a newer submission', async () => {
  const h = submitHarness('transport');
  let resolve;
  h.context.post = () => new Promise(done => { resolve = done; });
  const old = h.submit();
  h.context.submissionSequence++;
  const nextFlow = { projectId: 'p-next', name: 'Next', status: 'importing' };
  h.context.flow = nextFlow; h.context.busy = true;
  resolve({ project: { id: 'p-old' }, generation: { status: 'ready' } });
  await old;
  assert.equal(h.context.flow, nextFlow);
  assert.equal(h.context.busy, true);
  assert.equal(h.calls.filter(call => call[0] === 'refresh').length, 1, 'the accepted old project still reaches the shelf without replacing the new form');
});

test('new book reveal expands a name-sorted shelf to include its 75th book without changing sort', async () => {
  const h = pageHarness({ serverProjects: Array.from({ length: 100 }, (_, i) => sampleProject('p-' + i, '项目 ' + String(i).padStart(3, '0'))) });
  await settlePage();
  const sort = h.node('[data-shelf-sort]'); sort.value = 'name'; sort.listeners.change();
  h.windowListeners['shelf-reveal-project']({ detail: { projectId: 'p-74' } });
  const root = h.node('[data-project-list]');
  assert.equal(root.children.filter(item => item.tag === 'article').length, 75);
  assert.ok(walkNodes(root).some(item => item['data-shelf-focus'] === 'book:p-74'));
  assert.equal(sort.value, 'name');
});

test('new book reveal waits for a catalog response that actually contains the target', async () => {
  const h = pageHarness({ serverProjects: Array.from({ length: 100 }, (_, i) => i).filter(i => i !== 74).map(i => sampleProject('p-' + i, '项目 ' + String(i).padStart(3, '0'))) });
  await settlePage();
  const sort = h.node('[data-shelf-sort]'); sort.value = 'name'; sort.listeners.change();
  h.windowListeners['shelf-reveal-project']({ detail: { projectId: 'p-74' } });
  assert.equal(h.node('[data-project-list]').children.filter(item => item.tag === 'article').length, 40);
  h.projectList.push(sampleProject('p-74', '项目 074'));
  await h.windowListeners['shelf-library-changed']();
  assert.equal(h.node('[data-project-list]').children.filter(item => item.tag === 'article').length, 75);
  assert.ok(walkNodes(h.node('[data-project-list]')).some(item => item['data-shelf-focus'] === 'book:p-74'));
  assert.equal(sort.value, 'name');
});
