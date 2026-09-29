import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const clientSource = fs.readFileSync(new URL("../public/explore.js", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(body) });
const session = (id, question = "第一问") => ({
  id, sourceSnapshotId: "snapshot-1",
  messages: [{ id: id + "-q", role: "user", content: question }, { id: id + "-a", role: "assistant", status: "complete", content: "已保存的回答", sourceRefs: [] }],
});

function mounted({ href = "http://localhost/projects/project/books/main/", values = new Map(), fetchImpl, sourceApi } = {}) {
  const events = {};
  const navigations = [];
  const requests = [];
  const timers = new Map();
  let nextTimer = 0;
  let address = new URL(href);
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {};
      this.dataset = {}; this.value = ""; this.disabled = false; this.hidden = false; this.classes = new Set();
      this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name), add: (name) => this.classes.add(name) };
    }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return (this.text || "") + this.children.map((node) => node.textContent).join(""); }
    get childNodes() { return this.children; }
    set innerHTML(value) {
      this.children = [];
      if (!value.includes("data-explore-form")) { this.text = value; return; }
      const form = new Element("form"); const textarea = new Element("textarea"); const submit = new Element("button"); submit.setAttribute("type", "submit");
      form.appendChild(textarea); form.appendChild(submit); this.appendChild(form);
      for (const attr of ["data-explore-title", "data-explore-list", "data-explore-new", "data-explore-history", "data-explore-sessions", "data-explore-status"]) {
        const node = new Element(/list|new/.test(attr) ? "button" : "div"); node.setAttribute(attr, ""); this.appendChild(node);
      }
    }
    appendChild(node) { this.children.push(node); return node; }
    replaceChildren(...nodes) { this.children = nodes; this.text = ""; }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    hasAttribute(key) { return key in this.attrs; }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    emit(name, detail = {}) { return Promise.all((this.listeners[name] || []).map((fn) => fn({ preventDefault() {}, ...detail }))); }
    querySelectorAll(selector) {
      const all = this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
      if (selector === "*") return all;
      const match = selector.match(/^\[([^=\]]+)(?:=([^\]]+))?\]$/);
      return all.filter((node) => match ? node.hasAttribute(match[1]) && (!match[2] || node.getAttribute(match[1]) === match[2]) : node.tagName.toLowerCase() === selector);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    focus() { this.focused = true; }
    scrollIntoView(options) { this.scrolled = (this.scrolled || 0) + 1; this.scrollOptions = options; }
    getBoundingClientRect() { return { top: 1000 }; }
  }
  const root = new Element("section");
  const localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
  const window = {
    SHELF_CONTEXT: { projectId: "project", bookId: "main", sourceSnapshotId: "snapshot-1" },
    ShelfSource: sourceApi, scrollY: 100,
    location: { get href() { return address.href; }, get search() { return address.search; }, get hash() { return address.hash; }, assign(url) { navigations.push(url); } },
    history: { replaceState(_state, _title, url) { address = new URL(url, address); } },
    addEventListener(name, fn) { (events[name] ||= []).push(fn); },
    requestAnimationFrame(fn) { fn(); },
  };
  const context = vm.createContext({
    window, document: { querySelector: () => root, querySelectorAll: () => [], createElement: (tag) => new Element(tag) },
    localStorage, sessionStorage: { getItem: () => null }, URL, URLSearchParams, AbortSignal,
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options = {}) => { requests.push({ url, options }); return fetchImpl(url, options); },
  });
  vm.runInContext(clientSource, context);
  return {
    api: window.ShelfExplore.current, window, root, values, requests, navigations, events,
    textarea: root.querySelector("textarea"), status: root.querySelector("[data-explore-status]"),
    async emit(name) { for (const fn of events[name] || []) fn(); await tick(); },
    async poll() { const callbacks = [...timers.values()]; timers.clear(); for (const fn of callbacks) fn(); await tick(); },
  };
}

test("switching a deep-linked exploration updates its URL and keeps other navigation parameters", async () => {
  const page = mounted({ href: "http://localhost/projects/project/books/main/?exploration=e-a&view=read#shelf-explore", fetchImpl: async (url) => reply({ session: session(url.endsWith("e-b") ? "e-b" : "e-a") }) });
  await tick();
  await page.api.openSession("e-b");
  const address = new URL(page.window.location.href);
  assert.equal(address.searchParams.get("exploration"), "e-b");
  assert.equal(address.searchParams.get("view"), "read");
  assert.equal(address.hash, "#shelf-explore");
});

