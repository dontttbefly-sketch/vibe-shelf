import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { createShelfServer } from "./app.mjs";
import { fetchGithubRepoFiles } from "./github-import.mjs";
import { createPublicAuth, publicConfiguration } from "./public-auth.mjs";
import { createPublicUsage, positiveLimit } from "./public-usage.mjs";
import { renderPublicBook, renderPublicIndex } from "./public-render.mjs";
import { extractShelfPreview } from "./shelf-library.mjs";
import { extractStyleFingerprint } from "./prompts.mjs";
import { httpError, readJsonBody, sendJson } from "./http.mjs";
import { isInsideRoot, assertId } from "./ids.mjs";
import { readJson } from "./json-store.mjs";

export const PUBLIC_EXAMPLE_IDS = Object.freeze(["pupkit", "learn-claude-code", "llm-evolution-course"]);
const MIME = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2" };

function readRegular(root, relative, limit = 2 * 1024 * 1024) {
  const target = path.resolve(root, relative);
  if (!isInsideRoot(root, target)) throw httpError("内容不存在。", 404, "not-found");
  let check = path.resolve(root);
  for (const part of path.relative(root, target).split(path.sep)) {
    check = path.join(check, part);
    if (!fs.existsSync(check) || fs.lstatSync(check).isSymbolicLink()) throw httpError("内容不存在。", 404, "not-found");
  }
  const stat = fs.statSync(target);
  if (!stat.isFile() || stat.size > limit) throw httpError("内容暂时不可读取。", 404, "not-found");
  return fs.readFileSync(target);
}

function sendPage(res, page) {
  res.setHeader("content-security-policy", page.policy);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page.html);
}

function bodyRequest(req, input) {
  const bytes = Buffer.from(JSON.stringify(input));
  const copy = Readable.from([bytes]);
  Object.assign(copy, { method: req.method, url: req.url, headers: { ...req.headers, "content-length": String(bytes.length) } });
  return copy;
}

