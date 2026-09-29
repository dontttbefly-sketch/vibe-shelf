// github-import.mjs — 从公开 GitHub 仓库拉取文本文件，喂给 importLocalProject。
// 与本地导入共用 IMPORT_LIMITS（300 个 / 单文件 100KB / 总量 8MB），
// 只挑文本扩展名，二进制（图片/字体/压缩包）直接跳过不下载。

import { IMPORT_LIMITS } from "./imports.mjs";

const GITHUB_API = "https://api.github.com";
const RAW_BASE = "https://raw.githubusercontent.com";
const TEXT_EXTENSIONS = new Set([
  "astro", "c", "cc", "cfg", "clj", "coffee", "cpp", "cs", "css", "csv", "dart", "dockerfile",
  "env", "ex", "exs", "go", "gradle", "groovy", "h", "hpp", "htm", "html", "http", "ini", "ipynb",
  "java", "js", "json", "jsonc", "jsx", "kt", "less", "lock", "log", "lua", "makefile", "md",
  "mdx", "mjs", "php", "pl", "properties", "proto", "py", "r", "rb", "rs", "rst", "sass", "scala",
  "scss", "sh", "sol", "sql", "svg", "swift", "svelte", "toml", "ts", "tsx", "txt", "vue", "xml",
  "yaml", "yml", "zig",
]);
const SKIP_EXTENSIONS = new Set([
  "7z", "avi", "bin", "bmp", "deb", "dmg", "eot", "exe", "gif", "gz", "ico", "jpeg", "jpg",
  "jar", "mp3", "mp4", "otf", "pdf", "png", "psd", "rar", "ttf", "wav", "webm", "webp", "woff",
  "woff2", "zip",
]);
const SKIP_DIRS = [".git/", "node_modules/", "dist/", "build/", ".next/", "vendor/", "__pycache__/"];

// "owner/name"、"github.com/owner/name"、"https://github.com/owner/name(.git)" → "owner/name"
export function parseGithubRepo(input) {
  const trimmed = String(input || "").trim().replace(/\.git$/, "");
  const match = trimmed.match(/github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/) ||
    trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) throw new Error("invalid github repo (use owner/name)");
  return `${match[1]}/${match[2]}`;
}

function extOf(path) {
  const base = path.split("/").pop();
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return base.toLowerCase(); // Dockerfile / Makefile 无后缀
  return base.slice(dot + 1).toLowerCase();
}

function isWanted(path) {
  if (SKIP_DIRS.some((d) => path.includes(d))) return false;
  const ext = extOf(path);
  if (SKIP_EXTENSIONS.has(ext)) return false;
  return TEXT_EXTENSIONS.has(ext);
}

// 重试三次也是同样结果的错误（404、配额已尽的 403）直接抛，别再烧配额
function fatal(message) {
  const error = new Error(message);
  error.fatal = true;
  return error;
}

async function githubFetch(url, token, tries = 3) {
  let lastError;
  for (let i = 0; i < tries; i++) {
    try {
      const headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "vibe-shelf-importer",
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
        throw fatal("github api 限流了（未登录每小时 60 次）；可在 .env 配 GITHUB_TOKEN");
      }
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw fatal(`github 返回 ${res.status}：${url}`);
      }
      if (!res.ok) throw new Error(`github 返回 ${res.status}：${url}`);
      return res;
    } catch (error) {
      lastError = error;
      if (error.fatal) throw error;
      // 代理抖动偶发 EOF——指数退避重试
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastError;
}

// 逐文件走 /git/blobs 会按"每个文件一次"吃掉 API 限额（未登录只有 60 次/小时），
// 一个几十文件的项目就直接把额度烧干；raw 端点不计入该限额，也不需要 base64 解码。
function rawFileUrl(repo, sourceCommit, filePath) {
  return `${RAW_BASE}/${repo}/${sourceCommit}/${filePath.split("/").map(encodeURIComponent).join("/")}`;
}

function sourceSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error(`GitHub 返回了无效的${label}，无法固定源码版本，请重试导入。`);
  }
  return value.toLowerCase();
}

// 拉取仓库全部想要的文本文件：[{ path, content }]，交给 validateImportFiles 兜底
export async function fetchGithubRepoFiles(repoInput, { token = process.env.GITHUB_TOKEN } = {}) {
  const repo = parseGithubRepo(repoInput);

  // Resolve HEAD once. A tree SHA identifies the directory, not a commit:
  // raw must use the commit SHA, while both requests describe that same snapshot.
  const commitRes = await githubFetch(`${GITHUB_API}/repos/${repo}/commits/HEAD`, token);
  const commit = await commitRes.json();
  const sourceCommit = sourceSha(commit.sha, "提交标识");
  const expectedTreeSha = sourceSha(commit.commit?.tree?.sha, "文件树标识");
  const treeRes = await githubFetch(`${GITHUB_API}/repos/${repo}/git/trees/${expectedTreeSha}?recursive=1`, token);
  const treeData = await treeRes.json();
  const sourceTreeSha = sourceSha(treeData.sha, "文件树标识");
  if (sourceTreeSha !== expectedTreeSha) throw new Error("GitHub 文件树与选定提交不一致，请重试导入。");
  const tree = treeData.tree || [];
  const wanted = tree.filter((entry) => entry.type === "blob" && isWanted(entry.path));
  if (!wanted.length) throw new Error("仓库里没有可导入的文本文件");
  wanted.sort((a, b) => a.path.localeCompare(b.path));

  const files = [];
  let totalBytes = 0;
  // 8 路并发拉原文
  const queue = wanted.slice();
  const workers = Array.from({ length: 8 }, async () => {
    for (;;) {
      const entry = queue.shift();
      if (!entry) return;
      if (entry.size > IMPORT_LIMITS.maxFileBytes) continue; // 大文件跳过，不算失败
      if (files.length >= IMPORT_LIMITS.maxFiles) return;
      const res = await githubFetch(rawFileUrl(repo, sourceCommit, entry.path), token);
      const content = await res.text();
      if (content.includes("\0")) continue; // 名字像文本但内容是二进制
      const bytes = Buffer.byteLength(content);
      if (totalBytes + bytes > IMPORT_LIMITS.maxTotalBytes) continue;
      totalBytes += bytes;
      files.push({ path: entry.path, content });
    }
  });
  await Promise.all(workers);

  if (!files.length) throw new Error("仓库文件都不满足导入条件（过大或非文本）");
  return { repo, files, sourceCommit, sourceTreeSha };
}
