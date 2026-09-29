import fs from "node:fs";
import path from "node:path";
import { validateBookSource } from "./book-compiler.mjs";
import { retrieveContext } from "./context-retrieval.mjs";
import { assertId, assertRelativePath, isInsideRoot } from "./ids.mjs";
import { importLocalProject, refreshSnapshot } from "./imports.mjs";
import { readJson } from "./json-store.mjs";
import { normalizeReadingIntent } from "./reading-intent.mjs";
import {
  listProjectSummaries,
  projectDir,
  readProject,
  removeProjectIndex,
} from "./projects.mjs";

function removeIfPresent(target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

function snapshotRoot(dataDir, projectId, snapshotId) {
  const safeProjectId = assertId(projectId, "projectId");
  const safeSnapshotId = assertId(snapshotId, "snapshotId");
  const root = path.join(projectDir(dataDir, safeProjectId), "source", safeSnapshotId);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error("snapshot not found");
  return root;
}

function indexFile(dataDir, projectId, snapshotId) {
  const safeProjectId = assertId(projectId, "projectId");
  const safeSnapshotId = assertId(snapshotId, "snapshotId");
  return path.join(projectDir(dataDir, safeProjectId), "file-index", `${safeSnapshotId}.json`);
}

function listSnapshotFiles(root) {
  const files = [];
  const visit = (directory, prefix = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath, relative);
      // Dirent 只有 name/parentPath，没有 size——必须 stat，否则调用方拿到 undefined
      else if (entry.isFile()) files.push({ path: relative, size: fs.statSync(fullPath).size });
    }
  };
  visit(root);
  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function requireProject(dataDir, projectId) {
  const project = readProject(dataDir, projectId);
  if (!project) throw new Error("project not found");
  return project;
}

function assertMainBook(mainBook) {
  if (!mainBook || typeof mainBook !== "object") throw new Error("missing main book");
  if (typeof mainBook.title !== "string" || !mainBook.title.trim()) throw new Error("invalid main book title");
  validateBookSource(mainBook.sourceHtml);
  return { title: mainBook.title.trim(), sourceHtml: mainBook.sourceHtml };
}

function bookUrl(projectId, bookId) {
  return `/projects/${encodeURIComponent(projectId)}/books/${encodeURIComponent(bookId)}/`;
}

export function createProjectService({ dataDir, publicDir, books }) {
  if (!books) throw new Error("book store is required");

  function importWithMainBook(input) {
    const projectId = assertId(input?.projectId, "projectId");
    const mainBook = assertMainBook(input?.mainBook);
    let imported = false;
    try {
      const importedProject = importLocalProject({
        dataDir,
        projectId,
        name: input.name,
        files: input.files,
        readingIntent: normalizeReadingIntent(input.readingIntent),
      });
      imported = true;
      books.registerMainBook({
        projectId,
        title: mainBook.title,
        sourceSnapshotId: importedProject.currentSnapshotId,
        sourceHtml: mainBook.sourceHtml,
      });
      return requireProject(dataDir, projectId);
    } catch (error) {
      if (imported) {
        removeIfPresent(projectDir(dataDir, projectId));
        removeIfPresent(path.join(publicDir, "projects", projectId));
        removeProjectIndex(dataDir, projectId);
      }
      throw error;
    }
  }

  function getProjectView(projectId) {
    const project = requireProject(dataDir, projectId);
    return {
      project,
      books: books.listBooks(project.id).map((book) => ({ ...book, url: bookUrl(project.id, book.id) })),
      recentExplorations: [],
    };
  }

  function refreshProjectSnapshot(projectId, files) {
    return refreshSnapshot({ dataDir, projectId, files });
  }

  function getBook(projectId, bookId) {
    requireProject(dataDir, projectId);
    const book = books.getBook(projectId, bookId);
    if (!book) throw new Error("book not found");
    return book;
  }

  function getSnapshotFiles(projectId, snapshotId) {
    requireProject(dataDir, projectId);
    return listSnapshotFiles(snapshotRoot(dataDir, projectId, snapshotId));
  }

  function getSnapshotFile(projectId, snapshotId, relativePath) {
    requireProject(dataDir, projectId);
    const root = snapshotRoot(dataDir, projectId, snapshotId);
    const safePath = assertRelativePath(relativePath);
    const target = path.resolve(root, safePath);
    if (!isInsideRoot(root, target) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      throw new Error("snapshot file not found");
    }
    return { path: safePath, content: fs.readFileSync(target, "utf8") };
  }

  function getBookContext(projectId, bookId, query, maxChunks = 6) {
    const book = getBook(projectId, bookId);
    const context = getSnapshotContext(projectId, book.sourceSnapshotId, query, maxChunks);
    return { book, ...context };
  }

  function getSnapshotContext(projectId, snapshotId, query, maxChunks = 6) {
    requireProject(dataDir, projectId);
    snapshotRoot(dataDir, projectId, snapshotId);
    const index = readJson(indexFile(dataDir, projectId, snapshotId), null);
    if (!Array.isArray(index)) throw new Error("snapshot index not found");
    const chunks = retrieveContext(index, query, maxChunks);
    return {
      chunks,
      sourceRefs: chunks.map(({ path: filePath, startLine, endLine }) => ({
        path: filePath,
        startLine,
        endLine,
      })),
    };
  }

  function importProjectFiles(input) {
    return importLocalProject({ dataDir, projectId: input?.projectId, name: input?.name, files: input?.files, readingIntent: normalizeReadingIntent(input?.readingIntent) });
  }

  function registerMainBook(input) {
    return books.registerMainBook({
      projectId: input?.projectId,
      title: input?.title,
      sourceSnapshotId: input?.sourceSnapshotId,
      sourceHtml: input?.sourceHtml,
      styleFingerprint: input?.styleFingerprint ?? null,
      replace: Boolean(input?.replace),
    });
  }

  return {
    getBook,
    bookUrl,
    getBookContext,
    getSnapshotContext,
    getProjectView,
    getSnapshotFile,
    getSnapshotFiles,
    importWithMainBook,
    importProjectFiles,
    registerMainBook,
    requireProjectById: (projectId) => requireProject(dataDir, projectId),
    listSummaries: () => listProjectSummaries(dataDir).map((project) => ({
      ...project,
      bookCount: books.listBooks(project.id).length,
    })),
    refreshProjectSnapshot,
  };
}
