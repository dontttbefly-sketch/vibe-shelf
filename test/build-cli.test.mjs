import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTempDir } from "./helpers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const source = `<!doctype html><html><head><style>body{color:#111}</style></head><body><div class="progress"></div><main class="book-main"><section class="chapter"><p>正文</p></section></main><script>window.x=1</script></body></html>`;

test("build CLI writes a project-scoped book and preserves the shelf homepage", (t) => {
  const root = makeTempDir(t);
  const sourceFile = path.join(root, "source.html");
  const homepage = path.join(root, "public", "index.html");
  fs.mkdirSync(path.dirname(homepage), { recursive: true });
  fs.writeFileSync(sourceFile, source, "utf8");
  fs.writeFileSync(homepage, "<p>keep shelf home</p>", "utf8");

  const result = childProcess.spawnSync(
    process.execPath,
    [path.join(repoRoot, "build.mjs"), "--book", "demo", sourceFile],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(homepage, "utf8"), "<p>keep shelf home</p>");
  assert.ok(fs.existsSync(path.join(root, "public", "books", "demo", "index.html")));
});
