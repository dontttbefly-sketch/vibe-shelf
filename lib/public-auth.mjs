import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJson, writeJsonAtomic } from "./json-store.mjs";
import { httpError } from "./http.mjs";

const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const random = () => crypto.randomBytes(32).toString("base64url");
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const SESSION_AGE = 30 * 24 * 60 * 60 * 1000;
const STATE_AGE = 10 * 60 * 1000;

export function publicConfiguration(environment = process.env) {
  let origin = null;
  try {
    const url = new URL(environment.SHELF_PUBLIC_ORIGIN);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
        !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash) origin = url.origin;
  } catch {}
  const clientId = String(environment.GITHUB_CLIENT_ID || "").trim();
  const clientSecret = String(environment.GITHUB_CLIENT_SECRET || "").trim();
  // Optional invite list of numeric GitHub ids. A login name can be renamed and
  // then registered by somebody else; the numeric id cannot. A list with no
  // valid ids admits nobody rather than everybody.
  const invited = String(environment.SHELF_ALLOWED_GITHUB_IDS || "").split(/[\s,]+/).filter(Boolean);
  const allowedIds = invited.length ? new Set(invited.filter(id => /^\d+$/.test(id)).map(id => "github-" + id)) : null;
  return { origin, clientId, clientSecret, allowedIds, configured: Boolean(origin && clientId && clientSecret) };
}

function cookieValue(req, name) {
  const value = String(req.headers.cookie || "").split(";").map(item => item.trim()).find(item => item.startsWith(name + "="));
  return value ? value.slice(name.length + 1) : "";
}

function returnPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\r\n]/.test(value)) return "/#library";
  try {
    const url = new URL(value, "https://shelf.invalid");
    return url.origin === "https://shelf.invalid" ? url.pathname + url.search + url.hash : "/#library";
  } catch { return "/#library"; }
}

export function createPublicAuth({ root, configuration, fetchImpl = globalThis.fetch, now = Date.now }) {
  const config = configuration;
  const secure = config.origin?.startsWith("https:");
  const cookieName = secure ? "__Host-shelf-session" : "shelf-session";
  const stateName = secure ? "__Host-shelf-oauth" : "shelf-oauth";
  for (const directory of [root, path.join(root, "sessions"), path.join(root, "states")]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const storeFile = (kind, token) => path.join(root, kind, digest(token) + ".json");
  const setCookie = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(age / 1000)}${secure ? "; Secure" : ""}`;
  const login = () => ({ configured: config.configured, url: "/auth/github", ...(config.configured ? {} : { reason: "网站尚未配置 GitHub 登录；目前可以阅读案例。" }) });

  function session(req) {
    const token = cookieValue(req, cookieName);
    if (!tokenPattern.test(token)) return null;
    const file = storeFile("sessions", token);
    const record = readJson(file, null);
    if (!record || record.expiresAt <= now() || !/^github-\d+$/.test(record.user?.id || "")) {
      if (record) fs.rmSync(file, { force: true });
      return null;
    }
    // Removing someone from the invite list closes their open sessions too. The
    // file is kept, so adding them back restores the session until it expires.
    if (config.allowedIds && !config.allowedIds.has(record.user.id)) return null;
    return record;
  }

  function assertOrigin(req) {
    if (!config.origin || req.headers.origin !== config.origin || req.headers["sec-fetch-site"] === "cross-site") {
      throw httpError("请从本站页面提交操作。", 403, "origin-mismatch");
    }
  }

  function begin(req, res, url) {
    if (!config.configured) throw httpError(login().reason, 503, "login-unavailable");
    // Expired challenges carry no value and should not accumulate indefinitely.
    for (const entry of fs.readdirSync(path.join(root, "states"))) {
      if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
      const file = path.join(root, "states", entry);
      if (readJson(file, {})?.expiresAt <= now()) fs.rmSync(file, { force: true });
    }
    const state = random(), verifier = random();
    writeJsonAtomic(storeFile("states", state), { verifier, returnTo: returnPath(url.searchParams.get("returnTo")), expiresAt: now() + STATE_AGE });
    const target = new URL("https://github.com/login/oauth/authorize");
    target.search = new URLSearchParams({
      client_id: config.clientId, redirect_uri: config.origin + "/auth/github/callback", scope: "read:user",
      state, code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    }).toString();
    res.writeHead(302, { location: target.href, "set-cookie": setCookie(stateName, state, STATE_AGE) });
    res.end();
  }

  async function callback(req, res, url) {
    if (!config.configured) throw httpError(login().reason, 503, "login-unavailable");
    const state = url.searchParams.get("state") || "", expected = cookieValue(req, stateName);
    if (!tokenPattern.test(state) || !tokenPattern.test(expected) || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expected))) {
      throw httpError("登录验证已失效，请重新登录。", 400, "oauth-state");
    }
    const file = storeFile("states", state), saved = readJson(file, null);
    fs.rmSync(file, { force: true }); // One use, including denied or failed exchanges.
    res.setHeader("set-cookie", setCookie(stateName, "", 0));
    const code = url.searchParams.get("code");
    if (!saved || saved.expiresAt <= now() || !code || code.length > 512 || url.searchParams.has("error")) {
      throw httpError("登录未完成或已过期，请重新登录。", 400, "oauth-state");
    }
    let profile;
    try {
      const tokenResponse = await fetchImpl("https://github.com/login/oauth/access_token", {
        method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code,
          redirect_uri: config.origin + "/auth/github/callback", code_verifier: saved.verifier }),
        signal: AbortSignal.timeout(15000),
      });
      const token = await tokenResponse.json();
      if (!tokenResponse.ok || typeof token.access_token !== "string" || !token.access_token) throw new Error("exchange");
      const userResponse = await fetchImpl("https://api.github.com/user", {
        headers: { authorization: `Bearer ${token.access_token}`, accept: "application/vnd.github+json", "user-agent": "vibe-shelf" },
        signal: AbortSignal.timeout(15000),
      });
      profile = await userResponse.json();
      if (!userResponse.ok || !Number.isSafeInteger(profile.id) || profile.id <= 0 || typeof profile.login !== "string") throw new Error("identity");
    } catch {
      throw httpError("GitHub 登录暂时未完成，请稍后重试。", 502, "oauth-upstream");
    }
    if (config.allowedIds && !config.allowedIds.has("github-" + profile.id)) {
      throw httpError("这个书架目前只对受邀的 GitHub 账号开放。", 403, "not-invited");
    }
    const user = { id: "github-" + profile.id, login: profile.login.slice(0, 100), name: String(profile.name || profile.login).slice(0, 120),
      avatarUrl: `https://avatars.githubusercontent.com/u/${profile.id}?v=4` };
    const token = random();
    writeJsonAtomic(storeFile("sessions", token), { user, createdAt: now(), expiresAt: now() + SESSION_AGE });
    res.writeHead(302, { location: saved.returnTo, "set-cookie": [setCookie(stateName, "", 0), setCookie(cookieName, token, SESSION_AGE)] });
    res.end();
  }

  function logout(req, res) {
    assertOrigin(req);
    const token = cookieValue(req, cookieName);
    if (tokenPattern.test(token)) fs.rmSync(storeFile("sessions", token), { force: true });
    res.setHeader("set-cookie", setCookie(cookieName, "", 0));
  }
  return { session, login, assertOrigin, begin, callback, logout };
}
