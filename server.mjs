// 知识书架 · 本地小服务
// 零依赖：只用一个 Node 内置 http 服务 + 静态文件 + MiniMax 代理 + 旁注落盘
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const PORT = Number(process.env.PORT || 8899);

// ---- 读模型配置（.env，key 只存在于本文件运行时，不进前端） ----
function loadEnv() {
  const envFile = path.join(__dirname, ".env");
  if (!fs.existsSync(envFile)) return {};
  const out = {};
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}
function loadModel() {
  const env = { ...loadEnv(), ...process.env };
  const { SHELF_API_URL, SHELF_API_KEY, SHELF_MODEL } = env;
  if (!SHELF_API_URL || !SHELF_API_KEY || !SHELF_MODEL) {
    throw new Error("模型未配置：复制 .env.example 为 .env，填入 SHELF_API_URL / SHELF_API_KEY / SHELF_MODEL（任何 OpenAI 兼容接口）");
  }
  return { url: SHELF_API_URL, apiKey: SHELF_API_KEY, model: SHELF_MODEL };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff2": "font/woff2",
};

function notesFile(book) {
  const safe = /^[\w-]+$/.test(book) ? book : "book";
  return path.join(DATA_DIR, safe + ".json");
}
function readNotes(book) {
  const f = notesFile(book);
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return []; }
}
function writeNotes(book, arr) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(notesFile(book), JSON.stringify(arr, null, 2), "utf8");
}

// ---- 剥掉推理模型的 <think> 块（兜底） ----
function stripThinking(text) {
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/<think(?:ing)?>[\s\S]*$/i, "")
    .trim();
}

// ---- 重试（Clash TUN 下偶发 ECONNRESET，约 1/8 概率） ----
const RETRYABLE = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH",
  "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);
