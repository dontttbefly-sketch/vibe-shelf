import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("exploration client separates ordinary send from explicit book growth", () => {
  const source = fs.readFileSync("public/explore.js", "utf8");
  assert.match(source, /ShelfExplore/);
  assert.match(source, /function mount/);
  assert.match(source, /function sendMessage/);
  assert.match(source, /function growIntoBook/);
  assert.match(source, /\/books/);
  assert.match(source, /本地运行/);
});
