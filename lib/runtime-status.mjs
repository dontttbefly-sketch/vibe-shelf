import fs from "node:fs";
import path from "node:path";
import { httpError } from "./http.mjs";

const version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export function runtimeStatus({ dataDir, modelClient }) {
  return {
    app: "vibe-shelf",
    version,
    dataDir: path.resolve(dataDir),
    model: modelClient?.getStatus?.() || { configured: false, model: null, url: null },
  };
}

export async function checkModel(modelClient) {
  if (!modelClient?.complete) throw httpError("模型尚未配置，请检查本地 .env 配置。", 503, "model-unavailable");
  const startedAt = Date.now();
  try {
    await modelClient.complete({ prompt: "这是知识书架的连通检查。请只回复 OK。", maxTokens: 128, temperature: 0, timeoutMs: 15000 });
    return { ok: true, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    // Upstream bodies and network errors can echo credentials/URLs. Diagnostics
    // expose a useful category, never those raw strings or the model response.
    if (error?.statusCode === 503) throw httpError("模型尚未配置，请检查本地 .env 的接口地址、模型和 Key。", 503, "model-unavailable");
    if (error?.statusCode === 504) throw httpError("模型 15 秒内没有响应，请检查网络或稍后重试。", 504, "upstream-timeout");
    throw httpError("模型连通检查未通过，请检查接口地址、模型、Key 和网络后重试。", 502, "model-check-failed");
  }
}
