import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTempDir } from "./helpers.mjs";
import { assertId, assertRelativePath, isInsideRoot } from "../lib/ids.mjs";
import { readJson, writeJsonAtomic } from "../lib/json-store.mjs";

test("IDs and imported paths reject traversal", () => {
  assert.equal(assertId("project-1", "projectId"), "project-1");
  assert.throws(() => assertId("../project", "projectId"), /projectId/);
  assert.equal(assertRelativePath("src\\app.mjs"), "src/app.mjs");
  assert.throws(() => assertRelativePath("../secret"), /relative path/);
  assert.throws(() => assertRelativePath("/secret"), /relative path/);
});

test("atomic JSON writes replace one complete document", (t) => {
  const dir = makeTempDir(t);
  const file = path.join(dir, "record.json");

  writeJsonAtomic(file, { version: 1 });
  writeJsonAtomic(file, { version: 2, nested: { ok: true } });

  assert.deepEqual(readJson(file), { version: 2, nested: { ok: true } });
  assert.equal(fs.readdirSync(dir).some((name) => name.includes(".tmp-")), false);
  assert.equal(isInsideRoot(dir, file), true);
  assert.equal(isInsideRoot(dir, path.join(dir, "..", "outside.json")), false);
});
