// Explicit live acceptance against an already running loopback preview. This
// script never creates a model adapter, starts a server or retries generation.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (!args.includes('--run')) throw new Error('显式执行：node scripts/verify-workspace-live.mjs --run --root <私有预览目录> --origin <本机网址>；首次执行最多调用两次真实主书生成。');
function option(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
const root = path.resolve(option('--root', '/private/tmp/shelf-workspace-live-20260929'));
const origin = option('--origin', 'http://127.0.0.1:8913');
const address = new URL(origin);
if (address.hostname !== '127.0.0.1' || address.protocol !== 'http:' || address.pathname !== '/' || address.search || address.hash) throw new Error('只允许明确的 127.0.0.1 本机预览地址。');
const owner = 'github-900001';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceFile = path.join(repo, 'docs/experience/public-product/workspace-live-evidence.json');
const session = JSON.parse(fs.readFileSync(path.join(root, 'browser-cookies.json'), 'utf8'));
if (session.url !== origin) throw new Error('Cookie 文件与本机预览地址不匹配，未发送请求。');
const cookie = session.cookies.map(item => item.name + '=' + item.value).join('; ');
const previous = fs.existsSync(evidenceFile) ? JSON.parse(fs.readFileSync(evidenceFile, 'utf8')) : null;
if (previous && (previous.root !== root || previous.origin !== origin)) throw new Error('已有验收记录属于其他服务；请先单独归档记录，未发送请求。');
const evidence = previous || { kind: 'workspace-live-api-acceptance', startedAt: new Date().toISOString(), root, origin, owner, calls: [], projects: [] };
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const save = () => fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n');
const emit = value => console.log(JSON.stringify(value));
async function request(route, body, { allow404 = false, raw = false } = {}) {
  const started = performance.now();
  const response = await fetch(origin + route, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
    headers: { cookie, origin, 'x-shelf-owner': owner, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(body === undefined ? 45000 : 150000),
  });
  const output = raw ? await response.text() : await response.json();
  if (!route.endsWith('/generation')) evidence.calls.push({ route, status: response.status, milliseconds: Math.round(performance.now() - started) });
  if (allow404 && response.status === 404) return null;
  if (!response.ok) throw new Error(`验收请求 ${route} 返回 ${response.status}：${output?.error?.message || '未成功'}`);
  return { response, output };
}

const localFiles = [
  { path: 'README.md', content: '# Pocket Queue\n这是一个纯内存 FIFO 队列。入口 src/queue.js，无网络、数据库或后台任务。enqueue 返回入队后的长度，空队列 dequeue 返回 null。\n' },
  { path: 'src/queue.js', content: `export function createQueue() {
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
` },
];
const cases = [
  { id: 'workspace-live-local', route: '/api/projects/import', input: { projectId: 'workspace-live-local', name: 'Pocket Queue · 工作台真实验收', readingIntent: 'handoff', files: localFiles } },
  { id: 'workspace-live-github', route: '/api/projects/import-github', input: { projectId: 'workspace-live-github', name: 'Spoon-Knife · 工作台真实验收', readingIntent: 'overview', repo: 'octocat/Spoon-Knife' } },
];

async function inspectSnapshot(item, project) {
  const snapshotId = project.currentSnapshotId;
  const listing = (await request(`/api/projects/${item.id}/snapshots/${snapshotId}/files`)).output.files;
  const records = [], sources = new Map();
  for (const file of listing) {
    const remote = (await request(`/api/projects/${item.id}/snapshots/${snapshotId}/file?path=${encodeURIComponent(file.path)}`)).output;
    const disk = fs.readFileSync(path.join(root, 'users', owner, 'data', 'projects', item.id, 'source', snapshotId, file.path));
    if (sha256(remote.content) !== sha256(disk)) throw new Error('快照 API 与磁盘哈希不一致：' + file.path);
    const expected = item.id === 'workspace-live-local' ? localFiles.find(source => source.path === file.path) : null;
    if (item.id === 'workspace-live-local' && (!expected || sha256(expected.content) !== sha256(disk))) throw new Error('本地输入与快照不一致：' + file.path);
    records.push({ path: file.path, bytes: disk.byteLength, sha256: sha256(disk), apiMatchesDisk: true, ...(expected ? { matchesSubmittedSource: true } : {}) });
    sources.set(file.path, remote.content);
  }
  if (item.id === 'workspace-live-local' && records.length !== localFiles.length) throw new Error('本地快照文件数量与提交不一致。');
  if (item.id === 'workspace-live-github' && (project.importSource?.type !== 'github' || project.importSource.repo.toLowerCase() !== 'octocat/spoon-knife' || !/^[a-f0-9]{40}$/.test(project.importSource.sourceCommit || ''))) throw new Error('GitHub 导入缺少真实仓库和提交来源。');
  return { snapshotId, files: records, sources, importSource: project.importSource };
}

async function inspectDelivery(item, record) {
  const projectView = (await request('/api/projects/' + item.id)).output;
  const snapshot = await inspectSnapshot(item, projectView.project);
  record.snapshot = { snapshotId: snapshot.snapshotId, files: snapshot.files, importSource: snapshot.importSource };
  if (item.id === 'workspace-live-local') {
    // inspectSnapshot already proves these bytes match the fixed synthetic
    // fixture above. Never execute arbitrary imported project code here.
    const { createQueue } = await import('data:text/javascript;base64,' + Buffer.from(snapshot.sources.get('src/queue.js')).toString('base64'));
    const first = createQueue(), second = createQueue();
    const observed = [first.enqueue('A'), first.enqueue('B'), first.dequeue(), first.dequeue(), first.dequeue(), first.size(), second.size()];
    if (JSON.stringify(observed) !== JSON.stringify([1, 2, 'A', 'B', null, 0, 0])) throw new Error('本地合成队列的确定行为与验收基线不符。');
    record.sourceBehavior = { operation: 'enqueue A, enqueue B, dequeue x3, size, independent queue size', result: observed, matches: true };
  }
  const delivered = await request(`/projects/${item.id}/books/main/`, undefined, { raw: true });
  const html = delivered.output;
  const artifacts = { html: path.join(root, item.id + '-delivered.html'), text: path.join(root, item.id + '-delivered.txt') };
  fs.writeFileSync(artifacts.html, html);
  const plain = html.replace(/<(?:style|script)\b[^>]*>[\s\S]*?<\/(?:style|script)>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  fs.writeFileSync(artifacts.text, plain);
  const references = Array.from(html.matchAll(/<[^>]*\bdata-file="([^"]+)"[^>]*>/g), match => {
    const line = Number(match[0].match(/\bdata-line="(\d+)"/)?.[1] || 0);
    const source = snapshot.sources.get(match[1]);
    return { path: match[1], line: line || null, existsInSnapshot: source !== undefined, lineInRange: !line || source !== undefined && line <= source.split('\n').length };
  });
  if (references.some(ref => !ref.existsInSnapshot || !ref.lineInRange)) throw new Error('生成书包含不属于快照的源码锚点。');
  if (item.id === 'workspace-live-local' && !references.some(ref => ref.path === 'src/queue.js' && ref.line)) throw new Error('本地队列读本没有可核验的代码锚点。');
  record.book = { bytes: Buffer.byteLength(html), sha256: sha256(html), references, artifacts, sourceSnapshotId: projectView.books.find(book => book.id === 'main')?.sourceSnapshotId };
  if (record.book.sourceSnapshotId !== snapshot.snapshotId) throw new Error('交付主书与项目源码快照不一致。');
  record.preview = (await request(`/api/projects/${item.id}/preview`)).output;
  if (!record.preview.ready || record.preview.projectId !== item.id || !record.preview.chapters?.length) throw new Error('交付预览缺失或身份不一致。');
  record.verifiedAt = new Date().toISOString();
  emit({ projectId: item.id, status: 'delivery-verified', files: snapshot.files.length, chapters: record.preview.chapters.length, references: references.length });
  save();
}