function errCode(err) {
  const e = err;
  return typeof e?.code === "string" ? e.code
    : typeof e?.cause?.code === "string" ? e.cause.code : undefined;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchWithRetry(url, init, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (i < attempts && (res.status >= 500 || res.status === 429)) {
        await res.text().catch(() => {});
        await sleep(500 * 3 ** (i - 1));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (i < attempts && RETRYABLE.has(errCode(err))) {
        console.warn("[retry] 第 " + i + " 次失败(" + errCode(err) + ")，重试…");
        await sleep(500 * 3 ** (i - 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ---- 拼旁注生成 prompt ----
function buildPrompt(input) {
  const q = input.question || "这句话我没看懂";
  const quote = input.quote || "";
  const section = input.sectionTitle || "";
  const block = (input.blockText || "").slice(0, 1200);
  const quotedBlock = quote ? block.replace(quote, "「" + quote + "」") : block;
  return [
    "你是一位耐心、通俗的技术老师。读者在读一本前端教学书，选中了其中一句，并写下他不理解的地方。请写一段「旁注」——贴在这句话旁边、帮他彻底搞懂的补充说明。",
    "",
    "要求：",
    "- 用通俗直白的中文，像当面给他讲一样，不要端着",
    "- 讲清楚「为什么」，而不只是「是什么」；可以举小例子、打比方",
    "- 可以适度用 Markdown：小标题(###)、列表、极短的代码块、表格，但要克制，别堆砌",
    "- 只围绕他问的这个点讲，别跑题、别写成一篇大文章；150～400 字左右",
    "- 讲准确，绝对不要编造事实",
    "- 比喻要贴切；宁可平实准确，也不要为了生动用牵强或错误的比喻",
    "- 直接输出旁注正文，不要任何前言、不要「好的」「以下是」，不要用代码块把整篇包起来",
    "",
    "当前章节：" + (section || "（未知）"),
    "他读到的那段（选中句已用「」标出）：",
    quotedBlock || "（无）",
    "",
    "读者圈出的句子：「" + (quote || "整段") + "」",
    "读者的疑问：「" + q + "」",
    "",
    "直接写旁注正文：",
  ].join("\n");
}

// ---- 拼「旁注局部修改 / 追加」prompt ----
function buildFollowupPrompt(input) {
  const mode = input.mode === "append" ? "append" : "edit";
  const instruction = input.instruction || "";
  const selection = input.selection || "";
  const context = input.context || "";
  const quote = input.quote || "";
  const section = input.sectionTitle || "";
  const q = input.question || "";
  const lines = [
    "你是一位耐心、通俗的技术老师。你已经给读者写过一段「旁注」，现在读者想对这段旁注做一次局部改动。请直接输出改动后的完整旁注正文。",
    "",
  ];
  if (mode === "append") {
    lines.push("任务：在旁注【末尾】追加一段内容。", "读者的追加要求：「" + instruction + "」");
  } else {
    lines.push(
      "任务：读者选中了旁注里的一段话，想针对它做局部展开或修正。",
      "读者选中的那段：「" + selection + "」",
      "读者的要求：「" + instruction + "」"
    );
  }
  lines.push(
    "",
    "要求：",
    "- 保持原有口吻与结构，只做读者要求的局部改动，其余部分尽量原样保留",
    "- 继续用通俗直白的中文，可以举小例子、打比方",
    "- 可以用 Markdown（小标题、列表、极短代码块、表格），但要克制",
    "- 讲准确，绝对不要编造事实",
    "- 直接输出改动后的完整旁注正文，不要任何前言、不要「好的」「以下是」，不要用代码块把整篇包起来",
    "",
    "当前章节：" + (section || "（未知）"),
    "读者原始的疑问：" + (q || "（无）"),
    "被圈出的句子：「" + (quote || "整段") + "」",
    "",
    "现有旁注正文：",
    context,
    "",
    "改动后的完整旁注正文：",
  );
  return lines.join("\n");
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const p = decodeURIComponent(u.pathname);
  const send = (code, obj) => {
    const s = typeof obj === "string" ? obj : JSON.stringify(obj);
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(s);
  };

  try {
    // ---- API ----
    if (p === "/api/explain" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const model = loadModel();
      const payload = {
        model: model.model,
        messages: [{ role: "user", content: buildPrompt(input) }],
        max_tokens: 4000,
        temperature: 0.6,
        reasoning_split: true,
        stream: false,
      };
      const up = await fetchWithRetry(model.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + model.apiKey },
        body: JSON.stringify(payload),
      });
      const text = await up.text();
      if (up.status !== 200) return send(502, { error: { kind: "server", message: "上游 " + up.status, detail: text.slice(0, 300) } });
      let data;
      try { data = JSON.parse(text); } catch { return send(502, { error: { kind: "bad-response", message: "上游返回不是 JSON" } }); }
      let content = data?.choices?.[0]?.message?.content || "";
      content = stripThinking(content);
      const finishReason = data?.choices?.[0]?.finish_reason;
      if (!content) {
        return send(502, {
          error: {
            kind: "bad-response",
            message: finishReason === "length" ? "模型思考过长，答案被截断了，再点一次试试" : "模型没有返回内容",
          },
        });
      }
      return send(200, { content });
    }

    if (p === "/api/followup" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const model = loadModel();
      const payload = {
        model: model.model,
        messages: [{ role: "user", content: buildFollowupPrompt(input) }],
        max_tokens: 4000,
        temperature: 0.6,
        reasoning_split: true,
        stream: false,
      };
      const up = await fetchWithRetry(model.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + model.apiKey },
        body: JSON.stringify(payload),
      });
      const text = await up.text();
      if (up.status !== 200) return send(502, { error: { kind: "server", message: "上游 " + up.status, detail: text.slice(0, 300) } });
      let data;
      try { data = JSON.parse(text); } catch { return send(502, { error: { kind: "bad-response", message: "上游返回不是 JSON" } }); }
      let content = data?.choices?.[0]?.message?.content || "";
      content = stripThinking(content);
      const finishReason = data?.choices?.[0]?.finish_reason;
      if (!content) {
        return send(502, {
          error: {
            kind: "bad-response",
            message: finishReason === "length" ? "模型思考过长，答案被截断了，再点一次试试" : "模型没有返回内容",
          },
        });
      }
      return send(200, { content });
    }

    if (p === "/api/notes" && req.method === "GET") {
      return send(200, readNotes(u.searchParams.get("book") || "pupkit"));
    }

    if (p === "/api/notes" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const { book, note } = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (!note || !note.id) return send(400, { error: { kind: "bad-request", message: "缺少 note.id" } });
      const arr = readNotes(book);
      const i = arr.findIndex((n) => n.id === note.id);
      if (i >= 0) arr[i] = note; else arr.push(note);
      writeNotes(book, arr);
      return send(200, { ok: true, notes: arr });
    }

    if (p === "/api/notes" && req.method === "DELETE") {
      const book = u.searchParams.get("book") || "pupkit";
      const id = u.searchParams.get("id");
      const arr = readNotes(book).filter((n) => n.id !== id);
      writeNotes(book, arr);
      return send(200, { ok: true, notes: arr });
    }

    // ---- 静态文件 ----
    let fp = p === "/" ? "/index.html" : p;
    const file = path.normalize(path.join(PUBLIC_DIR, fp));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("404");
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    return res.end(fs.readFileSync(file));
  } catch (err) {
    console.error("[error]", err);
    return send(500, { error: { kind: "server", message: err?.message || String(err) } });
  }
});

server.listen(PORT, () => {
  console.log("知识书架已启动： http://localhost:" + PORT);
  console.log("书：pupkit · 旁注目录：" + DATA_DIR);
});
