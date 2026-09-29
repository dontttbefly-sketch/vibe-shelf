import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { watchGeneration } = createRequire(import.meta.url)("../public/reader-session.js");
const FLOW_KEY = "shelf-import-flow";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response(status, generationId) { return { ok: true, json: async () => ({ generation: { status, ...(generationId ? { generationId } : {}) } }) }; }
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function fixture({ failStorage = false, generationId } = {}) {
  let now = 0, nextTimer = 0;
  const timers = new Map(), listeners = new Map(), requests = [], notices = [], writes = [];
  const stored = new Map([[FLOW_KEY, JSON.stringify({ projectId: "project-a", name: "Project A", status: "generating", readingIntent: "overview", ...(generationId ? { generationId } : {}) })]]);
  const win = {
    AbortController, scrollY: 735, location: { href: "https://shelf.test/projects/reading/books/main/#chapter-3" },
    scrollTo() { throw Error("completion must not change the current reading position"); },
    localStorage: {
      getItem: key => stored.get(key) || null,
      setItem(key, value) { if (failStorage) throw Error("storage unavailable"); writes.push({ key, value }); stored.set(key, value); },
    },
    fetch(url, options) { const pending = deferred(); requests.push({ url: String(url), signal: options.signal, pending }); return pending.promise; },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
  };
  function dispatch(name, data = {}) { for (const fn of listeners.get(name) || []) fn(data); }
  async function advance(duration) {
    const end = now + duration;
    for (;;) {
      const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      now = entry[1].at; timers.delete(entry[0]); entry[1].fn(); await flush();
    }
    now = end; await flush();
  }
  const watcher = watchGeneration(win, "https://shelf.test/", (flow, status) => notices.push({ projectId: flow.projectId, status }));
  return { win, stored, requests, notices, writes, watcher, dispatch, advance, timers };
}

test("an old book completion cannot overwrite a newer import started in another tab", async () => {
  const h = fixture(); await h.advance(2000);
  const newer = { projectId: "project-b", name: "Project B", status: "generating", readingIntent: "handoff" };
  h.stored.set(FLOW_KEY, JSON.stringify(newer));
  h.requests[0].pending.resolve(response("ready")); await flush();
  assert.deepEqual(JSON.parse(h.stored.get(FLOW_KEY)), newer);
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.notices, [{ projectId: "project-a", status: "ready" }]);
  assert.equal(h.win.scrollY, 735);
  assert.equal(h.win.location.href, "https://shelf.test/projects/reading/books/main/#chapter-3");
  await h.advance(30000); assert.equal(h.requests.length, 1);
  h.watcher.destroy();
});

test("a matching generating task merges the latest fields, and settled tasks are never overwritten", async () => {
  const h = fixture(); await h.advance(2000);
  h.stored.set(FLOW_KEY, JSON.stringify({ projectId: "project-a", name: "Renamed A", status: "generating", readingIntent: "core", custom: "keep" }));
  h.requests[0].pending.resolve(response("failed")); await flush();
  assert.deepEqual(JSON.parse(h.stored.get(FLOW_KEY)), { projectId: "project-a", name: "Renamed A", status: "failed", readingIntent: "core", custom: "keep" });
  h.watcher.destroy();
  const settled = fixture(); await settled.advance(2000);
  settled.stored.set(FLOW_KEY, JSON.stringify({ projectId: "project-a", status: "ready" }));
  settled.requests[0].pending.resolve(response("failed")); await flush();
  assert.equal(JSON.parse(settled.stored.get(FLOW_KEY)).status, "ready");
  assert.equal(settled.writes.length, 0);
  settled.watcher.destroy();
});

test("late completion from an earlier generation never overwrites or announces the newer job on the same project", async () => {
  const h = fixture({ generationId: "job-old" }); await h.advance(2000);
  const newer = { projectId: "project-a", name: "Project A", status: "generating", generationId: "job-new" };
  h.stored.set(FLOW_KEY, JSON.stringify(newer));
  h.requests[0].pending.resolve(response("ready", "job-old")); await flush();
  assert.deepEqual(JSON.parse(h.stored.get(FLOW_KEY)), newer);
  assert.equal(h.writes.length, 0); assert.deepEqual(h.notices, []);
  await h.advance(30000); assert.equal(h.requests.length, 1);
  h.watcher.destroy();
});

test("response generation identity must match the watched task, with legacy support only when both lack IDs", async () => {
  for (const [savedId, responseId] of [["job-old", "job-new"], ["job-old", undefined], [undefined, "job-new"]]) {
    const h = fixture({ generationId: savedId }); await h.advance(2000);
    h.requests[0].pending.resolve(response("ready", responseId)); await flush();
    assert.deepEqual(h.notices, []); assert.equal(h.writes.length, 0);
    assert.equal(JSON.parse(h.stored.get(FLOW_KEY)).status, "generating");
    await h.advance(30000); assert.equal(h.requests.length, 1);
    h.watcher.destroy();
  }
  const matching = fixture({ generationId: "job-current" }); await matching.advance(2000);
  matching.requests[0].pending.resolve(response("ready", "job-current")); await flush();
  assert.equal(JSON.parse(matching.stored.get(FLOW_KEY)).status, "ready");
  assert.equal(JSON.parse(matching.stored.get(FLOW_KEY)).generationId, "job-current");
  assert.equal(matching.notices.length, 1);
  matching.watcher.destroy();
});

