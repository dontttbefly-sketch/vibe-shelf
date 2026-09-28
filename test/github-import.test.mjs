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
function fakeGithubFetch(tree, rawFiles, calls = []) {
  return async (url) => {
    calls.push(url);
    if (url.includes("/git/trees/")) {
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => ({ tree }),
      };
    }
    const marker = "/HEAD/";
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
    const { repo, files } = await fetchGithubRepoFiles("octocat/hello-world");
    assert.equal(repo, "octocat/hello-world");
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
    await assert.rejects(() => fetchGithubRepoFiles("octocat/hello-world"), /404/);
    assert.equal(calls.filter((url) => url.includes("/HEAD/")).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
