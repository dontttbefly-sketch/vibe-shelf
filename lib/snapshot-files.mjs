// 快照文本文件读取：编译期源码锚定（book-compiler）与主书生成选材共用同一份
// "什么算文本文件"的口径。
import fs from "node:fs";
import path from "node:path";
import { assertId } from "./ids.mjs";
import { projectDir } from "./projects.mjs";

export const TEXT_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".html", ".htm", ".css",
  ".md", ".txt", ".yml", ".yaml", ".toml", ".py", ".rb", ".go", ".rs", ".java",
  ".kt", ".swift", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".sh", ".sql",
  ".vue", ".svelte", ".scss", ".less", ".xml",
]);

export function isTextSnapshotFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return !extension || TEXT_EXTENSIONS.has(extension);
}

export function readSnapshotTextFiles(dataDir, projectId, snapshotId) {
  const root = path.join(
    projectDir(dataDir, assertId(projectId, "projectId")),
    "source",
    assertId(snapshotId, "snapshotId"),
  );
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error("snapshot not found");

  const files = [];
  const visit = (directory, prefix = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath, relative);
      else if (entry.isFile() && isTextSnapshotFile(relative)) {
        try {
          files.push({ path: relative, content: fs.readFileSync(fullPath, "utf8") });
        } catch {}
      }
    }
  };
  visit(root);
  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}
