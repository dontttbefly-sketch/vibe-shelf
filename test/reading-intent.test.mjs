import assert from 'node:assert/strict';
import test from 'node:test';
import { startTestServer, validBookHtml } from './api-helpers.mjs';
import { normalizeReadingIntent } from '../lib/reading-intent.mjs';

async function json(base, path, body) {
  const r = await fetch(base + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  return { status: r.status, data: await r.json() };
}
async function finished(base, id) {
  for (let n = 0; n < 100; n++) {
    const { data } = await json(base, `/api/projects/${id}/generation`);
    if (data.generation.status !== 'generating') return data.generation;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('generation did not settle');
}

test('reading purpose reaches actual model requests, persists into book and survives a retry', async t => {
  const prompts = [];
  const { base } = await startTestServer(t, { modelClient: { async complete({ prompt }) { prompts.push(prompt); if (prompts.length === 1) throw Error('temporary failure'); return validBookHtml; } } });
  const input = { projectId: 'purpose', name: 'Purpose', readingIntent: 'handoff', files: [{ path: 'src/main.js', content: 'export const answer = 42;' }] };
  const imported = await json(base, '/api/projects/import', input);
  assert.equal(imported.status, 201);
  assert.equal(imported.data.project.readingIntent, 'handoff');
  assert.equal((await finished(base, 'purpose')).status, 'failed');
  assert.equal((await json(base, '/api/projects/purpose/generation', {})).status, 200);
  const ready = await finished(base, 'purpose');
  assert.equal(ready.status, 'ready');
  assert.equal(ready.readingIntent, 'handoff');
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) assert.match(prompt, /本次阅读目的：为接手修改做准备/);
  const view = await json(base, '/api/projects/purpose');
  assert.equal(view.data.books[0].readingIntent, 'handoff');
  assert.equal((await json(base, '/api/projects/import', { ...input, readingIntent: 'core' })).status, 409);
});

test('invalid reading purpose is rejected before creating source or consuming a model call', async t => {
  let calls = 0;
  const { base } = await startTestServer(t, { modelClient: { async complete() { calls++; return validBookHtml; } } });
  const rejected = await json(base, '/api/projects/import', { projectId: 'invalid-purpose', name: 'Invalid', readingIntent: 'write a secret prompt', files: [{ path: 'a.js', content: 'ok' }] });
  assert.equal(rejected.status, 400);
  assert.equal(calls, 0);
  assert.equal((await json(base, '/api/projects/invalid-purpose')).status, 404);
  assert.equal(normalizeReadingIntent(undefined), 'overview');
});