test("an accepted answer recovered after a dropped HTTP response clears only the sent draft", async () => {
  const saved = session("e-a");
  const page = mounted({ href: "http://localhost/?exploration=e-a", fetchImpl: async (_url, options) => {
    if (options.method === "POST") {
      saved.messages.push({ id: "q-accepted", role: "user", content: "接着解释" }, { id: "a-accepted", role: "assistant", status: "complete", content: "已完成但响应失联", sourceRefs: [] });
      throw new Error("connection reset");
    }
    return reply({ session: saved });
  } });
  await tick();
  page.textarea.value = "接着解释";
  await page.api.sendMessage(page.textarea.value);
  assert.equal(page.textarea.value, "");
  assert.equal(page.values.get("shelf-exploration-project-main-draft-e-a") || "", "");
  assert.match(page.root.querySelector("[data-explore-history]").textContent, /已完成但响应失联/);
  assert.equal(page.requests.filter((item) => item.options.method === "POST").length, 1);
});

test("a rejected send keeps the draft and its actionable error after session refresh", async () => {
  const page = mounted({ href: "http://localhost/?exploration=e-a", fetchImpl: async (_url, options) => options.method === "POST" ? reply({ error: { message: "当前无法接收问题" } }, 503) : reply({ session: session("e-a") }) });
  await tick();
  page.textarea.value = "未能发送的新问题";
  await page.api.sendMessage(page.textarea.value);
  assert.equal(page.textarea.value, "未能发送的新问题");
  assert.match(page.status.textContent, /当前无法接收|未发送|草稿已保留/);
  assert.equal(page.status.classes.has("is-error"), true);
});

test("a failed history switch retains the previous session as the send target", async () => {
  const page = mounted({ href: "http://localhost/?exploration=e-a", fetchImpl: async (url, options) => {
    if (url.endsWith("e-b")) throw new Error("offline");
    return options.method === "POST" ? reply({ assistantMessage: { id: "done" } }) : reply({ session: session("e-a") });
  } });
  await tick();
  await page.api.openSession("e-b");
  page.textarea.value = "继续原来的探索";
  await page.api.sendMessage(page.textarea.value);
  assert.ok(page.requests.find((item) => item.options.method === "POST").url.includes("/e-a/messages"));
});

test("the dynamically mounted exploration honors the initial deep-link position", async () => {
  const page = mounted({ href: "http://localhost/?exploration=e-a#shelf-explore", fetchImpl: async () => reply({ session: session("e-a") }) });
  await tick();
  assert.equal(page.root.id, "shelf-explore");
  assert.ok(page.root.scrolled >= 1);
});

test("reloading during a request keeps the question recoverable without sending it twice", async () => {
  const saved = session("e-a");
  let finish;
  let postCount = 0;
  const values = new Map();
  const fetchImpl = async (_url, options) => {
    if (options.method === "POST") {
      postCount++;
      saved.messages.push({ id: "q-pending", role: "user", content: "刷新时还在等待的问题" }, { id: "a-pending", role: "assistant", status: "pending", content: "" });
      return new Promise((resolve) => { finish = resolve; });
    }
    return reply({ session: saved });
  };
  const first = mounted({ href: "http://localhost/?exploration=e-a", values, fetchImpl });
  await tick();
  first.textarea.value = "刷新时还在等待的问题";
  const pending = first.api.sendMessage(first.textarea.value);
  await tick(); await first.emit("pagehide");
  const second = mounted({ href: "http://localhost/?exploration=e-a", values, fetchImpl });
  await tick();
  assert.match(second.root.querySelector("[data-explore-history]").textContent, /刷新时还在等待的问题/);
  assert.equal(postCount, 1);
  assert.equal(second.textarea.disabled, true);
  saved.messages.at(-1).status = "complete"; saved.messages.at(-1).content = "等待结束";
  finish(reply({ assistantMessage: saved.messages.at(-1) }));
  await pending; await second.poll();
  assert.equal(second.textarea.value, "", "the recovered accepted question must not become a duplicate draft");
});

test("double book-growth activation sends one request with the same answer identity", async () => {
  let finish;
  const page = mounted({ href: "http://localhost/?exploration=e-a", fetchImpl: async (_url, options) => options.method === "POST" ? new Promise((resolve) => { finish = resolve; }) : reply({ session: session("e-a") }) });
  await tick();
  const first = page.api.growIntoBook("e-a-a");
  const second = page.api.growIntoBook("e-a-a");
  assert.equal(page.requests.filter((item) => item.options.method === "POST").length, 1);
  assert.equal(JSON.parse(page.requests.at(-1).options.body).answerMessageId, "e-a-a");
  finish(reply({ book: { id: "one-small-book" } }));
  await Promise.all([first, second]);
  assert.deepEqual(page.navigations, ["/projects/project/books/one-small-book/"]);
});

