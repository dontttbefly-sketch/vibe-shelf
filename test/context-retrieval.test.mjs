import assert from "node:assert/strict";
import test from "node:test";
import { retrieveContext } from "../lib/context-retrieval.mjs";

const index = [
  { path: "README.md", startLine: 1, endLine: 4, text: "项目介绍和启动说明" },
  { path: "server.mjs", startLine: 1, endLine: 4, text: "export function startServer() {}" },
  { path: "src/auth.mjs", startLine: 1, endLine: 4, text: "export function 认证() {}" },
];

test("retrieval ranks matching source chunks", () => {
  assert.equal(retrieveContext(index, "认证")[0].path, "src/auth.mjs");
});

test("retrieval uses a deterministic path and line tie-breaker", () => {
  const tied = [
    { path: "src/z.mjs", startLine: 1, endLine: 2, text: "token" },
    { path: "src/a.mjs", startLine: 7, endLine: 8, text: "token" },
    { path: "src/a.mjs", startLine: 1, endLine: 2, text: "token" },
  ];

  assert.deepEqual(
    retrieveContext(tied, "token").map(({ path, startLine }) => `${path}:${startLine}`),
    ["src/a.mjs:1", "src/a.mjs:7", "src/z.mjs:1"],
  );
});

test("a broad question gets a stable project orientation", () => {
  assert.equal(retrieveContext(index, "一个很模糊的问题")[0].path, "README.md");
});
