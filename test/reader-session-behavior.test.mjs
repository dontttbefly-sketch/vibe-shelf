import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = () => fs.readFileSync(new URL('../public/notes.js', import.meta.url), 'utf8');
function fn(name) {
  const match = source().match(new RegExp('  (?:async )?function ' + name + '\\([^]*?\\n  \\}'));
  assert.ok(match, `${name} must exist`);
  return match[0];
}
function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k),
    key: i => [...values.keys()][i] ?? null, get length() { return values.size; },
  };
}
function queueContext(overrides = {}) {
  const context = vm.createContext({
    localStorage: storage(), localNotesKey: () => 'notes', pendingMemory: null,
    persistChains: Object.create(null), notes: [], BOOK: 'main', STATIC_MODE: false, CONTEXT: { projectId: 'p' },
    revisionAdvances: Object.create(null), showNoteConflicts() {}, noteDraftOwner: 'window-a',
    Promise, JSON, Date, projectNotesPath: () => '/notes', ...overrides,
  });
  vm.runInContext(['pendingNotesKey', 'samePendingDraft', 'readPendingNotes', 'writePendingNotes', 'markPending', 'clearPending', 'mergePending', 'persistLocal', 'persist', 'savedToast'].map(fn).join('\n'), context);
  return context;
}

test('pending edited note wins over same-id stale server note', () => {
  const c = queueContext();
  c.markPending({ id: 'a', body: 'new local draft' });
  assert.equal(c.mergePending([{ id: 'a', body: 'old server draft' }])[0].body, 'new local draft');
});

test('409 retains a visible local conflict and never auto-retries it', async () => {
  let calls = 0;
  const c = queueContext({
    fetch: async () => { calls++; return { ok: false, status: 409, json: async () => ({ error: { kind: 'note-conflict' } }) }; },
  });
  const outcome = await c.persist({ id: 'a', body: 'local edit', revision: 1 });
  assert.equal(outcome, 'conflict');
  const pending = c.readPendingNotes()[0];
  assert.equal(pending.body, 'local edit');
  assert.equal(pending._saveConflict, true);
  assert.equal(await c.persist(pending), 'conflict');
  assert.equal(calls, 1);
});

test('two offline windows retain both same-id drafts for explicit recovery', async () => {
  const shared = storage();
  const offline = async () => { throw Error('offline'); };
  const a = queueContext({ localStorage: shared, fetch: offline, noteDraftOwner: 'window-a' });
  const b = queueContext({ localStorage: shared, fetch: offline, noteDraftOwner: 'window-b' });
  await a.persist({ id: 'a', body: 'draft A', revision: 1 });
  await b.persist({ id: 'a', body: 'draft B', revision: 1 });
  const reloaded = queueContext({ localStorage: shared, fetch: offline, noteDraftOwner: 'window-c' });
  const drafts = reloaded.readPendingNotes();
  assert.deepEqual(new Set(drafts.map(n => n.body)), new Set(['draft A', 'draft B']));
  assert.ok(drafts.some(n => n.body === 'draft A' && n._saveConflict && n._conflictOriginalId === 'a'));
});

test('successful retry removes identical recovery copies without inventing a conflict', async () => {
  const shared = storage();
  const a = queueContext({ localStorage: shared, fetch: async () => { throw Error('offline'); }, noteDraftOwner: 'window-a' });
  await a.persist({ id: 'a', body: 'draft A', revision: 1 });
  const b = queueContext({
    localStorage: shared, noteDraftOwner: 'window-b',
    fetch: async () => ({ ok: true, json: async () => ({ notes: [{ id: 'a', body: 'draft A', revision: 2 }] }) }),
  });
  assert.equal(await b.persist(b.readPendingNotes()[0]), 'synced');
  assert.equal(b.readPendingNotes().length, 0);
});

test('acknowledgement of old revision does not clear newer pending revision', () => {
  const c = queueContext();
  c.markPending({ id: 'a', body: 'new' });
  c.clearPending('a', { id: 'a', body: 'old' });
  assert.equal(c.readPendingNotes()[0]?.body, 'new');
});

test('unavailable browser storage never reports a durable save', async () => {
  const c = queueContext({ localStorage: { getItem: () => null, setItem: () => { throw Error('quota'); }, removeItem() {} } });
  const outcome = await c.persistLocal({ id: 'a', body: 'keep me' });
  assert.equal(outcome, 'memory');
  assert.match(c.savedToast(outcome, '已保存'), /未保存|未能保存/);
  assert.equal(c.notes[0].body, 'keep me');
});

