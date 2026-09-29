// Loopback-only public experience: controlled fixtures by default; --live uses
// the existing model configuration and public GitHub loader with durable data.
// The local identity wrapper never changes production OAuth requirements.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createPublicShelfServer, PUBLIC_EXAMPLE_IDS } from "../lib/public-server.mjs";
import { createLocalLibrary } from "../lib/local-library.mjs";
import { createConfiguredModelClient } from "../lib/model-client.mjs";
import { seedPerformanceLibrary } from "./performance-library.mjs";
import { parsePreviewArgs, prepareLivePreview } from "./public-preview-runtime.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parsePreviewArgs(process.argv.slice(2));
const liveMode = options.live, performanceMode = options.performance;
const persistent = liveMode ? prepareLivePreview({ repo, migrateFrom: options.migrateFrom }) : null;
const root = persistent?.root || fs.mkdtempSync(path.join(os.tmpdir(), "shelf-public-product-"));
fs.chmodSync(root, 0o700);
const privateRoot = liveMode ? root : path.join(root, "data", "public-service");
const requestedPort = options.port;
process.once("exit", () => persistent?.lock.release());
let origin, publicHandler;
const source = "export function greet(name) {\n  const title = 'Hello';\n  const message = title + name;\n  return message;\n}";
const fixtureFolder = path.join(root, "project-source");
if (!liveMode) {
  fs.mkdirSync(path.join(fixtureFolder, "src"), { recursive: true });
  fs.writeFileSync(path.join(fixtureFolder, "src", "main.js"), source);
  fs.writeFileSync(path.join(fixtureFolder, "README.md"), "# 流程验收项目\n入口是 src/main.js。greet 接受名字并返回问候。仅用于隔离流程验收。\n");
}
const html = `<!doctype html><style>:root{--paper:#fffdf7;--ink:#151b1e;--code-bg:#f5f1ea;--code-ink:#151b1e;--line:#e8e4dc}body{background:var(--paper);color:var(--ink);font:16px/1.8 system-ui;margin:0}.book-header,.book-layout{max-width:1000px;margin:auto;padding:40px}.book-layout{display:grid;grid-template-columns:160px minmax(0,1fr);gap:36px}.book-toc a{display:block;color:inherit}.chapter{min-height:420px}pre{padding:20px;background:var(--code-bg);overflow:auto}h1{font-size:42px}@media(max-width:700px){.book-layout{display:block}.book-header,.book-layout{padding:24px}}</style><div class="progress"></div><header class="book-header"><h1>公共流程验收书</h1><span class="sub">由受控模型生成，仅验证流程，不代表真实内容质量。</span></header><div class="book-layout"><nav class="book-toc"><a href="#start">项目入口</a><a href="#flow">运行机制</a><a href="#next">继续探索</a></nav><main class="book-main"><section class="chapter" id="start"><h2>项目入口</h2><p>这个隔离项目通过 src/main.js 的 greet 函数生成一句问候。选择这段文字可以验证公共 CSP 下的旁注、追问与保存。</p><pre><code>${source}</code></pre></section><section class="chapter" id="flow"><h2>运行机制</h2><p>名字进入函数后与 Hello 拼接，结果由 return 返回。源码抽屉应跳到同一个不可变快照的对应代码行。</p></section><section class="chapter" id="next"><h2>继续探索</h2><p>在书底提出新问题，回答经过明确确认后可以成为探索小书。此处仍然使用受控模型。</p></section></main></div><script>void 0</script>`;
const failed = new Set();
if (performanceMode) seedPerformanceLibrary(root, html, source);
else if (!liveMode || persistent.fresh) {
  // Copy the existing books into this temporary account, including their source
  // snapshots and notes. Restoring books does not invoke the model or spend quota.
  const originalData = path.join(repo, "data");
  // The library constructor recovers pending transactions. A preview must never
  // trigger that recovery against the user's original library.
  if (fs.readdirSync(originalData, { withFileTypes: true }).some(entry => entry.isDirectory() && /^\.restore-[0-9a-f-]{36}$/.test(entry.name))) {
    throw new Error("原资料有待完成的恢复事务，请先完成恢复，再启动本机验收。");
  }
  const original = createLocalLibrary({ dataDir: originalData, publicDir: path.join(repo, "public") });
  const tenantRoot = path.join(privateRoot, "users", "github-900001");
  const preview = createLocalLibrary({ dataDir: path.join(tenantRoot, "data"), publicDir: path.join(tenantRoot, "books") });
  for (const id of PUBLIC_EXAMPLE_IDS) preview.restore(original.backup(id));
}
function makePublicServer() { return createPublicShelfServer({
  dataDir: path.join(root, "data"), publicDir: path.join(repo, "public"),
  environment: { ...(liveMode ? process.env : {}), SHELF_PUBLIC_DATA_DIR: privateRoot, SHELF_PUBLIC_ORIGIN: origin, GITHUB_CLIENT_ID: "public-preview-client", GITHUB_CLIENT_SECRET: "public-preview-not-a-real-secret" },
  fetchImpl: async (url, init) => {
    if (url === "https://github.com/login/oauth/access_token") {
      const input = JSON.parse(init.body);
      if (input.code !== "controlled-preview" || !input.code_verifier || input.redirect_uri !== origin + "/auth/github/callback") return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: "public-preview-provider-token" });
    }
    if (url === "https://api.github.com/user" && init.headers.authorization === "Bearer public-preview-provider-token") {
      return Response.json(performanceMode ? { id: 900002, login: "performance-preview", name: "多书性能样本账户" } : { id: 900001, login: "public-preview", name: liveMode ? "本机体验账户" : "流程验收账户" });
    }
    throw new Error("隔离预览拒绝任何未声明的上游请求。");
  },
  githubLoader: liveMode ? undefined : async repoName => ({ repo: repoName, sourceCommit: "a".repeat(40), sourceTreeSha: "b".repeat(40),
    files: [{ path: "README.md", content: "# 流程验收项目\n入口是 src/main.js，仅用于受控验收。" }, { path: "src/main.js", content: source }] }),
  modelClient: liveMode ? createConfiguredModelClient({ root: repo }) : {
    getStatus: () => ({ configured: true, model: "公共流程验收替身" }),
    async complete({ prompt, maxTokens }) {
      await new Promise(resolve => setTimeout(resolve, 6000));
      if (prompt.includes("TEST_FAIL_ONCE") && !failed.has(prompt)) { failed.add(prompt); throw new Error("流程验收：模拟一次失败，项目已保留，可以重试。"); }
      if (prompt.includes("TEST_FAIL_MODEL")) throw new Error("流程验收：受控模型持续失败。");
      if (maxTokens >= 16000) return html;
      if (prompt.includes("只输出 JSON 数组")) return JSON.stringify([
        { title: "greet 如何处理输入", rationale: "src/main.js 展示了参数、拼接与返回路径。" },
        { title: "项目入口怎样组织", rationale: "README.md 与 src/main.js 提供了目录和入口依据。" },
      ]);
      if (prompt.includes("matchType")) return JSON.stringify({ matchType: "none", jumpIndex: null, jumpTitle: "", answer: "这是公共模式的受控检索回答。" });
      return "这是公共模式的受控测试回答。\n\n`src/main.js` 的 greet 函数把传入名字与 Hello 拼接，再返回结果。此回答仅用于验证旁注、探索与保存链路。";
    },
  },
}); }

