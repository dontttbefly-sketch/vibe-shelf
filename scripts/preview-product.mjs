// 三本真实书的隔离体验环境；新生成使用可控模型，正式书与模型配置不改动。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShelfServer } from '../lib/app.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-product-'));
const dataDir = path.join(root, 'data'), publicDir = path.join(root, 'public');
fs.mkdirSync(publicDir, { recursive: true });
for (const entry of fs.readdirSync(path.join(repo, 'public'), { withFileTypes: true })) {
  if (entry.name !== 'projects' && entry.name !== 'data') fs.symlinkSync(path.join(repo, 'public', entry.name), path.join(publicDir, entry.name));
}
for (const base of ['data', 'public']) for (const id of ['pupkit', 'learn-claude-code', 'llm-evolution-course']) {
  const source = path.join(repo, base, 'projects', id);
  if (fs.existsSync(source)) fs.cpSync(source, path.join(root, base, 'projects', id), { recursive: true });
}
const html = `<!doctype html><style>:root{--paper:#fffdf7;--ink:#151b1e;--code-bg:#f5f1ea;--code-ink:#151b1e;--line:#e8e4dc}body{background:var(--paper);color:var(--ink);font:16px/1.8 system-ui;margin:0}.book-header,.book-main{max-width:780px;margin:auto;padding:40px}.chapter{min-height:480px}h1{font-size:42px}</style><div class="progress"></div><header class="book-header"><h1>交互流程验收书</h1><p>由可控模型生成，仅验证流程，不代表真实内容质量。</p></header><div class="book-layout"><nav class="book-toc"><a href="#start">项目入口</a><a href="#flow">运行机制</a></nav><main class="book-main"><section class="chapter" id="start"><h2>项目入口</h2><p>这本书用于验证导入、成书、阅读与回看。选择这段文字可以测试旁注。</p><p>参见 src/main.js。</p></section><section class="chapter" id="flow"><h2>运行机制</h2><p>这里是受控的流程验收内容。</p></section></main></div><script>void 0</script>`;
const failed = new Set();
const modelClient = { getStatus: () => ({ configured: true, model: '流程验收替身' }), async complete({ prompt, maxTokens }) {
  await new Promise(resolve => setTimeout(resolve, 6500));
  if (prompt.includes('TEST_FAIL_ONCE') && !failed.has(prompt)) { failed.add(prompt); throw Error('验收：模型暂时不可用，可以重试。'); }
  return maxTokens >= 16000 ? html : '可控测试回答，仅验证交互链路。';
} };
const server = createShelfServer({ dataDir, publicDir, modelClient });
const port = Number(process.env.SHELF_PREVIEW_PORT || 8910);
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ root, url: `http://127.0.0.1:${port}`, model: 'controlled', realBooks: 3 })));
