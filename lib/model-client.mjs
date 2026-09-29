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
  if (envCache && envCache.file === file && envCache.mtimeMs === stat.mtimeMs) return envCache.values;
  const values = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    values[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  envCache = { file, mtimeMs: stat.mtimeMs, values };
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

// 这些错误会进入 API 响应和生成/探索记录。上游正文及底层异常可能包含
// Authorization、带凭据的 URL 或代理诊断，不能把它们当成公开提示。
function upstreamStatusMessage(status) {
  const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  const prefix = safeStatus ? `模型服务返回 ${safeStatus}：` : "模型服务请求失败：";
  if (safeStatus === 401) return prefix + "身份验证失败，请检查 .env 中的 API Key 是否正确、有效。";
  if (safeStatus === 403) return prefix + "当前凭据没有访问权限，请检查 API Key 的模型权限。";
  if (safeStatus === 404) return prefix + "未找到接口或模型，请检查 API 地址和模型名称。";
  if (safeStatus === 413) return prefix + "请求内容过大，请减少输入内容，或使用支持更长上下文的模型。";
  if (safeStatus === 429) return prefix + "请求过于频繁或额度不足，请稍后重试，并检查服务额度。";
  if (safeStatus !== null && safeStatus >= 500) return prefix + "服务暂时不可用，请稍后重试。";
  return prefix + "接口未接受请求，请检查模型和接口配置后重试。";
}

export function createConfiguredModelClient({ root, environment = process.env, fetchImpl = globalThis.fetch }) {
  function configuration() {
    return { ...loadEnvFile(root), ...environment };
  }
  return {
    getStatus() {
      const env = configuration();
      let url = null;
      try {
        const parsed = new URL(env.SHELF_API_URL);
        if (["https:", "http:"].includes(parsed.protocol)) url = parsed.origin;
      } catch {}
      const secret = String(env.SHELF_API_KEY || "");
      const model = String(env.SHELF_MODEL || "");
      return {
        configured: Boolean(url && secret && model),
        model: secret ? model.split(secret).join("[hidden]") : model || null,
        url: secret && url ? url.split(secret).join("[hidden]") : url,
      };
    },
    async complete({ prompt, maxTokens = 4000, temperature = 0.6, timeoutMs = REQUEST_TIMEOUT_MS }) {
      const env = configuration();
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
        throw httpError("模型连接失败，请检查网络、代理和 API 地址后重试。", 502, "upstream");
      }

      let text;
      try {
        text = await response.text();
      } catch {
        throw httpError("模型响应读取中断，请稍后重试。", 502, "upstream");
      }
      if (response.status !== 200) {
        throw httpError(upstreamStatusMessage(response.status), 502, "upstream");
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
