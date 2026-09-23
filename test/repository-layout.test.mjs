import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("repository root is the project-books app, not a nested legacy wrapper", () => {
  const root = process.cwd();
  assert.ok(fs.existsSync(path.join(root, "lib", "app.mjs")), "root should contain the app backend modules");
  assert.ok(fs.existsSync(path.join(root, "public", "shelf.js")), "root should contain the project shelf frontend");
  assert.ok(fs.existsSync(path.join(root, "public", "explore.js")), "root should contain the exploration frontend");
  assert.ok(fs.existsSync(path.join(root, "public", "notes.js")), "root should contain the unified reader");
  assert.equal(fs.existsSync(path.join(root, "recursive-project-books")), false, "nested project copy should be removed");

  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.match(readme, /把一个项目的源码变成一部可以继续生长的本地项目书/);
  assert.doesNotMatch(readme, /根目录单页版只作为 legacy demo/);
});
