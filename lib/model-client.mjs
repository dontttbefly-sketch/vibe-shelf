import fs from "node:fs";
import path from "node:path";
import { httpError } from "./http.mjs";

const RETRYABLE = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH",
  "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);

function errorCode(error) {
  return typeof error?.code === "string"
    ? error.code
    : typeof error?.cause?.code === "string"
      ? error.cause.code
      : undefined;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function stripThinking(text) {
  return String(text)
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/<think(?:ing)?>[\s\S]*$/i, "")
    .trim();
}

// 交互式请求（划词解释/追问/搜索）要快速失败：卡两分钟用户已经走了。
// 主书生成是另一回事——几万字的输出本身就是分钟级的，调用方传自己的 timeoutMs。
const REQUEST_TIMEOUT_MS = 120_000;

// reasoning_split 是 MiniMax 的专有参数（把思维链拆到 reasoning_content）。
// 对 OpenAI / DeepSeek 之类的严格端点，未知顶层参数可能直接 400，
// 而 README 又承诺"任何 OpenAI 兼容接口"——所以默认只对 MiniMax 发。
// 走代理、域名里没有 minimax 的，用 SHELF_REASONING_SPLIT=1/0 显式覆盖。
function wantsReasoningSplit(url, environment) {
  const flag = String(environment.SHELF_REASONING_SPLIT || "").trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(flag)) return true;
  if (["0", "false", "off", "no"].includes(flag)) return false;
  return /minimax/i.test(String(url));
}

// 按 mtime 缓存：complete() 每次调用都重读一遍 .env 是纯浪费，
// 但缓存又要让"改完 .env 不用重启"继续成立。
let envCache = null;

function loadEnvFile(root) {
  const file = path.join(root, ".env");
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    envCache = null;
    return {};
  }
  if (envCache && envCache.mtimeMs === stat.mtimeMs) return envCache.values;
  const values = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    values[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  envCache = { mtimeMs: stat.mtimeMs, values };
  return values;
}

async function fetchWithRetry(fetchImpl, url, init, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, init);
      if (attempt < attempts && (response.status >= 500 || response.status === 429)) {
        await response.text().catch(() => {});
        await sleep(500 * 3 ** (attempt - 1));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts && RETRYABLE.has(errorCode(error))) {
        await sleep(500 * 3 ** (attempt - 1));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export function createConfiguredModelClient({ root, environment = process.env, fetchImpl = globalThis.fetch }) {
  return {
    async complete({ prompt, maxTokens = 4000, temperature = 0.6, timeoutMs = REQUEST_TIMEOUT_MS }) {
      const env = { ...loadEnvFile(root), ...environment };
      const { SHELF_API_URL: url, SHELF_API_KEY: apiKey, SHELF_MODEL: model } = env;
      if (!url || !apiKey || !model) {
        throw httpError(
          "模型未配置：复制 .env.example 为 .env，填入 SHELF_API_URL / SHELF_API_KEY / SHELF_MODEL（任何 OpenAI 兼容接口）",
          503,
          "model-unavailable",
        );
      }

      let response;
      try {
        response = await fetchWithRetry(fetchImpl, url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: maxTokens,
            temperature,
            ...(wantsReasoningSplit(url, environment) ? { reasoning_split: true } : {}),
            stream: false,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timedOut = error?.name === "TimeoutError" || error?.cause?.name === "TimeoutError";
        if (timedOut) {
          throw httpError(
            `模型 ${Math.round(timeoutMs / 1000)} 秒没有响应，已中断；稍后重试或换一个更快的模型`,
            504,
            "upstream-timeout",
          );
        }
        throw httpError(`模型请求失败：${error?.message || String(error)}`, 502, "upstream");
      }

      let text;
      try {
        text = await response.text();
      } catch (error) {
        throw httpError(`模型响应读取中断：${error?.message || String(error)}`, 502, "upstream");
      }
      if (response.status !== 200) {
        throw httpError(`上游 ${response.status}: ${text.slice(0, 300)}`, 502, "upstream");
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw httpError("上游返回不是 JSON", 502, "bad-response");
      }
      const choice = data?.choices?.[0];
      // 被长度上限截断的输出是"看起来正常"的坏数据：主书会缺尾（后面编译时报"定位 body 失败"，
      // 完全看不出真实原因），旁注会半句而止。宁可明确失败，也不要静默交付半截内容。
      if (choice?.finish_reason === "length") {
        throw httpError(
          "模型输出达到长度上限被截断了，内容不完整；再点一次重试，或换一个输出上限更大的模型",
          502,
          "truncated",
        );
      }
      const content = stripThinking(choice?.message?.content || "");
      if (!content) throw httpError("模型没有返回内容", 502, "bad-response");
      return content;
    },
  };
}
