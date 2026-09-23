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

function loadEnvFile(root) {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return {};
  const values = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    values[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
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
    async complete({ prompt, maxTokens = 4000, temperature = 0.6 }) {
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
            reasoning_split: true,
            stream: false,
          }),
        });
      } catch (error) {
        throw httpError(`模型请求失败：${error?.message || String(error)}`, 502, "upstream");
      }

      const text = await response.text();
      if (response.status !== 200) {
        throw httpError(`上游 ${response.status}: ${text.slice(0, 300)}`, 502, "upstream");
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw httpError("上游返回不是 JSON", 502, "bad-response");
      }
      const content = stripThinking(data?.choices?.[0]?.message?.content || "");
      if (!content) {
        const finishReason = data?.choices?.[0]?.finish_reason;
        throw httpError(
          finishReason === "length" ? "模型思考过长，答案被截断了，再点一次试试" : "模型没有返回内容",
          502,
          "bad-response",
        );
      }
      return content;
    },
  };
}
