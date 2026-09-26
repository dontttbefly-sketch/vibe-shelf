import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTempDir } from "./helpers.mjs";
import { migratePupkit } from "../scripts/migrate-pupkit.mjs";

test("PUPKIT migration is idempotent and retains existing notes", (t) => {
  const fixtureRepo = makeTempDir(t);
  fs.cpSync("public", path.join(fixtureRepo, "public"), { recursive: true });
  fs.cpSync("data", path.join(fixtureRepo, "data"), { recursive: true });
  const dataDir = path.join(fixtureRepo, "data");
  const publicDir = path.join(fixtureRepo, "public");
  const compiledBook = path.join(publicDir, "projects", "pupkit", "books", "main");
  const liveNotesPath = path.join(dataDir, "projects", "pupkit", "notes", "main.json");
  const liveNotes = JSON.parse(fs.readFileSync(liveNotesPath, "utf8"));

  // A fresh clone may retain the project data but not the generated reader or
  // the runtime project index. Migration should repair both without touching
  // the existing PUPKIT notes.
  fs.rmSync(compiledBook, { recursive: true, force: true });
  fs.rmSync(path.join(dataDir, "projects.json"), { force: true });

  const first = migratePupkit({ repoDir: fixtureRepo, dataDir, publicDir });
  const second = migratePupkit({ repoDir: fixtureRepo, dataDir, publicDir });

  assert.equal(first.id, "main");
  assert.equal(second.id, "main");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(liveNotesPath, "utf8")),
    liveNotes,
  );
  const output = fs.readFileSync(path.join(compiledBook, "index.html"), "utf8");
  assert.match(output, /window\.SHELF_CONTEXT/);
  assert.match(output, /data-shelf-explore/);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(compiledBook, "data", "main.json"), "utf8")),
    liveNotes,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, "projects.json"), "utf8")).map((project) => project.id), ["pupkit"]);
});