// Invoke the unchanged production HTTP handler for the two OAuth steps. The
// local preview wrapper never exposes a bypass token or adds a production route.
async function dispatchAuth(url, headers = {}) {
  const request = Object.assign(Readable.from([]), { method: "GET", url, headers, socket: { remoteAddress: "127.0.0.1" } });
  const response = new EventEmitter(), output = new Map();
  response.setHeader = (name, value) => output.set(name.toLowerCase(), value);
  response.writeHead = (status, values = {}) => { response.statusCode = status; for (const [name, value] of Object.entries(values)) response.setHeader(name, value); };
  response.end = () => { response.writableEnded = true; response.emit("finish"); };
  await publicHandler(request, response);
  return { status: response.statusCode, header: name => output.get(name) };
}

async function establishSession() {
  const begin = await dispatchAuth("/auth/github?returnTo=%2F%23upload");
  if (begin.status !== 302) throw new Error("受控 OAuth 开始验证失败。");
  const state = new URL(begin.header("location")).searchParams.get("state");
  const challengeCookie = begin.header("set-cookie").split(";")[0];
  const callback = await dispatchAuth("/auth/github/callback?code=controlled-preview&state=" + encodeURIComponent(state), { cookie: challengeCookie });
  if (callback.status !== 302) throw new Error("受控 OAuth 回调未能建立预览会话。");
  const session = callback.header("set-cookie").find(cookie => cookie.startsWith("shelf-session="));
  if (!session) throw new Error("预览会话 Cookie 缺失。");
  return session;
}

const acceptanceHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>知识书架 · 本机流程验收</title><style>body{margin:0;background:#f5f1ea;color:#151b1e;font:17px/1.8 system-ui,sans-serif}main{max-width:620px;margin:10vh auto;padding:32px}small{color:#993c1d;letter-spacing:.1em}h1{font-size:36px;line-height:1.2}p{color:#596164}button{border:0;border-radius:12px;background:#993c1d;color:#fffdf7;padding:16px 24px;font:inherit;cursor:pointer}a{color:#993c1d}button:focus-visible,a:focus-visible{outline:3px solid #ce7b51;outline-offset:5px}</style></head><body><main><small>仅限本机 · 流程验收</small><h1>体验把项目变成书</h1><p>继续后使用临时的「流程验收账户」。本页的 GitHub OAuth 与模型都是受控替身；不会访问真实 GitHub，不消耗真实账户额度，也不产生模型费用。</p><p>生成内容固定，等待约 6 秒，仅用于检查上传、生成、阅读、旁注和探索是否连贯，不代表真实模型的内容质量。页面显示的生成额度是本机模拟记录，用来验收结算流程。</p><p>各浏览器会进入同一个本机验收账户，资料保存在临时目录中。</p><form method="post" action="/__acceptance/session"><button type="submit">使用临时账户开始体验</button></form><p><a href="/">先浏览官网与真实案例</a></p></main></body></html>`;
const liveAcceptanceHtml = acceptanceHtml
  .replaceAll("本机流程验收", "本机真实体验")
  .replace("仅限本机 · 流程验收", "仅限本机 · 真实模型")
  .replace(/<p>继续后[\s\S]*?<form/, '<p>使用本机体验账户，项目、读本和旁注会保存在本机，重启后可以继续阅读。</p><p>GitHub 仓库会读取真实公开源码，生成会调用已经配置的模型服务并产生实际用量。登录身份仅供本机体验，不代表正式 GitHub 授权。</p><form')
  .replace("使用临时账户开始体验", "使用本机账户开始体验");

// Add the loopback-only capability to successful account responses without
// changing production routes, exposing credentials or bypassing owner checks.
async function previewAccount(req, res) {
  const response = new EventEmitter(), headers = new Map();
  response.setHeader = (name, value) => headers.set(name.toLowerCase(), value);
  response.writeHead = (status, values = {}) => { response.statusCode = status; for (const [name, value] of Object.entries(values)) response.setHeader(name, value); };
  response.end = body => {
    if (response.statusCode === 200) {
      const account = JSON.parse(body);
      account.preview = { local: true, live: liveMode, sessionUrl: "/__acceptance/session" };
      if (liveMode && account.user?.id === "github-900001") account.user = { ...account.user, name: "本机体验账户" };
      body = JSON.stringify(account);
    }
    response.writableEnded = true;
    res.writeHead(response.statusCode, Object.fromEntries(headers));
    res.end(body);
    response.emit("finish");
  };
  await publicHandler(req, response);
}

const server = http.createServer(async (req, res) => {
  // This file is a loopback-only test harness. These routes do not exist in the
  // production server and cannot log in to any real GitHub account.
  const pathname = new URL(req.url, origin || "http://127.0.0.1").pathname;
  if (req.headers.host !== new URL(origin).host) { res.writeHead(403); res.end("本机验收地址不匹配。"); return; }
  if (pathname === "/api/account" && req.method === "GET") { await previewAccount(req, res); return; }
  if (pathname === "/auth/github" && req.method === "GET") { res.writeHead(302, { location: "/__acceptance", "cache-control": "no-store" }); res.end(); return; }
  if (pathname === "/__acceptance" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
    res.end(liveMode ? liveAcceptanceHtml : performanceMode ? acceptanceHtml.replace("体验把项目变成书", "120 本合成书 · 性能验收").replace("各浏览器会进入同一个本机验收账户，资料保存在临时目录中。", "这是独立的性能样本账户，内置 120 本合成书，只用于测量搜索、分页、长标题与悬停。它们不属于真实成品，也不计为模型生成。当前正常验收账户和三本公开案例保持不变。") : acceptanceHtml); return;
  }
  if (pathname === "/__acceptance/session") {
    req.resume();
    if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); res.end(); return; }
    if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") { res.writeHead(403); res.end("请从本机验收页面继续。"); return; }
    try {
      const session = await establishSession();
      res.writeHead(302, { location: performanceMode ? "/#library" : "/#upload", "set-cookie": session, "cache-control": "no-store" }); res.end();
    } catch { res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }); res.end("临时账户建立失败，请重新打开验收页面再试。"); }
    return;
  }
  await publicHandler(req, res);
});

try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(requestedPort, "127.0.0.1", resolve); });
  // localhost isolates performance cookies from the normal 127.0.0.1 preview.
  origin = `http://${performanceMode ? "localhost" : "127.0.0.1"}:${server.address().port}`;
  publicHandler = makePublicServer().listeners("request")[0];
  persistent?.lock.publish(server.address().port);
  const session = await establishSession();
  const cookieFile = path.join(root, "browser-cookies.json");
  fs.writeFileSync(cookieFile, JSON.stringify({ url: origin, cookies: [{ name: "shelf-session", value: session.split(";")[0].slice("shelf-session=".length),
    domain: new URL(origin).hostname, path: "/", httpOnly: true, secure: false, sameSite: "Lax" }] }), { mode: 0o600 });
  console.log(JSON.stringify({ url: origin, root, privateRoot, cookieFile, mode: liveMode ? "live" : performanceMode ? "performance" : "controlled", backup: persistent?.migration?.backup || null }));
} catch (error) {
  server.close(); persistent?.lock.release(); throw error;
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => {
  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
});
