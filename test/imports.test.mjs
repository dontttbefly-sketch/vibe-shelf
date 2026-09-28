import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTempDir } from "./helpers.mjs";
import { importLocalProject, refreshSnapshot } from "../lib/imports.mjs";
import { listProjectSummaries } from "../lib/projects.mjs";

test("invalid import creates no project directory", (t) => {
  const root = makeTempDir(t);

  assert.throws(
    () => importLocalProject({
      dataDir: root,
      projectId: "demo",
      name: "Demo",
      files: [{ path: "../secret", content: "x" }],
    }),
    /relative path/,
  );
  assert.equal(fs.existsSync(path.join(root, "projects", "demo")), false);
});

test("duplicate source paths are rejected before a project is written", (t) => {
  const root = makeTempDir(t);

  assert.throws(
    () => importLocalProject({
      dataDir: root,
      projectId: "demo",
      name: "Demo",
      files: [
        { path: "src/app.mjs", content: "one" },
        { path: "src/app.mjs", content: "two" },
      ],
    }),
    /重复路径/,
  );
  assert.equal(fs.existsSync(path.join(root, "projects", "demo")), false);
});

test("refresh adds a new immutable snapshot", (t) => {
  const root = makeTempDir(t);
  const project = importLocalProject({
    dataDir: root,
    projectId: "demo",
    name: "Demo",
    files: [{ path: "src/app.mjs", content: "export const v = 1;" }],
  });
  const refreshed = refreshSnapshot({
    dataDir: root,
    projectId: "demo",
    files: [{ path: "src/app.mjs", content: "export const v = 2;" }],
  });

  assert.notEqual(project.currentSnapshotId, refreshed.currentSnapshotId);
  assert.match(
    fs.readFileSync(path.join(root, "projects", "demo", "source", project.currentSnapshotId, "src/app.mjs"), "utf8"),
    /v = 1/,
  );
  assert.match(
    fs.readFileSync(path.join(root, "projects", "demo", "source", refreshed.currentSnapshotId, "src/app.mjs"), "utf8"),
    /v = 2/,
  );
});

test("each snapshot persists bounded line references", (t) => {
  const root = makeTempDir(t);
  const lines = Array.from({ length: 121 }, (_, index) => `line ${index + 1}`).join("\n");
  const project = importLocalProject({
    dataDir: root,
    projectId: "demo",
    name: "Demo",
    files: [{ path: "src/app.mjs", content: lines }],
  });
  const index = JSON.parse(fs.readFileSync(
    path.join(root, "projects", "demo", "file-index", `${project.currentSnapshotId}.json`),
    "utf8",
  ));

  assert.deepEqual(index.map(({ path: file, startLine, endLine, language }) => ({ file, startLine, endLine, language })), [
    { file: "src/app.mjs", startLine: 1, endLine: 120, language: "javascript" },
    { file: "src/app.mjs", startLine: 121, endLine: 121, language: "javascript" },
  ]);
});

test("checked-in project manifests remain visible when the local index is absent", (t) => {
  const root = makeTempDir(t);
  importLocalProject({
    dataDir: root,
    projectId: "demo",
    name: "Demo",
    files: [{ path: "src/app.mjs", content: "export {};" }],
  });
  fs.rmSync(path.join(root, "projects.json"));

  assert.deepEqual(listProjectSummaries(root).map((project) => project.id), ["demo"]);
});