test('same-note writes are serialized and stale responses preserve latest local draft', async () => {
  const requests = [];
  const c = queueContext({ fetch: (_url, options) => new Promise(resolve => requests.push({ body: JSON.parse(options.body), resolve })) });
  const first = c.persist({ id: 'a', body: 'one' });
  const second = c.persist({ id: 'a', body: 'two' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1, 'same-note requests must not race');
  requests[0].resolve({ ok: true, json: async () => ({ notes: [{ id: 'a', body: 'one' }] }) });
  await first;
  assert.equal(c.notes[0].body, 'two');
  await new Promise(resolve => setImmediate(resolve));
  requests[1].resolve({ ok: true, json: async () => ({ notes: [{ id: 'a', body: 'two' }] }) });
  await second;
  assert.equal(c.notes[0].body, 'two');
  assert.equal(c.readPendingNotes().length, 0);
});

test('delayed follow-up cannot mutate a different note after switching', async () => {
  let resolve;
  const previous = { existingId: 'a', body: 'A' };
  const current = { existingId: 'b', body: 'B' };
  let applies = 0;
  const c = vm.createContext({
    resultState: previous, STATIC_MODE: false, CONTEXT: { projectId: 'p' },
    inlineAskEl: () => null, projectBookPath: () => '/followup', toast() {},
    saveInlineDraft() {}, clearInlineDraft() {}, cancelFollowup() {},
    followupSeq: 0, followupCtrl: null, AbortController, setTimeout, clearTimeout,
    fetch: () => new Promise(r => { resolve = r; }),
    applyFollowupInline() { applies++; },
  });
  vm.runInContext(fn('askFollowup'), c);
  const request = c.askFollowup('free', '', 'explain');
  c.resultState = current;
  resolve({ ok: true, json: async () => ({ content: 'changed A' }) });
  await request;
  assert.equal(applies, 0);
  assert.equal(previous.__versions, undefined);
  assert.equal(current.body, 'B');
});

test('IME composition Enter is not a send action', () => {
  const c = vm.createContext({});
  vm.runInContext(fn('isComposingKey'), c);
  assert.equal(c.isComposingKey({ key: 'Enter', isComposing: true }), true);
  assert.equal(c.isComposingKey({ key: 'Enter', keyCode: 229 }), true);
  assert.equal(c.isComposingKey({ key: 'Enter' }), false);
});

test('shared source opener refuses a different snapshot before looking up a file', async () => {
  let reads = 0;
  const c = vm.createContext({ sourceOpenSeq: 0, snapshotAvailable: () => true, CONTEXT: { sourceSnapshotId: 's-current' }, toast() {}, resolveSourceRef: async () => { reads++; return 'src/a.js'; } });
  vm.runInContext(fn('openReferencedSource'), c);
  assert.equal(await c.openReferencedSource({ path: 'src/a.js', startLine: 1, sourceSnapshotId: 's-old' }), false);
  assert.equal(reads, 0);
});

test('shared source opener validates unique file and real line range before opening drawer', async () => {
  const calls = [];
  const c = vm.createContext({
    sourceOpenSeq: 0, snapshotAvailable: () => true, CONTEXT: { sourceSnapshotId: 's-current' }, toast() {},
    resolveSourceRef: async p => p === 'ambiguous.js' ? null : 'src/a.js',
    readFiles: async () => [{ path: 'src/a.js', content: 'first\nsecond\nthird' }],
    toggleSourceDrawer: () => calls.push('open'), showSourceFile: async (...args) => { calls.push(args); return true; },
  });
  vm.runInContext(fn('openReferencedSource'), c);
  assert.equal(await c.openReferencedSource({ path: 'ambiguous.js', startLine: 1, sourceSnapshotId: 's-current' }), false);
  assert.equal(await c.openReferencedSource({ path: 'src/a.js', startLine: 2, endLine: 20, sourceSnapshotId: 's-current' }), false);
  assert.equal(calls.length, 0);
  assert.equal(await c.openReferencedSource({ path: 'src/a.js', startLine: 2, endLine: 3, sourceSnapshotId: 's-current' }), true);
  assert.equal(calls[0], 'open');
  assert.deepEqual(calls[1], ['src/a.js', 2, 3]);
});

test('temporary source-list failure remains retryable instead of caching an empty snapshot', async () => {
  let calls = 0;
  const c = vm.createContext({
    bookFiles: null, CONTEXT: { projectId: 'p' }, projectSnapshotPath: () => '/files',
    fetch: async () => ++calls === 1
      ? { ok: false, json: async () => ({ error: 'offline' }) }
      : { ok: true, json: async () => ({ files: [{ path: 'src/a.js' }] }) },
  });
  vm.runInContext(fn('loadBookFiles'), c);
  assert.equal((await c.loadBookFiles()).length, 0);
  assert.equal((await c.loadBookFiles())[0]?.path, 'src/a.js');
  assert.equal(calls, 2);
});
