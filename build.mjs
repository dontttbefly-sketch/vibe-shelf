// 把一份教学书 HTML 编译为独立阅读页；不会再覆盖书架首页。
import fs from "node:fs";
import path from "node:path";
import { compileBook } from "./lib/book-compiler.mjs";
import { assertId } from "./lib/ids.mjs";

const args = process.argv.slice(2);
const valueFlags = new Set(["--out", "--book", "--title"]);
const source = args.find((value, index) => (
  !value.startsWith("--") && !valueFlags.has(args[index - 1])
));

if (!source) {
  console.error("用法: node build.mjs <书HTML路径> [--out public/books/<书名>/index.html] [--book pupkit] [--title 书名]");
  process.exit(1);
}

function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : null;
  return value && !value.startsWith("--") ? value : fallback;
}

const bookId = assertId(option("book", "default"), "book id");
const title = option("title", "知识书架");
const outFile = path.resolve(option("out", `public/books/${bookId}/index.html`));
const sourceHtml = fs.readFileSync(path.resolve(source), "utf8");

const result = compileBook({
  sourceHtml,
  title,
  runtimeContext: {
    projectId: null,
    bookId,
    sourceSnapshotId: null,
    kind: "main",
    staticNotesUrl: `data/${bookId}.json`,
  },
  outFile,
  publicDir: path.resolve("public"),
  staticNotesFile: path.resolve("data", `${bookId}.json`),
});

console.log(`已生成 ${result.outFile}`);
console.log(`  书名（静态注释）: ${bookId}`);
console.log(`  体积 ${(Buffer.byteLength(result.output) / 1024).toFixed(1)} KB`);
