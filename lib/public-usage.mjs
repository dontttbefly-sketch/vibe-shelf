import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJson, writeJsonAtomic } from "./json-store.mjs";
import { httpError } from "./http.mjs";

export function positiveLimit(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 && String(value).trim() !== "" ? n : fallback;
}

// Single-process durable ledger. Deployment uses the same exclusive data lock as
// local mode; this is not a distributed reservation service.
export function createPublicUsage({ root, dataDir, publicDir, generationLimit = 3, dailyModelLimit = 100, now = Date.now }) {
  const file = path.join(root, "usage.json");
  const active = new Set();
  let concurrent = 0;
  const read = () => readJson(file, { version: 1, generations: [], modelDays: {} });
  const save = state => writeJsonAtomic(file, state);
  const month = () => new Date(now()).toISOString().slice(0, 7);
  const day = () => new Date(now()).toISOString().slice(0, 10);

  function reconcile() {
    const state = read();
    let changed = false;
    for (const entry of state.generations) {
      if (entry.status !== "reserved") continue;
      const generationFile = path.join(dataDir, "projects", entry.projectId, "generation.json");
      const generation = readJson(generationFile, null);
      const isNew = generation && (generation.generationId && entry.beforeGenerationId !== undefined
        ? generation.generationId !== entry.beforeGenerationId
        : JSON.stringify([generation.startedAt, generation.updatedAt, generation.status]) !== entry.before);
      const page = path.join(publicDir, "projects", entry.projectId, "books", "main", "index.html");
      if (isNew && generation.status === "ready" && generation.bookId === "main" && fs.existsSync(page)) {
        entry.status = "settled"; entry.finishedAt = now(); changed = true; active.delete(entry.id);
      } else if (!active.has(entry.id) || (isNew && generation.status === "failed")) {
        entry.status = "released"; entry.finishedAt = now(); changed = true; active.delete(entry.id);
        if (generation?.status === "generating" && !active.has(entry.id)) {
          writeJsonAtomic(generationFile, { ...generation, status: "failed", stage: null, error: "生成服务已重启，项目资料已保留，可以重试。", updatedAt: now() });
        }
      }
    }
    if (changed) save(state);
    return state;
  }

  function summary() {
    const state = reconcile(), period = month();
    const entries = state.generations.filter(entry => entry.period === period);
    const used = entries.filter(entry => entry.status === "settled").length;
    const reserved = entries.filter(entry => entry.status === "reserved").length;
    const calls = state.modelDays[day()] || 0;
    return { period, generation: { limit: generationLimit, used, reserved, remaining: Math.max(0, generationLimit - used - reserved) },
      model: { period: day(), limit: dailyModelLimit, used: calls, remaining: Math.max(0, dailyModelLimit - calls) } };
  }

  function reserve(projectId) {
    if (summary().generation.remaining < 1) throw httpError("本月生成额度已用完；已有读本仍可继续阅读。", 429, "generation-quota");
    const state = read();
    if (state.generations.some(entry => entry.projectId === projectId && entry.status === "reserved")) throw httpError("这个项目正在生成，请等待完成。", 409, "generation-running");
    const previous = readJson(path.join(dataDir, "projects", projectId, "generation.json"), null);
    const entry = { id: crypto.randomUUID(), projectId, period: month(), status: "reserved", createdAt: now(),
      beforeGenerationId: previous?.generationId || null,
      before: JSON.stringify([previous?.startedAt, previous?.updatedAt, previous?.status]) };
    state.generations.push(entry); save(state); active.add(entry.id);
    return entry.id;
  }
  function release(id) {
    const state = read(), entry = state.generations.find(item => item.id === id);
    if (entry?.status === "reserved") { entry.status = "released"; entry.finishedAt = now(); save(state); }
    active.delete(id);
  }

  function modelClient(client) {
    return {
      getStatus: () => client.getStatus?.() || { configured: true },
      async complete(input) {
        if (concurrent >= 2) throw httpError("当前还有任务在生成，请稍后继续。", 429, "model-concurrency");
        const state = read(), date = day();
        if ((state.modelDays[date] || 0) >= dailyModelLimit) throw httpError("今日 AI 调用次数已达上限，请明天再试。", 429, "model-quota");
        // Counts actual attempts, including failures, to bound upstream spending.
        state.modelDays[date] = (state.modelDays[date] || 0) + 1; save(state); concurrent++;
        try { return await client.complete(input); } finally { concurrent--; }
      },
    };
  }
  reconcile(); // Release reservations owned by a previous process.
  return { summary, reserve, release, reconcile, modelClient };
}