test("pagehide cancels an in-flight request and rejects its late result; pageshow resumes exactly once", async () => {
  const h = fixture(); await h.advance(2000);
  assert.equal(h.requests.length, 1);
  h.dispatch("pagehide", { persisted: true });
  assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(h.timers.size, 0);
  h.requests[0].pending.resolve(response("ready")); await flush();
  assert.deepEqual(h.notices, []); assert.equal(h.writes.length, 0);
  await h.advance(20000); assert.equal(h.requests.length, 1);
  h.dispatch("pageshow", { persisted: true });
  h.dispatch("pageshow", { persisted: true });
  await h.advance(0); assert.equal(h.requests.length, 2);
  h.requests[1].pending.resolve(response("ready")); await flush();
  assert.deepEqual(h.notices, [{ projectId: "project-a", status: "ready" }]);
  assert.equal(JSON.parse(h.stored.get(FLOW_KEY)).status, "ready");
  h.watcher.destroy();
});

test("pagehide while response JSON is pending also invalidates completion and can survive repeated back/forward", async () => {
  const h = fixture(); await h.advance(2000);
  const body = deferred();
  h.requests[0].pending.resolve({ ok: true, json: () => body.promise }); await flush();
  h.dispatch("pagehide"); body.resolve({ generation: { status: "ready" } }); await flush();
  assert.deepEqual(h.notices, []);
  h.dispatch("pageshow", { persisted: true }); await h.advance(0);
  h.dispatch("pagehide"); assert.equal(h.requests[1].signal.aborted, true);
  h.requests[1].pending.reject(new DOMException("aborted", "AbortError")); await flush();
  h.dispatch("pageshow", { persisted: true }); await h.advance(0);
  h.requests[2].pending.resolve(response("failed")); await flush();
  assert.deepEqual(h.notices, [{ projectId: "project-a", status: "failed" }]);
  h.watcher.destroy();
});

test("an initial scheduled check is paused before navigation and restarted on bfcache return", async () => {
  const h = fixture(); await h.advance(1000);
  h.dispatch("pagehide"); await h.advance(20000);
  assert.equal(h.requests.length, 0);
  h.dispatch("pageshow", { persisted: true }); await h.advance(0);
  assert.equal(h.requests.length, 1);
  h.watcher.destroy();
  assert.equal(h.requests[0].signal.aborted, true);
  h.dispatch("pageshow", { persisted: true }); await h.advance(30000);
  assert.equal(h.requests.length, 1);
});

test("a timeout aborts the request, retries after 5 seconds and ignores a late old result", async () => {
  const h = fixture(); await h.advance(2000);
  await h.advance(9999); assert.equal(h.requests[0].signal.aborted, false);
  await h.advance(1); assert.equal(h.requests[0].signal.aborted, true);
  await h.advance(4999); assert.equal(h.requests.length, 1);
  await h.advance(1); assert.equal(h.requests.length, 2);
  h.requests[0].pending.resolve(response("ready")); await flush();
  assert.deepEqual(h.notices, []); assert.equal(h.writes.length, 0);
  assert.equal(h.requests[1].signal.aborted, false);
  h.requests[1].pending.resolve(response("ready")); await flush();
  assert.deepEqual(h.notices, [{ projectId: "project-a", status: "ready" }]);
  await h.advance(30000); assert.equal(h.requests.length, 2);
  h.watcher.destroy();
});

test("storage failure never turns a completed task into repeated notifications", async () => {
  const h = fixture({ failStorage: true }); await h.advance(2000);
  h.requests[0].pending.resolve(response("ready")); await flush();
  assert.equal(h.notices.length, 1);
  h.dispatch("pagehide"); h.dispatch("pageshow", { persisted: true });
  await h.advance(30000);
  assert.equal(h.notices.length, 1); assert.equal(h.requests.length, 1);
  h.watcher.destroy();
});

test("failed status requests leave the task intact and recover without touching reader position", async () => {
  const h = fixture(); await h.advance(2000);
  h.requests[0].pending.reject(Error("offline")); await flush();
  assert.equal(JSON.parse(h.stored.get(FLOW_KEY)).status, "generating");
  await h.advance(5000); assert.equal(h.requests.length, 2);
  h.requests[1].pending.resolve(response("generating")); await flush();
  await h.advance(5000); assert.equal(h.requests.length, 3);
  h.requests[2].pending.resolve(response("ready")); await flush();
  assert.equal(h.notices.length, 1); assert.equal(h.win.scrollY, 735);
  h.watcher.destroy();
});
