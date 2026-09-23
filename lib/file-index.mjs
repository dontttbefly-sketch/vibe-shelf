import { createHash } from "node:crypto";
import path from "node:path";

const LANGUAGE_BY_EXTENSION = new Map([
  [".cjs", "javascript"],
  [".css", "css"],
  [".csv", "csv"],
  [".go", "go"],
  [".html", "html"],
  [".htm", "html"],
  [".java", "java"],
  [".js", "javascript"],
  [".json", "json"],
  [".jsx", "javascript"],
  [".md", "markdown"],
  [".mdx", "markdown"],
  [".mjs", "javascript"],
  [".py", "python"],
  [".rb", "ruby"],
  [".rs", "rust"],
  [".sh", "shell"],
  [".sql", "sql"],
  [".svg", "svg"],
  [".toml", "toml"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".txt", "text"],
  [".xml", "xml"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
]);

export function languageFor(filePath) {
  return LANGUAGE_BY_EXTENSION.get(path.posix.extname(filePath).toLowerCase()) || "text";
}

export function buildFileIndex(files) {
  return [...files]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .flatMap((file) => {
      const lines = file.content.split("\n");
      const hash = createHash("sha256").update(file.content).digest("hex");
      const chunks = [];

      for (let start = 0; start < lines.length; start += 120) {
        const end = Math.min(lines.length, start + 120);
        chunks.push({
          path: file.path,
          startLine: start + 1,
          endLine: end,
          text: lines.slice(start, end).join("\n"),
          language: languageFor(file.path),
          hash,
        });
      }

      return chunks;
    });
}
