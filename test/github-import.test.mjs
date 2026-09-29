import assert from "node:assert/strict";
import test from "node:test";
import { fetchGithubRepoFiles, parseGithubRepo } from "../lib/github-import.mjs";
import { IMPORT_LIMITS } from "../lib/imports.mjs";

test("parseGithubRepo accepts owner/name and full urls", () => {
  assert.equal(parseGithubRepo("octocat/hello-world"), "octocat/hello-world");
  assert.equal(parseGithubRepo("https://github.com/octocat/hello-world"), "octocat/hello-world");
  assert.equal(parseGithubRepo("github.com/octocat/hello-world.git"), "octocat/hello-world");
  assert.equal(parseGithubRepo("git@github.com:octocat/hello-world.git"), "octocat/hello-world");
  assert.throws(() => parseGithubRepo("just-a-name"));
  assert.throws(() => parseGithubRepo(""));
});

// 文件正文走 raw.githubusercontent.com（不占 API 限额），树走 api.github.com
const COMMIT_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
function fakeGithubFetch(tree, rawFiles, calls = []) {
  return async (url) => {
    calls.push(url);
    if (url.endsWith("/commits/HEAD")) {
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ sha: COMMIT_SHA, commit: { tree: { sha: TREE_SHA } } }) };
    }
    if (url.includes("/git/trees/")) {
      assert.equal(url.split("/git/trees/")[1], `${TREE_SHA}?recursive=1`);
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => ({ sha: TREE_SHA, tree }),
      };
    }
    const marker = `/${COMMIT_SHA}/`;
    assert.ok(url.includes(marker), "raw files must use the selected commit, never HEAD or a tree SHA");
    const path = decodeURIComponent(url.slice(url.indexOf(marker) + marker.length));
    if (!(path in rawFiles)) {
      return { ok: false, status: 404, headers: new Map(), text: async () => "404: Not Found" };
    }
    return { ok: true, status: 200, headers: new Map(), text: async () => rawFiles[path] };
  };
}

test("fetchGithubRepoFiles keeps text files and skips binaries and big files", async () => {
  const bigContent = "x".repeat(IMPORT_LIMITS.maxFileBytes + 1);
  const tree = [
    { type: "blob", path: "index.html", sha: "a1", size: 100 },
    { type: "blob", path: "assets/app.js", sha: "a2", size: 100 },
    { type: "blob", path: "docs/logo.png", sha: "a3", size: 100 },
    { type: "blob", path: "vendor/lib.js", sha: "a4", size: 100 },
    { type: "blob", path: "huge.py", sha: "a5", size: bigContent.length },
    { type: "tree", path: "src", sha: "t1", size: 0 },
  ];
  const rawFiles = {
    "index.html": "<!doctype html><h1>hello</h1>",
    "assets/app.js": "console.log(1)",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeGithubFetch(tree, rawFiles);
  try {
    const { repo, files, sourceCommit, sourceTreeSha } = await fetchGithubRepoFiles("octocat/hello-world", { token: "" });
    assert.equal(repo, "octocat/hello-world");
    assert.equal(sourceCommit, COMMIT_SHA);
    assert.equal(sourceTreeSha, TREE_SHA);
    assert.deepEqual(files.map((f) => f.path), ["assets/app.js", "index.html"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a 404 file is not retried (retrying only burns the api quota)", async () => {
  const tree = [{ type: "blob", path: "gone.js", sha: "a1", size: 10 }];
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeGithubFetch(tree, {}, calls);
  try {
    await assert.rejects(() => fetchGithubRepoFiles("octocat/hello-world", { token: "" }), /404/);
    assert.equal(calls.filter((url) => url.startsWith("https://raw.githubusercontent.com/")).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a branch advance during import cannot mix a newer raw file into the selected tree", async () => {
  const calls = [];
  let head = COMMIT_SHA;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (url.endsWith("/commits/HEAD")) {
      const selected = head;
      head = "c".repeat(40); // A push lands immediately after HEAD was resolved.
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ sha: selected, commit: { tree: { sha: TREE_SHA } } }) };
    }
    if (url.includes("/git/trees/")) {
      assert.ok(url.includes(`/${TREE_SHA}?recursive=1`));
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ sha: TREE_SHA, tree: [
        { type: "blob", path: "README.md", size: 20 },
        { type: "blob", path: "src/old #入口.js", size: 20 },
      ] }) };
    }
    const ref = new URL(url).pathname.split("/")[3];
    return { ok: true, status: 200, headers: new Map(), text: async () => ref === COMMIT_SHA ? "original snapshot" : "new branch content" };
  };
  try {
    const result = await fetchGithubRepoFiles("octocat/hello-world", { token: "" });
    assert.equal(result.sourceCommit, COMMIT_SHA);
    assert.notEqual(result.sourceCommit, head);
    assert.ok(result.files.every(file => file.content === "original snapshot"));
    assert.equal(calls.filter(url => url.includes("/commits/HEAD")).length, 1);
    assert.ok(calls.some(url => url.endsWith("/src/old%20%23%E5%85%A5%E5%8F%A3.js")));
    assert.ok(calls.filter(url => url.startsWith("https://raw.githubusercontent.com/")).every(url => url.includes(`/${COMMIT_SHA}/`)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid commit metadata fails before any tree or raw file can be fetched", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const metadata of [
      { sha: "HEAD", commit: { tree: { sha: TREE_SHA } } },
      { sha: COMMIT_SHA, commit: { tree: { sha: "../other" } } },
      { sha: COMMIT_SHA },
    ]) {
      const calls = [];
      globalThis.fetch = async (url) => {
        calls.push(url);
        return { ok: true, status: 200, headers: new Map(), json: async () => metadata };
      };
      await assert.rejects(fetchGithubRepoFiles("octocat/hello-world", { token: "" }), /无法固定源码版本/);
      assert.deepEqual(calls, ["https://api.github.com/repos/octocat/hello-world/commits/HEAD"]);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a mismatched tree is rejected instead of attributing its files to the selected commit", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, headers: new Map(), json: async () => url.endsWith("/commits/HEAD")
      ? { sha: COMMIT_SHA, commit: { tree: { sha: TREE_SHA } } }
      : { sha: "d".repeat(40), tree: [{ type: "blob", path: "README.md", size: 10 }] } };
  };
  try {
    await assert.rejects(fetchGithubRepoFiles("octocat/hello-world", { token: "" }), /文件树与选定提交不一致/);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(url => url.startsWith("https://api.github.com/")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
