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

const chineseIndex = [
  { path: "README.md", startLine: 1, endLine: 3, text: "项目介绍 安装 使用" },
  { path: "src/config.mjs", startLine: 1, endLine: 9, text: "读取环境变量 加载配置 默认端口" },
  { path: "src/router.mjs", startLine: 1, endLine: 9, text: "注册路由 匹配路径 分发请求" },
];

test("chinese questions reach the matching file instead of the readme fallback", () => {
  // 回归：整句中文曾被切成一个超长 term，永远匹配不上索引，
  // 于是任何中文提问都退化成 sourcePriority 兜底（README + 入口文件）
  assert.deepEqual(retrieveContext(chineseIndex, "配置是怎么加载的").map((c) => c.path), ["src/config.mjs"]);
  assert.deepEqual(retrieveContext(chineseIndex, "路由怎么注册").map((c) => c.path), ["src/router.mjs"]);
});

test("english identifiers and paths still match as whole words", () => {
  assert.deepEqual(retrieveContext(chineseIndex, "config load").map((c) => c.path), ["src/config.mjs"]);
  assert.deepEqual(retrieveContext(chineseIndex, "src/router.mjs").map((c) => c.path), ["src/router.mjs"]);
});
