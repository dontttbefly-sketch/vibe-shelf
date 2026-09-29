// Explicit, narrowly scoped restart acceptance for the isolated 8913 preview.
// Does not start generation and never connects to the user's 8911 service.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.argv.slice(2).join(' ') !== '--run') throw new Error('显式执行 node scripts/verify-workspace-restart.mjs --run：只重启并最终停止 8913 隔离验收服务，保留全部资料。');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = '/private/tmp/shelf-workspace-live-20260929';
const origin = 'http://127.0.0.1:8913';
const owner = 'github-900001';
const ids = ['pupkit', 'learn-claude-code', 'llm-evolution-course', 'workspace-live-local', 'workspace-live-github'];
const evidenceFile = path.join(repo, 'docs/experience/public-product/workspace-live-evidence.json');
const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
if (evidence.root !== root || evidence.origin !== origin || evidence.status !== 'passed-api-checks') throw new Error('只允许重启已经通过真实 API 验收的独立目录。');
const session = JSON.parse(fs.readFileSync(path.join(root, 'browser-cookies.json'), 'utf8'));
if (session.url !== origin) throw new Error('原会话的地址与隔离验收服务不一致。');
const cookie = session.cookies.map(item => item.name + '=' + item.value).join('; ');
const result = { status: 'running', root, origin, startedAt: new Date().toISOString(), originalSessionReadback: false };
const save = () => { evidence.restartPersistence = result; fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n'); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function userSnapshot() {
  const files = {};
  function visit(directory, prefix) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name), relative = path.posix.join(prefix, entry.name);
      if (entry.isSymbolicLink()) throw new Error('users 树包含链接，停止验收。');
      if (entry.isDirectory()) visit(file, relative);
      else if (entry.isFile()) { const bytes = fs.readFileSync(file); files[relative] = { bytes: bytes.length, sha256: hash(bytes) }; }
      else throw new Error('users 树包含特殊文件，停止验收。');
    }
  }
  visit(path.join(root, 'users'), 'users'); return files;
}
function compare(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(file => JSON.stringify(before[file]) !== JSON.stringify(after[file]));
}
async function request(route, raw = false) {
  const response = await fetch(origin + route, { headers: { cookie, origin, 'x-shelf-owner': owner }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`重启回读 ${route} 返回 ${response.status}`);
  return raw ? response.text() : response.json();
}
async function assertReady() {
  const generations = {};
  for (const id of ids.slice(3)) {
    const generation = (await request(`/api/projects/${id}/generation`)).generation;
    if (generation.status !== 'ready') throw new Error('目标服务还有未完成任务，不允许停止：' + id);
    generations[id] = { status: generation.status, generationId: generation.generationId };
  }
  const account = await request('/api/account');
  if (!account.preview?.live || account.user?.id !== owner || account.usage.generation.used !== 2 || account.usage.generation.reserved !== 0 || account.usage.model.used !== 2) throw new Error('目标不是预期真实预览账户或用量不符。');
  return { generations, usage: account.usage };
}
function verifyRuntime(expectedPid) {
  const runtime = JSON.parse(fs.readFileSync(path.join(root, '.shelf-runtime.json'), 'utf8'));
  if (runtime.dataDir !== root || runtime.port !== 8913 || runtime.pid !== expectedPid) throw new Error('运行标识不符，禁止停止其他进程。');
  const command = execFileSync('ps', ['-p', String(expectedPid), '-o', 'command='], { encoding: 'utf8' }).trim();
  if (!/\bnode\s+(?:\S*\/)?scripts\/preview-public-product\.mjs --live --port 8913$/.test(command)) throw new Error('进程命令不是指定 --live 8913 服务，禁止停止。');
  return { ...runtime, command };
}
async function waitStopped(pid) {
  for (let attempt = 0; attempt < 150; attempt++) {
    let exists = true;
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') exists = false; else throw error; }
    if (!exists && !fs.existsSync(path.join(root, '.shelf-runtime.json'))) return;
    await sleep(100);
  }
  throw new Error('服务未在 15 秒内释放运行锁；未发送强制终止。');
}

let restarted = null;
try {
  result.before = await assertReady();
  const runtime = JSON.parse(fs.readFileSync(path.join(root, '.shelf-runtime.json'), 'utf8'));
  result.originalRuntime = verifyRuntime(runtime.pid);
  const before = userSnapshot();
  const beforeFile = path.join(root, 'restart-users-before.json');
  fs.writeFileSync(beforeFile, JSON.stringify(before, null, 2) + '\n');
  result.beforeManifest = beforeFile; result.userFiles = Object.keys(before).length; save();
  process.kill(runtime.pid, 'SIGTERM');
  await waitStopped(runtime.pid);
  result.oldServiceStopped = true; save();
  restarted = spawn(process.execPath, ['scripts/preview-public-product.mjs', '--live', '--port', '8913'], { cwd: repo, env: { ...process.env, SHELF_PUBLIC_DATA_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  let launchOutput = '';
  restarted.stdout.on('data', chunk => { launchOutput += chunk.toString(); });
  restarted.stderr.on('data', chunk => { launchOutput += chunk.toString(); });
  let spawnError; restarted.on('error', error => { spawnError = error; });
  for (let attempt = 0; attempt < 150 && !fs.existsSync(path.join(root, '.shelf-runtime.json')); attempt++) {
    if (spawnError || restarted.exitCode !== null) throw new Error('重启失败：' + (spawnError?.message || launchOutput.slice(-1200)));
    await sleep(100);
  }
  result.restartedRuntime = verifyRuntime(restarted.pid);
  const afterStart = userSnapshot();
  result.afterRestartManifest = path.join(root, 'restart-users-after-start.json');
  fs.writeFileSync(result.afterRestartManifest, JSON.stringify(afterStart, null, 2) + '\n');
  result.changedOnRestart = compare(before, afterStart);
  if (result.changedOnRestart.length) throw new Error('重启改变了 users 文件：' + result.changedOnRestart.join(', '));
  result.after = await assertReady(); result.originalSessionReadback = true;
  result.books = [];
  for (const id of ids) {
    const view = await request('/api/projects/' + id), preview = await request(`/api/projects/${id}/preview`);
    const html = await request(`/projects/${id}/books/main/`, true);
    if (!view.books.some(book => book.id === 'main') || !preview.ready || preview.projectId !== id || !html.includes('SHELF_CONTEXT')) throw new Error('重启后主书或预览不可回看：' + id);
    result.books.push({ projectId: id, title: preview.title, bookCount: view.books.length, readable: true, htmlBytes: Buffer.byteLength(html) });
  }
  const notes = await request('/api/projects/workspace-live-local/books/main/notes');
  const note = notes.find(item => item.id === 'workspace-live-persistence-note');
  if (!note?.body.includes('本地验证旁注（手工合成，未调用模型）') || note?.source?.path !== 'src/queue.js') throw new Error('重启后验证旁注未能读回。');
  result.noteReadback = { id: note.id, matches: true };
  const afterReads = userSnapshot();
  result.changedByReadback = compare(afterStart, afterReads);
  const expectedReadTouches = new Set([
    `users/${owner}/data/projects.json`,
    `users/${owner}/data/projects/workspace-live-local/project.json`,
    `users/${owner}/data/projects/workspace-live-local/books/main/book.json`,
  ]);
  if (result.changedByReadback.some(file => !expectedReadTouches.has(file))) throw new Error('回读改变了预期最近阅读记录以外的文件。');
  result.readbackMutationExplanation = 'GET book notes updates only the book/project lastOpenedAt and projects index; all source, book HTML, notes and usage hashes remain unchanged.';
  result.final = await assertReady();
  verifyRuntime(restarted.pid); restarted.kill('SIGTERM'); await waitStopped(restarted.pid);
  result.finalServiceStopped = true;
  const stopped = userSnapshot();
  result.changedOnFinalStop = compare(afterReads, stopped);
  if (result.changedOnFinalStop.length) throw new Error('停止服务改变了用户资料。');
  result.status = 'passed'; result.completedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: result.status, userFiles: result.userFiles, changedOnRestart: result.changedOnRestart, books: result.books.map(book => book.projectId), noteReadback: result.noteReadback, usage: result.final.usage, finalServiceStopped: true, evidenceFile }));
} catch (error) {
  result.status = 'failed'; result.error = error.message; result.failedAt = new Date().toISOString(); save();
  // Only our verified child may be stopped during cleanup; preserve all data.
  if (restarted && restarted.exitCode === null) { try { verifyRuntime(restarted.pid); restarted.kill('SIGTERM'); await waitStopped(restarted.pid); result.finalServiceStopped = true; save(); } catch {} }
  console.error(JSON.stringify({ status: result.status, error: result.error, evidenceFile })); process.exitCode = 1;
}
