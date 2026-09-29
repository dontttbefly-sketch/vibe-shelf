// Explicit opt-in live check. Only the synthetic source below is sent to the
// existing configured model. OAuth remains a local provider fixture.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPublicShelfServer } from '../lib/public-server.mjs';
import { createConfiguredModelClient } from '../lib/model-client.mjs';

if (process.argv.slice(2).join(' ') !== '--run') throw new Error('显式执行：node scripts/verify-public-real-model.mjs --run（调用现有模型，仅发送内置合成源码）');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const model = createConfiguredModelClient({ root: repo });
if (!model.getStatus().configured) throw new Error('现有模型未配置，未发送请求。');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-public-real-'));
fs.chmodSync(root, 0o700);
const origin = 'https://public-real-check.invalid';
const projectId = 'real-public-queue';
const source = `export function createQueue() {
  const items = [];
  return {
    enqueue(value) {
      items.push(value);
      return items.length;
    },
    dequeue() {
      if (items.length === 0) return null;
      return items.shift();
    },
    size() {
      return items.length;
    }
  };
}
`;
const files = [
  { path: 'README.md', content: '# Pocket Queue\n这是一个纯内存 FIFO 队列。入口 src/queue.js，无网络、数据库或后台任务。空队列 dequeue 返回 null。\n' },
  { path: 'src/queue.js', content: source },
];
const evidence = { date: new Date().toISOString(), kind: 'public-mode-real-model', root, model: model.getStatus().model, oauth: 'controlled-provider', source: files, calls: [], observedStages: [], status: 'running' };
const evidenceFile = path.join(repo, 'docs/experience/public-product/real-model-evidence.json');
function save() { fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n'); }
const server = createPublicShelfServer({ dataDir: path.join(root, 'data'), publicDir: path.join(repo, 'public'), modelClient: model,
  environment: { SHELF_PUBLIC_ORIGIN: origin, GITHUB_CLIENT_ID: 'local-evidence-client', GITHUB_CLIENT_SECRET: 'local-evidence-placeholder' },
  fetchImpl: async url => {
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'local-provider-only' });
    if (url === 'https://api.github.com/user') return Response.json({ id: 910001, login: 'public-real-check', name: '隔离真实模型验收' });
    throw new Error('未声明的 OAuth 外部请求。');
  },
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;
let cookie;
async function request(url, body, raw = false) {
  const start = performance.now();
  const response = await fetch(base + url, { redirect: 'manual', method: body === undefined ? 'GET' : 'POST',
    headers: { ...(cookie ? { cookie, 'x-shelf-owner': 'github-910001' } : {}), origin, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = raw ? await response.text() : await response.json();
  if (!url.endsWith('/generation')) evidence.calls.push({ url, status: response.status, milliseconds: Math.round(performance.now() - start) });
  if (!response.ok) throw new Error(result?.error?.message || `验收请求失败 ${response.status}`);
  return { response, result };
}
try {
  const begin = await fetch(base + '/auth/github', { redirect: 'manual' });
  const state = new URL(begin.headers.get('location')).searchParams.get('state');
  const callback = await fetch(base + '/auth/github/callback?code=local-only&state=' + state, { redirect: 'manual', headers: { cookie: begin.headers.get('set-cookie').split(';')[0] } });
  cookie = callback.headers.getSetCookie().find(c => c.startsWith('__Host-shelf-session=')).split(';')[0];
  const started = Date.now();
  console.log(JSON.stringify({ stage: 'starting', model: evidence.model, sourceFiles: files.map(f => f.path), root }));
  const imported = (await request('/api/projects/import', { projectId, name: 'Pocket Queue · 真实公共流程验收', readingIntent: 'handoff', files })).result;
  evidence.snapshotId = imported.project.currentSnapshotId;
  for (;;) {
    const generation = (await request(`/api/projects/${projectId}/generation`)).result.generation;
    const state = generation.status + ':' + (generation.stage || '');
    if (evidence.observedStages.at(-1)?.state !== state) {
      evidence.observedStages.push({ state, elapsedMs: Date.now() - started });
      console.log(JSON.stringify({ stage: state, elapsedMs: Date.now() - started })); save();
    }
    if (generation.status !== 'generating') {
      evidence.generation = generation;
      if (generation.status !== 'ready') throw new Error(generation.error || '主书没有完成。');
      break;
    }
    if (Date.now() - started > 16 * 60 * 1000) throw new Error('真实模型验收超过16分钟，当前任务仍留在隔离目录。');
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  evidence.generationMs = Date.now() - started;
  const bookPage = await request(`/projects/${projectId}/books/main/`, undefined, true);
  fs.writeFileSync(path.join(root, 'delivered-public.html'), bookPage.result);
  evidence.book = { status: bookPage.response.status, bytes: Buffer.byteLength(bookPage.result), sha256: crypto.createHash('sha256').update(bookPage.result).digest('hex'), csp: bookPage.response.headers.get('content-security-policy').replace(/'nonce-[^']+'/g, "'nonce-[redacted]'"), sourceLinks: (bookPage.result.match(/data-file=/g) || []).length };
  evidence.preview = (await request(`/api/projects/${projectId}/preview`)).result;
  const answer = (await request(`/api/projects/${projectId}/books/main/explain`, { question: "只根据 src/queue.js：新建队列依次 enqueue('A')、enqueue('B') 后，连续三次 dequeue 分别返回什么？用两句话回答。", selection: 'dequeue()' })).result;
  evidence.annotation = answer;
  await request(`/api/projects/${projectId}/books/main/notes`, { note: { id: 'real-public-note', section: 'verification', question: 'FIFO和空队列返回值', body: answer.content, quote: 'dequeue()' } });
  const notes = (await request(`/api/projects/${projectId}/books/main/notes`)).result;
  if (notes[0]?.body !== answer.content) throw new Error('真实解释保存后回读不一致。');
  evidence.noteReadback = { count: notes.length, matches: true };
  evidence.accountUsage = (await request('/api/account')).result.usage;
  if (evidence.accountUsage.generation.used !== 1 || evidence.accountUsage.generation.reserved !== 0 || evidence.accountUsage.model.used !== 2) throw new Error('交付或模型次数与真实操作不一致。');
  evidence.status = 'passed'; save();
  console.log(JSON.stringify({ status: evidence.status, generationMs: evidence.generationMs, chapters: evidence.preview.chapters?.length, sourceLinks: evidence.book.sourceLinks, answer: answer.content, noteReadback: evidence.noteReadback, usage: evidence.accountUsage, evidenceFile }));
} catch (error) {
  evidence.status = 'failed'; evidence.error = error.message; save();
  console.error(JSON.stringify({ status: 'failed', message: error.message, evidenceFile })); process.exitCode = 1;
} finally {
  server.closeIdleConnections?.(); await new Promise(resolve => server.close(resolve));
}
