// 存量主书复活：按当前锚定规则重新编译发布（不改 source.html，不调模型）。
// 用法：node scripts/relink-main-book.mjs <projectId> [--dry-run]
// 锚定发生在编译期，所以"重新发布一遍"就是重跑锚定；--dry-run 只看统计不落盘。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBookStore } from "../lib/books.mjs";
import { projectDir, readProject } from "../lib/projects.mjs";
import { readSnapshotTextFiles } from "../lib/snapshot-files.mjs";
import { anchorCodeBlocks } from "../lib/source-link.mjs";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function relinkMainBook({ dataDir, publicDir, projectId, dryRun = false }) {
  if (!readProject(dataDir, projectId)) throw new Error(`项目不存在：${projectId}`);
  const books = createBookStore({ dataDir, publicDir });
  const book = books.getBook(projectId, "main");
  if (!book) throw new Error(`项目没有主书：${projectId}`);

  const sourceFile = path.join(projectDir(dataDir, projectId), "books", book.id, "source.html");
  if (!fs.existsSync(sourceFile)) throw new Error(`主书源文件缺失：${sourceFile}`);
  const sourceHtml = fs.readFileSync(sourceFile, "utf8");

  const sourceFiles = readSnapshotTextFiles(dataDir, projectId, book.sourceSnapshotId);
  const { stats } = anchorCodeBlocks(sourceHtml, sourceFiles);
  console.log(`锚定统计：${stats.anchored}/${stats.blocks} 个代码块命中（歧义放弃 ${stats.ambiguous}）`);
  if (dryRun) return stats;

  books.registerMainBook({
    projectId,
    title: book.title,
    sourceSnapshotId: book.sourceSnapshotId,
    sourceHtml,
    styleFingerprint: book.styleFingerprint,
    replace: true,
  });
  console.log(`已重新发布：${path.join(publicDir, "projects", projectId, "books", book.id, "index.html")}`);
  return stats;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dryRun = process.argv.includes("--dry-run");
  const projectId = process.argv.slice(2).find((arg) => arg !== "--dry-run");
  if (!projectId) {
    console.error("用法：node scripts/relink-main-book.mjs <projectId> [--dry-run]");
    process.exit(1);
  }
  relinkMainBook({
    dataDir: path.join(repoDir, "data"),
    publicDir: path.join(repoDir, "public"),
    projectId,
    dryRun,
  });
}
