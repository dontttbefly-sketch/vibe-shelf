import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileBook } from "../lib/book-compiler.mjs";
import { createBookStore, importLegacyPupkit } from "../lib/books.mjs";
import { projectDir, readProject, writeProjectIndex } from "../lib/projects.mjs";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readerOutputFile(publicDir) {
  return path.join(publicDir, "projects", "pupkit", "books", "main", "index.html");
}

function republishMainBookIfNeeded({ book, dataDir, publicDir }) {
  const outputFile = readerOutputFile(publicDir);
  const staticNotesFile = path.join(path.dirname(outputFile), "data", "main.json");
  if (
    fs.existsSync(outputFile)
    && fs.existsSync(staticNotesFile)
    && fs.readFileSync(outputFile, "utf8").includes("theme.js")
  ) return;

  const sourceFile = path.join(projectDir(dataDir, "pupkit"), "books", "main", "source.html");
  if (!fs.existsSync(sourceFile)) throw new Error("PUPKIT main book source is missing");

  compileBook({
    sourceHtml: fs.readFileSync(sourceFile, "utf8"),
    title: book.title,
    runtimeContext: {
      projectId: book.projectId,
      bookId: book.id,
      sourceSnapshotId: book.sourceSnapshotId,
      kind: book.kind,
      staticNotesUrl: `data/${book.id}.json`,
    },
    outFile: outputFile,
    publicDir,
    staticNotesFile: path.join(projectDir(dataDir, "pupkit"), "notes", "main.json"),
  });
}

export function migratePupkit({ repoDir: targetRepoDir, dataDir, publicDir }) {
  const books = createBookStore({ dataDir, publicDir });
  let migrated = books.getBook("pupkit", "main");
  if (!migrated) {
    migrated = importLegacyPupkit({
      repoDir: targetRepoDir,
      dataDir,
      publicDir,
      projectId: "pupkit",
      bookId: "main",
    });
  }

  const project = readProject(dataDir, "pupkit");
  if (project) writeProjectIndex(dataDir, project);
  republishMainBookIfNeeded({ book: migrated, dataDir, publicDir });
  return migrated;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migratePupkit({
    repoDir,
    dataDir: path.join(repoDir, "data"),
    publicDir: path.join(repoDir, "public"),
  });
  console.log("PUPKIT migration complete");
}
