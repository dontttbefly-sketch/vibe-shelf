import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.classList = { toggle() {} }; this.textContent = ''; this.hidden = false; this.value = ''; this.disabled = false; }
  appendChild(el) { this.children.push(el); return el; }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(key, value) { this.listeners[key] = value; }
  replaceChildren(...children) { this.children = children; }
  querySelector(selector) { return all(this).find(el => selector === '[data-model-status]' ? Object.hasOwn(el.dataset, 'modelStatus') : selector === '[data-runtime-details]' && Object.hasOwn(el.dataset, 'runtimeDetails')); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
  click() { this.clicked = true; this.listeners.click?.({ currentTarget: this }); }
  remove() { this.removed = true; }
}
function all(node) { return [node, ...node.children.flatMap(all)]; }
const tick = () => new Promise(resolve => setImmediate(resolve));
const backup = name => ({ format: 'vibe-shelf-library', version: 1, projectIds: [name], projectIndex: [{ id: name, name }], legacyIds: [] });
async function setup({ refreshFails = false, restoreWait, restoreLosesResponse = false, restoreRejects = false, publicMode = false, authenticated = true } = {}) {
  const body = new Element('body'), opener = new Element('button'), events = [];
  const state = { restored: false, archived: false, calls: [], accountOpened: 0 };
  const fetch = async (url, options = {}) => {
    state.calls.push(url);
    if (url === '/api/account') return { ok: true, json: async () => ({ mode: 'public', authenticated }) };
    if (url === '/api/library/backup' || url.endsWith('/export')) return { ok: true, blob: async () => new Blob(['saved project backup']) };
    if (url === '/api/status') return { ok: true, json: async () => ({ model: { configured: false }, version: '0', dataDir: '/tmp/mock' }) };
    if (url === '/api/library/restore') {
      state.payload = JSON.parse(options.body);
      if (restoreWait) await restoreWait;
      if (restoreRejects) return { ok: false, status: 409, json: async () => ({ error: { kind: 'restore-conflict', message: '项目已存在，恢复只会新增项目。' } }) };
      state.restored = true;
      if (restoreLosesResponse) throw TypeError('Failed to fetch');
      return { ok: true, json: async () => ({ projectIds: state.payload.projectIds, legacyIds: [] }) };
    }
    if (url.endsWith('/archive')) { state.archivePayload = JSON.parse(options.body); state.archived = state.archivePayload.archived; return { ok: true }; }
    if (url === '/api/projects') {
      if (refreshFails && (state.restored || state.archived)) throw Error('refresh failed after committed write');
      return { ok: true, json: async () => ({ projects: [{ id: 'old', name: '旧项目', bookCount: 1, archived: state.archived }] }) };
    }
    throw Error('unexpected ' + url);
  };
  const window = { dispatchEvent: event => events.push(event.type), ...(publicMode ? {
    SHELF_ACCOUNT_CONTEXT: { mode: 'public', userId: authenticated ? 'github-101' : 'guest' },
    ShelfLanding: { openAccount() { state.accountOpened++; }, refreshAccount() {} },
  } : {}) };
  vm.runInNewContext(fs.readFileSync(new URL('../public/settings.js', import.meta.url), 'utf8'), {
    document: { body, createElement: tag => new Element(tag), querySelector: () => opener },
    window, fetch, AbortSignal, Event, setTimeout: callback => callback(), URL,
  });
  await opener.listeners.click();
  const nodes = () => all(body);
  return { state, events, nodes, window, find: text => nodes().find(el => el.textContent === text), input: nodes().find(el => el.type === 'file'), status: nodes().find(el => el.className === 'shelf-settings-status') };
}
async function select(harness, name) {
  harness.input.files = [{ size: 100, name: name + '.json', text: async () => JSON.stringify(backup(name)) }];
  await harness.input.listeners.change();
}
async function click(harness, name) {
  const button = harness.find(name);
  const event = { currentTarget: button };
  button.listeners.click(event);
  event.currentTarget = null; // Native events clear currentTarget after synchronous dispatch.
  await tick();
  return button;
}

test('successful restore stays successful and notifies the shelf if list refresh fails', async () => {
  const h = await setup({ refreshFails: true });
  await select(h, '新项目');
  const button = await click(h, '恢复这份资料');
  assert.equal(h.state.restored, true);
  assert.deepEqual(h.events, ['shelf-library-changed']);
  assert.match(h.status.textContent, /恢复完成/);
  assert.match(h.status.textContent, /列表.*未刷新/);
  assert.equal(button.hidden, true);
});

test('successful archive stays successful and notifies the shelf if list refresh fails', async () => {
  const h = await setup({ refreshFails: true });
  await click(h, '从书架收起');
  assert.equal(h.state.archived, true);
  assert.deepEqual(h.events, ['shelf-library-changed']);
  assert.match(h.status.textContent, /已从书架收起/);
  assert.match(h.status.textContent, /列表.*未刷新/);
  assert.ok(h.find('放回书架'), 'a committed archive must update its visible action even without a refreshed list');
  await click(h, '放回书架');
  assert.equal(h.state.archivePayload.archived, false);
});

