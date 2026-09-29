import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNotesStore } from '../lib/notes-store.mjs';
import { startTestServer, validBookHtml } from './api-helpers.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-note-revision-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, store: createNotesStore({ dataDir }) };
}
const conflict = error => error.statusCode === 409 && error.kind === 'note-conflict';

test('two tabs editing the same revision cannot overwrite the accepted draft', t => {
  const { store } = setup(t);
  const [initial] = store.upsert('p', 'main', { id: 'n1', body: 'original' });
  assert.equal(initial.revision, 1);
  store.upsert('p', 'main', { ...initial, body: 'tab A' });
  assert.throws(() => store.upsert('p', 'main', { ...initial, body: 'tab B' }), conflict);
  assert.equal(store.list('p', 'main', { withRevisions: true })[0].body, 'tab A');
});

test('old records migrate once and unversioned stale clients cannot bypass conflict checking', t => {
  const { dataDir, store } = setup(t);
  const dir = path.join(dataDir, 'projects', 'p', 'notes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'main.json'), JSON.stringify([{ id: 'n1', body: 'old' }]));
  store.upsert('p', 'main', { id: 'n1', body: 'first edit' });
  assert.equal(store.list('p', 'main', { withRevisions: true })[0].revision, 1);
  assert.throws(() => store.upsert('p', 'main', { id: 'n1', body: 'stale edit' }), conflict);
});

test('a lost response may retry the same content without creating a false conflict', t => {
  const { store } = setup(t);
  const note = { id: 'n1', body: 'only once', source: { path: 'x.js', startLine: 1, endLine: 1 } };
  store.upsert('p', 'main', note);
  const [retried] = store.upsert('p', 'main', note);
  assert.equal(retried.revision, 1);
  assert.equal(store.list('p', 'main', { withRevisions: true }).length, 1);
});

test('stale delete is rejected and deleted notes cannot resurrect through pending retries', t => {
  const { store } = setup(t);
  const [initial] = store.upsert('p', 'main', { id: 'n1', body: 'original' });
  const [updated] = store.upsert('p', 'main', { ...initial, body: 'new' });
  assert.throws(() => store.remove('p', 'main', 'n1', initial.revision), conflict);
  store.remove('p', 'main', 'n1', updated.revision);
  assert.throws(() => store.upsert('p', 'main', initial), conflict);
  assert.throws(() => store.upsert('p', 'main', { id: 'n1', body: 'legacy pending' }), conflict);
  assert.equal(store.list('p', 'main', { withRevisions: true }).length, 0);
});

test('HTTP notes opt into revisions, reject stale writes/deletes, and preserve legacy response shape', async t => {
  const { base } = await startTestServer(t);
  const request = (url, method = 'GET', body) => fetch(base + url, {
    method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  await request('/api/projects/import', 'POST', {
    projectId: 'revision-demo', name: 'Revision Demo', files: [{ path: 'index.js', content: 'export const answer = 42;' }],
    mainBook: { title: 'Revision Demo', sourceHtml: validBookHtml },
  });
  const url = '/api/projects/revision-demo/books/main/notes';
  assert.equal((await request(url, 'POST', { note: { id: 'n1', body: 'original' } })).status, 200);
  assert.deepEqual(await (await request(url)).json(), [{ id: 'n1', body: 'original' }]);
  const [initial] = await (await request(url + '?revisions=1')).json();
  assert.equal(initial.revision, 1);
  assert.equal((await request(url, 'POST', { note: { ...initial, body: 'tab A' } })).status, 200);
  const stale = await request(url, 'POST', { note: { ...initial, body: 'tab B' } });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.kind, 'note-conflict');
  assert.equal((await request(url + '?id=n1&revision=1', 'DELETE')).status, 409);
  const [latest] = await (await request(url + '?revisions=1')).json();
  assert.equal(latest.body, 'tab A');
  assert.equal((await request(url + '?id=n1&revision=' + latest.revision, 'DELETE')).status, 200);
});
