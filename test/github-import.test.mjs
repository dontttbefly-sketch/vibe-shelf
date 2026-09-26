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

function fakeGithubFetch(tree, blobs) {
  return async (url) => {
    if (url.includes("/git/trees/")) {
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => ({ tree }),
      };
    }
    const sha = url.split("/").pop();
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({ content: Buffer.from(blobs[sha]).toString("base64") }),
    };
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
  const blobs = {
    a1: "<!doctype html><h1>hello</h1>",
    a2: "console.log(1)",
    a5: bigContent,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeGithubFetch(tree, blobs);
  try {
    const { repo, files } = await fetchGithubRepoFiles("octocat/hello-world");
    assert.equal(repo, "octocat/hello-world");
    assert.deepEqual(files.map((f) => f.path), ["assets/app.js", "index.html"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