test('slower prior backup selection cannot replace the latest preview or restored payload', async () => {
  const h = await setup();
  let release;
  h.input.files = [{ name: 'A.json', size: 100, text: () => new Promise(resolve => { release = resolve; }) }];
  const oldRead = h.input.listeners.change();
  await select(h, 'B');
  release(JSON.stringify(backup('A')));
  await oldRead;
  assert.match(h.nodes().find(el => el.textContent.startsWith('准备恢复')).textContent, /（B）/);
  await click(h, '恢复这份资料');
  assert.deepEqual(h.state.payload.projectIds, ['B']);
});

test('backup selection is disabled during an active restore and retains the submitted file', async () => {
  let release;
  const h = await setup({ restoreWait: new Promise(resolve => { release = resolve; }) });
  await select(h, 'A');
  const button = await click(h, '恢复这份资料');
  assert.equal(h.input.disabled, true);
  await select(h, 'B'); // An already queued change event is also ignored while writing.
  assert.match(h.nodes().find(el => el.textContent.startsWith('准备恢复')).textContent, /（A）/);
  release();
  await tick();
  assert.deepEqual(h.state.payload.projectIds, ['A']);
  assert.equal(h.input.disabled, false);
  assert.equal(button.hidden, true);
});

test('lost restore response states uncertainty, preserves the backup, and rereads the shelf', async () => {
  const h = await setup({ restoreLosesResponse: true });
  await select(h, 'A');
  const button = await click(h, '恢复这份资料');
  assert.equal(h.state.restored, true, 'the simulated server committed before losing its response');
  assert.match(h.status.textContent, /暂未确认恢复结果/);
  assert.match(h.status.textContent, /重新打开书架检查/);
  assert.match(h.status.textContent, /再次恢复不会覆盖已有资料/);
  assert.doesNotMatch(h.status.textContent, /恢复完成|恢复失败/);
  assert.deepEqual(h.events, ['shelf-library-changed']);
  assert.equal(button.hidden, false);
  assert.equal(h.input.files[0].name, 'A.json');
  assert.match(h.nodes().find(el => el.textContent.startsWith('准备恢复')).textContent, /（A）/);
});

test('confirmed restore rejection stays distinct from an unknown network outcome', async () => {
  const h = await setup({ restoreRejects: true });
  await select(h, 'A');
  const button = await click(h, '恢复这份资料');
  assert.equal(h.state.restored, false);
  assert.match(h.status.textContent, /项目已存在/);
  assert.doesNotMatch(h.status.textContent, /暂未确认/);
  assert.equal(button.hidden, false);
  assert.deepEqual(h.events, []);
});

test('public personal-data management is reachable and supports archive, return, export, backup and restore without local diagnostics', async () => {
  const h = await setup({ publicMode: true });
  assert.ok(h.nodes().some(el => el.tag === 'dialog' && el.open));
  assert.ok(h.find('个人资料管理'));
  assert.match(h.nodes().map(el => el.textContent).join('\n'), /只管理当前登录账户/);
  assert.doesNotMatch(h.nodes().map(el => el.textContent).join('\n'), /本地服务与模型|检查模型连接|\.env|版本与资料位置|\/tmp\/mock/);
  await click(h, '从书架收起');
  assert.equal(h.state.archived, true); assert.ok(h.find('放回书架'));
  await click(h, '放回书架');
  assert.equal(h.state.archived, false); assert.ok(h.find('从书架收起'));
  await click(h, '导出资料');
  await click(h, '备份我的全部资料');
  const downloads = h.nodes().filter(el => el.tag === 'a' && el.clicked);
  assert.equal(downloads.length, 2);
  assert.ok(downloads.every(el => el.download.endsWith('.json')));
  await select(h, '恢复项目'); await click(h, '恢复这份资料');
  assert.equal(h.state.restored, true); assert.match(h.status.textContent, /恢复完成/);
  assert.ok(h.state.calls.includes('/api/projects/old/export'));
  assert.ok(h.state.calls.includes('/api/library/backup'));
  assert.ok(h.state.calls.includes('/api/library/restore'));
  assert.ok(!h.state.calls.includes('/api/status')); assert.ok(!h.state.calls.includes('/api/model/check'));
});

test('public guests cannot open personal-data controls and account changes stop further management requests', async () => {
  const guest = await setup({ publicMode: true, authenticated: false });
  assert.equal(guest.state.accountOpened, 1);
  assert.ok(!guest.nodes().some(el => el.tag === 'dialog'));
  assert.deepEqual(guest.state.calls, ['/api/account']);
  const h = await setup({ publicMode: true });
  const count = h.state.calls.length;
  h.window.SHELF_ACCOUNT_CHANGED = true;
  await click(h, '从书架收起');
  assert.equal(h.state.calls.length, count);
  assert.match(h.status.textContent, /登录账户已变化/);
  assert.equal(h.state.archived, false);
});