try {
  const account = (await request('/api/account')).output;
  if (!account.authenticated || account.user?.id !== owner || !account.preview?.live) throw new Error('目标必须为已登录的真实本机体验服务。');
  evidence.initialUsage ||= account.usage;
  delete evidence.error; delete evidence.stoppedAt;
  evidence.status = 'running'; save();
  for (const item of cases) {
    let record = evidence.projects.find(project => project.projectId === item.id);
    if (!record) { record = { projectId: item.id, inputKind: item.id.endsWith('local') ? 'synthetic-local' : 'real-public-github', observedStages: [] }; evidence.projects.push(record); }
    let existing = await request('/api/projects/' + item.id, undefined, { allow404: true });
    if (!existing) {
      if (record.importAttemptedAt) throw new Error('此前导入结果尚未确认；项目未查到，不自动重复提交：' + item.id);
      record.importAttemptedAt = new Date().toISOString(); save();
      emit({ projectId: item.id, status: 'importing', sourceFiles: item.input.files?.map(file => file.path), repo: item.input.repo });
      const imported = (await request(item.route, item.input)).output;
      record.importResponse = { projectId: imported.project.id, snapshotId: imported.project.currentSnapshotId, reused: Boolean(imported.reused) };
      save();
    } else record.reusedOnLatestRun = true;
    const waitingSince = Date.now();
    for (;;) {
      const generation = (await request(`/api/projects/${item.id}/generation`)).output.generation;
      if (!generation) throw new Error('已有项目没有生成任务；不自动补发生成：' + item.id);
      const state = generation.status + ':' + (generation.stage || '');
      if (record.observedStages.at(-1)?.state !== state) {
        record.observedStages.push({ state, at: new Date().toISOString(), sinceImportMs: Date.now() - new Date(record.importAttemptedAt).getTime() });
        emit({ projectId: item.id, state });
      }
      record.generation = generation; save();
      if (generation.status !== 'generating') {
        if (generation.status !== 'ready') throw new Error('生成未完成，保留原任务且不自动重试：' + item.id + ' / ' + generation.status);
        break;
      }
      if (Date.now() - waitingSince > 16 * 60 * 1000) throw new Error('等待超过 16 分钟，保留原任务且不自动重试：' + item.id);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    await inspectDelivery(item, record);
  }
  const note = { id: 'workspace-live-persistence-note', section: 'verification', question: '工作台真实流程保存验收', body: '本地验证旁注（手工合成，未调用模型）：FIFO 队列按入队顺序返回元素；空队列返回 null。', quote: 'dequeue()', source: { path: 'src/queue.js', startLine: 8, endLine: 10 } };
  const noteRoute = '/api/projects/workspace-live-local/books/main/notes';
  const notes = (await request(noteRoute)).output;
  if (!notes.some(item => item.id === note.id && item.body === note.body)) await request(noteRoute, { note });
  const readback = (await request(noteRoute)).output.find(item => item.id === note.id);
  if (readback?.body !== note.body || readback?.source?.path !== note.source.path) throw new Error('手工验收旁注保存回读不一致。');
  evidence.noteReadback = { projectId: 'workspace-live-local', bookId: 'main', id: note.id, matches: true, origin: 'synthetic-manual-no-model-call' };
  evidence.finalUsage = (await request('/api/account')).output.usage;
  if (evidence.finalUsage.generation.used !== 2 || evidence.finalUsage.generation.reserved !== 0 || evidence.finalUsage.model.used !== 2) throw new Error('用量与两次主书交付不一致。');
  evidence.status = 'passed-api-checks'; evidence.completedAt = new Date().toISOString(); save();
  emit({ status: evidence.status, usage: evidence.finalUsage, evidenceFile, noteReadback: evidence.noteReadback });
} catch (error) {
  evidence.status = 'stopped-with-task-preserved'; evidence.error = error.message; evidence.stoppedAt = new Date().toISOString(); save();
  emit({ status: evidence.status, error: error.message, evidenceFile }); process.exitCode = 1;
}
