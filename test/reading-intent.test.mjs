import assert from 'node:assert/strict';
import test from 'node:test';
import { startTestServer, validBookHtml } from './api-helpers.mjs';
import { makeTempDir } from './helpers.mjs';
import { createShelfServer } from '../lib/app.mjs';
import { normalizeReadingFocus, normalizeReadingIntent } from '../lib/reading-intent.mjs';

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

test('a written focus reaches every model request, stays with the project and book, and guards retries', async t => {
  const prompts = [];
  const { base } = await startTestServer(t, { modelClient: { async complete({ prompt }) { prompts.push(prompt); if (prompts.length === 1) throw Error('temporary failure'); return validBookHtml; } } });
  const focus = '  讲清请求怎样从路由走到数据库\r\n我要接手：哪里改动风险最大  ';
  const input = { projectId: 'focused', name: 'Focused', readingFocus: focus, files: [{ path: 'src/main.js', content: 'export const answer = 42;' }] };
  const imported = await json(base, '/api/projects/import', input);
  assert.equal(imported.status, 201);
  assert.equal(imported.data.project.readingFocus, '讲清请求怎样从路由走到数据库\n我要接手：哪里改动风险最大');
  assert.equal((await finished(base, 'focused')).status, 'failed');
  assert.equal((await json(base, '/api/projects/focused/generation', {})).status, 200);
  assert.equal((await finished(base, 'focused')).status, 'ready');
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) {
    assert.match(prompt, /本次侧重点/);
    assert.match(prompt, /^> 讲清请求怎样从路由走到数据库$/m);
    assert.match(prompt, /^> 我要接手：哪里改动风险最大$/m);
    assert.doesNotMatch(prompt, /本次阅读目的：快速理解整体/, 'the default overview purpose yields to the reader focus');
  }
  const view = await json(base, '/api/projects/focused');
  assert.equal(view.data.books[0].readingFocus, '讲清请求怎样从路由走到数据库\n我要接手：哪里改动风险最大');
  const listed = await json(base, '/api/projects');
  assert.equal(listed.data.projects.find(project => project.id === 'focused').readingFocus, '讲清请求怎样从路由走到数据库\n我要接手：哪里改动风险最大');
  assert.equal((await json(base, '/api/projects/import', input)).status, 200, 'the same focus is a retry of the same import');
  assert.equal((await json(base, '/api/projects/import', { ...input, readingFocus: '只看测试' })).status, 409);
});

test('a project without a focus keeps the overview purpose and an empty focus field', async t => {
  const prompts = [];
  const { base } = await startTestServer(t, { modelClient: { async complete({ prompt }) { prompts.push(prompt); return validBookHtml; } } });
  const imported = await json(base, '/api/projects/import', { projectId: 'plain', name: 'Plain', readingFocus: '   ', files: [{ path: 'a.js', content: 'ok' }] });
  assert.equal(imported.status, 201);
  assert.equal('readingFocus' in imported.data.project, false, 'an empty focus is not stored in the manifest');
  await finished(base, 'plain');
  assert.equal((await json(base, '/api/projects')).data.projects[0].readingFocus, '');
  assert.match(prompts[0], /本次阅读目的：快速理解整体/);
  assert.doesNotMatch(prompts[0], /本次侧重点/);
});

test('an invalid focus is rejected before any source is saved or model call is made', async t => {
  let calls = 0;
  const { base } = await startTestServer(t, { modelClient: { async complete() { calls++; return validBookHtml; } } });
  for (const [id, readingFocus] of [['too-long', '书'.repeat(501)], ['not-text', { prompt: 'x' }]]) {
    const rejected = await json(base, '/api/projects/import', { projectId: id, name: 'Invalid', readingFocus, files: [{ path: 'a.js', content: 'ok' }] });
    assert.equal(rejected.status, 400, id);
    assert.equal(rejected.data.error.kind, 'invalid-reading-focus');
    assert.equal((await json(base, '/api/projects/' + id)).status, 404);
  }
  assert.equal(calls, 0);
  assert.equal(normalizeReadingFocus('书'.repeat(500)).length, 500);
  assert.equal(normalizeReadingFocus('a\u202eb\u0007c'), 'abc', 'direction overrides and control characters never reach the prompt');
});

test('a GitHub import carries its focus into the prompt and treats a changed focus as a different import', async t => {
  const prompts = [];
  let loads = 0;
  const root = makeTempDir(t);
  const server = createShelfServer({
    dataDir: root + '/data', publicDir: root + '/public',
    modelClient: { async complete({ prompt }) { prompts.push(prompt); return validBookHtml; } },
    githubLoader: async repo => { loads++; return { repo, files: [{ path: 'src/main.js', content: 'export {};' }] }; },
  });
  await new Promise(resolve => server.listen(0, resolve));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const body = { projectId: 'github-focus', repo: 'owner/repo', readingFocus: '调度器怎么选下一个任务' };
  const first = await json(base, '/api/projects/import-github', body);
  assert.equal(first.status, 201);
  assert.equal(first.data.project.readingFocus, '调度器怎么选下一个任务');
  await finished(base, 'github-focus');
  assert.match(prompts[0], /^> 调度器怎么选下一个任务$/m);
  assert.equal((await json(base, '/api/projects/import-github', body)).status, 200);
  assert.equal((await json(base, '/api/projects/import-github', { ...body, readingFocus: '别的侧重点' })).status, 409);
  assert.equal(loads, 1);
});
