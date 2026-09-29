// 隔离体验环境。真实资料只复制内置示例，模型替身与真实模型显式分开。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShelfServer } from '../lib/app.mjs';
import { createConfiguredModelClient } from '../lib/model-client.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const root = path.resolve(value('--dir', fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-experience-'))));
if (!root.startsWith(path.resolve(os.tmpdir()) + path.sep) && !root.startsWith('/tmp/')) throw new Error('预览只允许使用系统临时目录');
const publicDir = path.join(root, 'public');
const dataDir = path.join(root, 'data');
fs.mkdirSync(publicDir, { recursive: true });
for (const entry of fs.readdirSync(path.join(repo, 'public'), { withFileTypes: true })) {
  if (entry.name === 'projects') continue;
  fs.cpSync(path.join(repo, 'public', entry.name), path.join(publicDir, entry.name), { recursive: true });
}
for (const base of ['data', 'public']) {
  const target = path.join(root, base, 'projects', 'pupkit');
  if (!fs.existsSync(target)) fs.cpSync(path.join(repo, base, 'projects', 'pupkit'), target, { recursive: true });
}
const mode = value('--model', 'controlled');
const latency = Math.max(0, Math.min(60000, Number(value('--latency', '1000')) || 0));
let failedOnce = false;
const fixture = `<!doctype html><style>:root{--paper:#fffdf7;--ink:#151b1e;--code-bg:#f5f1ea;--code-ink:#151b1e;--line:#e8e1d7}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.8 system-ui}.book-header,.book-main{max-width:760px;margin:auto;padding:32px}.chapter{min-height:450px;scroll-margin-top:80px}pre{overflow:auto}h2{font-size:26px}</style><div class="progress"></div><header class="book-header"><h1>交互验收示例</h1><p>可控模型生成的测试书，仅用于流程验证。</p></header><main class="book-main"><section class="chapter" id="start"><h2>项目从哪里开始</h2><p>这里是用于验收导入、阅读、旁注和源码联动的测试正文。它不代表真实模型对项目的理解。</p><p>选择这段文字，可以继续提问。</p><pre><code>export function greet(name) {\n  const title = 'Hello';\n  const message = title + name;\n  return message;\n}</code></pre></section><section class="chapter" id="flow"><h2>一个完整流程</h2><p>用户导入项目后，先阅读主书，再围绕感兴趣的问题继续探索。生成小书需要明确操作。</p></section><section class="chapter" id="next"><h2>继续深入</h2><p>书底是另开方向的探索入口。关闭并重新打开后，可以从本项目找回成果。</p></section></main><script>void 0</script>`;
const modelClient = mode === 'configured' ? createConfiguredModelClient({ root: repo }) : {
  getStatus() { return { configured: true, model: '可控测试模型（流程验收）', url: null }; },
  async complete({ prompt, maxTokens }) {
    await new Promise(resolve => setTimeout(resolve, latency));
    if (String(prompt).includes('TEST_FAIL_ONCE') && !failedOnce) { failedOnce = true; throw new Error('交互验收：模拟一次临时失败，可以重试'); }
    if (String(prompt).includes('TEST_FAIL_MODEL')) throw new Error('交互验收：模拟模型暂时不可用');
    if (maxTokens >= 16000) return fixture;
    if (String(prompt).includes('matchType')) return JSON.stringify({ matchType: 'none', jumpIndex: null, jumpTitle: '', answer: '这是可控模型的检索测试回答。' });
    return '这是可控模型的交互测试回答。\n\n可以继续追问，也可以将它整理成小书。真实源码与模型内容质量需要另外验收。';
  },
};
const server = createShelfServer({ dataDir, publicDir, modelClient });
const port = Number(value('--port', '8907'));
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ root, url: `http://127.0.0.1:${port}`, model: mode })));