test("source references pass their own snapshot and line range to the shared source drawer", async () => {
  const calls = [];
  const saved = session("e-a"); saved.messages[1].sourceRefs = [{ path: "src/main.js", startLine: 4, endLine: 8 }];
  const page = mounted({ href: "http://localhost/?exploration=e-a", sourceApi: { open: async (ref) => { calls.push(ref); return true; } }, fetchImpl: async () => reply({ session: saved }) });
  await tick();
  const button = page.root.querySelector("[data-explore-source]");
  assert.ok(button);
  await button.emit("click");
  assert.equal(calls[0].sourceSnapshotId, "snapshot-1");
  assert.equal(calls[0].startLine, 4);
  assert.equal(calls[0].endLine, 8);
});

test("recovering an accepted question preserves a different unsent follow-up draft", async () => {
  const values = new Map([
    ["shelf-exploration-project-main-draft-e-a", "我刚写的下一个问题"],
    ["shelf-exploration-project-main-draft-e-a-sending", JSON.stringify({ question: "已经送达的问题", beforeIds: [] })],
  ]);
  const page = mounted({ href: "http://localhost/?exploration=e-a", values, fetchImpl: async () => reply({ session: session("e-a", "已经送达的问题") }) });
  await tick();
  assert.equal(page.textarea.value, "我刚写的下一个问题");
  assert.equal(values.get("shelf-exploration-project-main-draft-e-a"), "我刚写的下一个问题");
  assert.equal(values.has("shelf-exploration-project-main-draft-e-a-sending"), false);
});

test("an earlier identical question is not mistaken for acknowledgement of a rejected new send", async () => {
  const page = mounted({ href: "http://localhost/?exploration=e-a", fetchImpl: async (_url, options) => options.method === "POST"
    ? reply({ error: { message: "本次未发送" } }, 503)
    : reply({ session: session("e-a", "相同的问题") }) });
  await tick();
  page.textarea.value = "相同的问题";
  await page.api.sendMessage(page.textarea.value);
  assert.equal(page.textarea.value, "相同的问题");
  assert.match(page.status.textContent, /本次未发送/);
});

test("normal send settles its waiting feedback and keeps the form usable", async () => {
  const saved = session("e-a");
  const page = mounted({ href: "http://localhost/?exploration=e-a", fetchImpl: async (_url, options) => {
    if (options.method === "POST") {
      saved.messages.push({ id: "new-q", role: "user", content: "新的问题" }, { id: "new-a", role: "assistant", status: "complete", content: "新回答" });
      return reply({ assistantMessage: saved.messages.at(-1) });
    }
    return reply({ session: saved });
  } });
  await tick();
  page.textarea.value = "新的问题";
  await page.api.sendMessage(page.textarea.value);
  assert.equal(page.textarea.disabled, false);
  assert.doesNotMatch(page.status.textContent, /正在/);
});

test("a book result arriving after leaving and returning does not hijack navigation or lock the form", async () => {
  let finish;
  const page = mounted({ href: "http://localhost/?exploration=e-a", fetchImpl: async (_url, options) => options.method === "POST"
    ? new Promise((resolve) => { finish = resolve; }) : reply({ session: session("e-a") }) });
  await tick();
  const growing = page.api.growIntoBook("e-a-a");
  await page.emit("pagehide"); await page.emit("pageshow");
  finish(reply({ book: { id: "late-book" } }));
  await growing;
  assert.deepEqual(page.navigations, []);
  assert.equal(page.textarea.disabled, false);
});

test("retrying book growth after a dropped response reuses the same answer and parent identity", async () => {
  let posts = 0;
  const page = mounted({ href: "http://localhost/?exploration=e-a", fetchImpl: async (_url, options) => {
    if (options.method !== "POST") return reply({ session: session("e-a") });
    if (++posts === 1) throw new Error("response lost after book created");
    return reply({ book: { id: "same-book" } });
  } });
  await tick();
  await page.api.growIntoBook("e-a-a");
  await page.api.growIntoBook("e-a-a");
  const bodies = page.requests.filter((entry) => entry.options.method === "POST").map((entry) => JSON.parse(entry.options.body));
  assert.deepEqual(bodies, [{ answerMessageId: "e-a-a", parentBookId: "main" }, { answerMessageId: "e-a-a", parentBookId: "main" }]);
  assert.deepEqual(page.navigations, ["/projects/project/books/same-book/"]);
});

test("IME Enter does not send and an explicit chapter hash is not overridden", async () => {
  const page = mounted({ href: "http://localhost/?exploration=e-a#chapter-2", fetchImpl: async () => reply({ session: session("e-a") }) });
  await tick();
  page.textarea.value = "中文输入中";
  await page.textarea.emit("keydown", { key: "Enter", isComposing: true });
  await page.textarea.emit("keydown", { key: "Enter", keyCode: 229 });
  assert.equal(page.requests.filter((entry) => entry.options.method === "POST").length, 0);
  assert.equal(page.root.scrolled || 0, 0);
});