export function createPublicShelfServer({ dataDir, publicDir, modelClient, environment = process.env, fetchImpl, githubLoader }) {
  const privateRoot = path.resolve(environment.SHELF_PUBLIC_DATA_DIR || path.join(dataDir, "public-service"));
  if (privateRoot === path.resolve(publicDir) || isInsideRoot(publicDir, privateRoot)) throw new Error("公共服务私有资料目录不能位于 public 目录内。");
  fs.mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  const config = publicConfiguration(environment);
  const auth = createPublicAuth({ root: path.join(privateRoot, "auth"), configuration: config, fetchImpl });
  const tenants = new Map();
  const loginAttempts = new Map();
  const limits = { generationLimit: positiveLimit(environment.SHELF_GENERATION_LIMIT, 3), dailyModelLimit: positiveLimit(environment.SHELF_DAILY_MODEL_LIMIT, 100) };
  const loginLimit = positiveLimit(environment.SHELF_LOGIN_RATE_LIMIT, 20);
  // The operator's GITHUB_TOKEN may access private repos belonging to somebody
  // else. Public imports must never inherit that authority or OAuth login tokens.
  const publicGithubLoader = githubLoader || (repo => fetchGithubRepoFiles(repo, { token: "" }));

  function tenant(user) {
    let item = tenants.get(user.id);
    if (!item) {
      const root = path.join(privateRoot, "users", user.id);
      const userData = path.join(root, "data"), userPublic = path.join(root, "books");
      const usage = createPublicUsage({ root, dataDir: userData, publicDir: userPublic, ...limits });
      const server = createShelfServer({ dataDir: userData, publicDir: userPublic, modelClient: usage.modelClient(modelClient), environment, githubLoader: publicGithubLoader });
      item = { root, dataDir: userData, publicDir: userPublic, usage, handler: server.listeners("request")[0] };
      tenants.set(user.id, item);
    }
    return item;
  }

  function example(id) {
    if (!PUBLIC_EXAMPLE_IDS.includes(id)) throw httpError("案例不存在。", 404, "not-found");
    const html = readRegular(publicDir, `projects/${id}/books/main/index.html`).toString("utf8");
    const readingUrl = `/examples/${id}/books/main/`;
    const preview = extractShelfPreview(html, readingUrl);
    const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.replace(/&amp;/g, "&") || id;
    const styleFingerprint = extractStyleFingerprint(html);
    return { html, title, readingUrl, styleFingerprint, preview };
  }

  function examples() {
    return PUBLIC_EXAMPLE_IDS.flatMap(id => {
      try {
        const item = example(id);
        return [{ id, name: item.title, sourceType: "example", isExample: true, mainBookId: "main", bookCount: 1,
          status: "ready", generationStatus: "ready", mainBook: { id: "main", title: item.title, url: item.readingUrl, styleFingerprint: item.styleFingerprint },
          books: [{ id: "main", kind: "main", title: item.title, url: item.readingUrl }], previewUrl: `/api/examples/${id}/preview` }];
      } catch { return []; }
    });
  }

  function loginRate(req) {
    const peer = req.socket?.remoteAddress || "unknown", now = Date.now();
    let key = peer;
    // Opt in only for a proxy on this same host. Use the rightmost forwarded
    // address (the proxy's actual client), never an attacker-supplied first hop.
    if (environment.SHELF_TRUST_PROXY === "loopback" && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer)) {
      const forwarded = String(req.headers["x-forwarded-for"] || "").slice(-256).split(",").at(-1).trim();
      if (isIP(forwarded)) key = forwarded;
    }
    for (const [address, entry] of loginAttempts) if (entry.until < now) loginAttempts.delete(address);
    const entry = loginAttempts.get(key) || { count: 0, until: now + 10 * 60 * 1000 };
    entry.count++; loginAttempts.set(key, entry);
    if (entry.count > loginLimit) throw httpError("登录请求较多，请稍后再试。", 429, "login-rate");
  }

  function assertPageOwner(req, user, required = true) {
    const declared = req.headers["x-shelf-owner"];
    if (!declared && !required) return;
    if (!declared) throw httpError("请刷新页面后继续操作。", 403, "owner-required");
    // This header never selects a tenant. Only the validated HttpOnly session
    // owns that choice; the page declaration detects another tab switching it.
    if (declared !== (user?.id || "guest")) throw httpError("登录账户已变化，请刷新页面后继续；当前草稿仍保留在原账户中。", user ? 409 : 401, "account-changed");
  }

  return http.createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "same-origin");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("cross-origin-resource-policy", "same-origin");
    let reservation = null, userStore = null;
    try {
      const url = new URL(req.url, "http://localhost");
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw httpError("无效路径。", 400, "bad-request"); }
      if (pathname.includes("\\") || pathname.includes("\0")) throw httpError("无效路径。", 400, "bad-request");
      const user = auth.session(req)?.user || null;
      if (pathname === "/api/account" && req.method === "GET") {
        assertPageOwner(req, user, false);
        return sendJson(res, 200, { mode: "public", authenticated: Boolean(user), login: auth.login(), user, usage: user ? tenant(user).usage.summary() : null });
      }
      if (pathname === "/auth/github" && req.method === "GET") { loginRate(req); return auth.begin(req, res, url); }
      if (pathname === "/auth/github/callback" && req.method === "GET") return await auth.callback(req, res, url);
      if (pathname === "/auth/logout" && req.method === "POST") { assertPageOwner(req, user); auth.logout(req, res); return sendJson(res, 200, { ok: true }); }
      if (pathname === "/api/status" && req.method === "GET") {
        return sendJson(res, 200, { app: "vibe-shelf", mode: "public", loginConfigured: config.configured, model: { configured: Boolean(modelClient.getStatus?.().configured) } });
      }
      if (pathname === "/api/examples" && req.method === "GET") return sendJson(res, 200, { projects: examples() });
      const examplePreview = pathname.match(/^\/api\/examples\/([a-z0-9-]+)\/preview$/);
      if (examplePreview && req.method === "GET") {
        const id = examplePreview[1], item = example(id);
        return sendJson(res, 200, { projectId: id, title: item.title, readingUrl: item.readingUrl, ready: true, status: "ready", generationStatus: "ready",
          isExample: true, bookCount: 1, books: [], styleFingerprint: item.styleFingerprint, previewStatus: "ready", ...item.preview });
      }
      const examplePage = pathname.match(/^\/examples\/([a-z0-9-]+)\/books\/main\/(?:index\.html)?$/);
      if (examplePage && req.method === "GET") {
        const item = example(examplePage[1]);
        return sendPage(res, renderPublicBook({ html: item.html, book: { projectId: examplePage[1], id: "main", title: item.title }, userId: user?.id || "guest", readOnly: true }));
      }
      if ((pathname === "/" || pathname === "/index.html") && req.method === "GET") {
        return sendPage(res, renderPublicIndex(readRegular(publicDir, "index.html").toString("utf8"), user?.id || "guest"));
      }
      if (/^\/[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(?:js|css|png|svg|webp|ico|woff2)$/.test(pathname) && req.method === "GET") {
        const bytes = readRegular(publicDir, pathname.slice(1));
        res.writeHead(200, { "content-type": MIME[path.extname(pathname)] }); return res.end(bytes);
      }
      if (!user) {
        if (pathname.startsWith("/api/")) assertPageOwner(req, null, false);
        if (pathname === "/api/projects" && req.method === "GET") return sendJson(res, 200, { projects: examples() });
        throw httpError("请先使用 GitHub 登录，再创建和查看自己的项目。", 401, "login-required");
      }
      userStore = tenant(user);
      const privatePage = pathname.match(/^\/projects\/([a-z0-9-]+)\/books\/([a-z0-9-]+)\/(?:index\.html)?$/);
      if (privatePage && req.method === "GET") {
        // Browser navigation starts a fresh account context. A fetch/prefetch
        // from an already open page also declares its owner and must match.
        assertPageOwner(req, user, false);
        const [, projectId, bookId] = privatePage;
        const metadata = readJson(path.join(userStore.dataDir, "projects", projectId, "books", bookId, "book.json"), null);
        if (!metadata) throw httpError("读本不存在。", 404, "not-found");
        const html = readRegular(userStore.publicDir, `projects/${projectId}/books/${bookId}/index.html`).toString("utf8");
        return sendPage(res, renderPublicBook({ html, book: metadata, userId: user.id }));
      }
      // No generated filesystem paths reach the generic static server. Only the
      // authenticated user's API is delegated into that user's private roots.
      if (!pathname.startsWith("/api/")) throw httpError("内容不存在。", 404, "not-found");
      assertPageOwner(req, user);
      if (pathname === "/api/model/check") throw httpError("此接口仅用于本地配置。", 404, "not-found");
      if (!["GET", "HEAD"].includes(req.method)) auth.assertOrigin(req);
      if (/\/exploration-suggestions$/.test(pathname)) {
        // This legacy GET spends model quota; reject cross-origin subresource use.
        if (req.headers["sec-fetch-site"] !== "same-origin" && req.headers.origin !== config.origin) throw httpError("请从本站发起探索。", 403, "origin-mismatch");
      }
      userStore.usage.reconcile();
      let delegated = req;
      const isImport = req.method === "POST" && ["/api/projects/import", "/api/projects/import-github"].includes(pathname);
      const generation = req.method === "POST" && pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/generation$/);
      if (isImport || generation) {
        const input = await readJsonBody(req);
        if (isImport && input.mainBook) throw httpError("公开服务只接受项目源码，请通过生成获得读本。", 400, "generated-book-required");
        const projectId = assertId(generation ? generation[1] : (input.projectId || "p-" + crypto.randomUUID().replaceAll("-", "").slice(0, 20)));
        if (isImport) input.projectId = projectId;
        const existing = readJson(path.join(userStore.dataDir, "projects", projectId, "project.json"), null);
        if (generation && !existing) throw httpError("项目不存在。", 404, "not-found");
        if (generation || !existing) reservation = userStore.usage.reserve(projectId);
        delegated = bodyRequest(req, input);
      }
      if (reservation) {
        const id = reservation;
        res.once("finish", () => {
          // A transient ledger write failure must not crash the HTTP process.
          // The persisted reservation is reconciled on the next account/request.
          try {
            if (res.statusCode >= 400) userStore.usage.release(id);
            else userStore.usage.reconcile();
          } catch {}
        });
      }
      await userStore.handler(delegated, res);
      // An aborted client can suppress the response's finish event. The request
      // still completes server-side, so release failed imports here as well.
      if (reservation) {
        if (res.statusCode >= 400) userStore.usage.release(reservation);
        else userStore.usage.reconcile();
      }
    } catch (error) {
      if (reservation && userStore) userStore.usage.release(reservation);
      if (!res.headersSent) sendJson(res, error.statusCode || 500, { error: { kind: error.kind || "server", message: error.statusCode ? error.message : "服务暂时不可用，请稍后重试。" } });
      else if (!res.writableEnded) res.end();
    }
  });
}
