import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { bookHref, coverPalette, contrast, createPreviewCache, createPreviewSession } = require("../public/shelf-preview.js");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("a late response cannot replace the next book or reopen a closed preview", async () => {
  const a = deferred(), b = deferred(), c = deferred();
  const changes = [];
  const session = createPreviewSession(project => ({ a, b, c })[project.id].promise, event => changes.push(event));
  const first = session.open({ id: "a" });
  const second = session.open({ id: "b" });
  b.resolve({ projectId: "b", title: "Book B" });
  assert.equal((await second).state, "ready");
  a.resolve({ projectId: "a", title: "Book A" });
  assert.equal((await first).state, "stale");
  assert.deepEqual(changes.filter(change => change.state === "ready").map(change => change.data.title), ["Book B"]);
  const third = session.open({ id: "c" });
  session.close();
  c.reject(new Error("late network error"));
  assert.equal((await third).state, "stale");
  assert.equal(changes.at(-1).state, "closed");
});

test("simultaneous requests and repeated visits reuse the same version; updates and expiry reload", async () => {
  let requests = 0, now = 10;
  const pending = deferred();
  const cache = createPreviewCache(async id => { requests++; await pending.promise; return { projectId: id }; }, { now: () => now, ttl: 100 });
  const project = { id: "project-a", updatedAt: 1, bookCount: 1 };
  const first = cache.load(project), second = cache.load(project);
  assert.equal(first, second);
  pending.resolve(); await first;
  await cache.load(project);
  assert.equal(requests, 1);
  await cache.load({ ...project, updatedAt: 2 });
  assert.equal(requests, 2);
  await cache.load({ ...project, bookCount: 2 });
  assert.equal(requests, 3);
  now = 111;
  await cache.load(project);
  assert.equal(requests, 4);
  cache.invalidate("project-a");
  await cache.load(project);
  assert.equal(requests, 5);
});

test("failures and mismatched project payloads are not cached as successful previews", async () => {
  let requests = 0;
  const cache = createPreviewCache(async id => {
    requests++;
    if (requests === 1) throw new Error("network failed");
    return { projectId: requests === 2 ? "other" : id };
  });
  await assert.rejects(cache.load({ id: "project-a" }), /network failed/);
  await assert.rejects(cache.load({ id: "project-a" }), /不一致/);
  assert.equal((await cache.load({ id: "project-a" })).projectId, "project-a");
  assert.equal(requests, 3);
});

test("book links use validated IDs and encode chapter IDs instead of trusting response URLs", () => {
  assert.equal(bookHref("project-a", "main", "start / ? 中文"), "/projects/project-a/books/main/#start%20%2F%20%3F%20%E4%B8%AD%E6%96%87");
  for (const unsafe of ["../other", "//evil.test", "javascript:alert(1)", "a?next=evil", "", null]) {
    assert.equal(bookHref(unsafe, "main"), null);
    assert.equal(bookHref("project-a", unsafe), null);
  }
});

test("fingerprints yield readable covers and never carry arbitrary CSS or fonts", () => {
  const palette = coverPalette({ colors: ["url(https://evil.test/a)", "#fff; background:red", "var(--secret)", "#abc", "#18352a", "#ce7b51"], fonts: ["url(https://evil.test/font)"] });
  for (const color of Object.values(palette)) assert.match(color, /^#[0-9a-f]{6}$/);
  assert.ok(contrast(palette.ink, palette.paper) >= 7);
  assert.ok(contrast(palette.accent, palette.paper) >= 3);
  assert.deepEqual(coverPalette(null), { paper: "#fffdf7", ink: "#151b1e", accent: "#993c1d" });
  const lowContrast = coverPalette({ colors: ["#fff", "#eee", "#ddd"] });
  assert.ok(contrast(lowContrast.ink, lowContrast.paper) >= 7);
});

test('example previews and personal projects with the same ID never share a URL or cached payload', async () => {
  const { projectBookHref } = require('../public/shelf-preview.js');
  assert.equal(projectBookHref({ id: 'pupkit', isExample: true }, 'main', 'ch1'), '/examples/pupkit/books/main/#ch1');
  assert.equal(projectBookHref({ id: 'pupkit' }, 'main'), '/projects/pupkit/books/main/');
  const calls = [];
  const cache = createPreviewCache(async (id, project) => { calls.push(project.isExample ? 'example' : 'private'); return { projectId: id }; });
  await cache.load({ id: 'pupkit', bookCount: 1 });
  await cache.load({ id: 'pupkit', bookCount: 1, isExample: true });
  assert.deepEqual(calls, ['private', 'example']);
});
