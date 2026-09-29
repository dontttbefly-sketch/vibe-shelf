// Synthetic private library for browser performance checks, never public examples.
import path from "node:path";
import { createBookStore } from "../lib/books.mjs";
import { compileBook } from "../lib/book-compiler.mjs";
import { createProjectService } from "../lib/project-service.mjs";

export function seedPerformanceLibrary(root, sourceHtml, source) {
  const tenantRoot = path.join(root, "data", "public-service", "users", "github-900002");
  const dataDir = path.join(tenantRoot, "data"), publicDir = path.join(tenantRoot, "books");
  // The bulk fixtures test catalog cost, not source anchoring (covered with real
  // examples). Keep normal compiler/runtime output without 120 diagnostic logs.
  const books = createBookStore({ dataDir, publicDir, compile: options => compileBook({ ...options, sourceFiles: null }) });
  const projects = createProjectService({ dataDir, publicDir, books });
  const topics = ["入口与调用链", "异步任务与失败恢复", "源码快照和引用", "队列与数据流"];
  for (let index = 1; index <= 120; index++) {
    const number = String(index).padStart(3, "0");
    const title = `性能样本 ${number} · ${topics[index % topics.length]}` + (index % 15 === 0 ? "：跨模块状态、长标题与返回书架位置的连续阅读验证" : "");
    projects.importWithMainBook({ projectId: `perf-${number}`, name: title,
      files: [{ path: "src/main.js", content: source }],
      mainBook: { title, sourceHtml: sourceHtml.replaceAll("公共流程验收书", title) },
    });
  }
  return { count: 120, owner: "github-900002" };
}
