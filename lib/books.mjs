import fs from "node:fs";
import path from "node:path";
import { compileBook } from "./book-compiler.mjs";
import { createExplorationBookSource } from "./exploration-book-source.mjs";
import { assertId, assertRelativePath } from "./ids.mjs";
import { readJson, writeJsonAtomic } from "./json-store.mjs";
import { importLocalProject } from "./imports.mjs";
import { projectDir, readProject, writeProjectIndex } from "./projects.mjs";

function now() {
  return Date.now();
}

function dataBooksDir(dataDir, projectId) {
  return path.join(projectDir(dataDir, projectId), "books");
}

function dataBookDir(dataDir, projectId, bookId) {
  return path.join(dataBooksDir(dataDir, projectId), assertId(bookId, "bookId"));
}

function publicBooksDir(publicDir, projectId) {
  return path.join(publicDir, "projects", assertId(projectId, "projectId"), "books");
}

function publicBookDir(publicDir, projectId, bookId) {
  return path.join(publicBooksDir(publicDir, projectId), assertId(bookId, "bookId"));
}

function bookMetadataFile(dataDir, projectId, bookId) {
  return path.join(dataBookDir(dataDir, projectId, bookId), "book.json");
}

function bookSourceFile(dataDir, projectId, bookId) {
  return path.join(dataBookDir(dataDir, projectId, bookId), "source.html");
}

function removeIfPresent(target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

function assertTitle(title) {
  if (typeof title !== "string" || !title.trim() || title.trim().length > 180) {
    throw new Error("invalid book title");
  }
  return title.trim();
}

function normalizeSourceRefs(sourceRefs = []) {
  if (!Array.isArray(sourceRefs)) throw new Error("invalid source refs");
  return sourceRefs.map((ref) => {
    const startLine = Number(ref?.startLine);
    const endLine = Number(ref?.endLine);
    if (!Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(endLine) || endLine < startLine) {
      throw new Error("invalid source ref");
    }
    return {
      path: assertRelativePath(ref.path),
      startLine,
      endLine,
    };
  });
}

function createSlugId(title, answerMessageId, exists) {
  const normalizedTitle = String(title)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const normalizedAnswerId = String(answerMessageId)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "answer";
  const base = normalizedTitle || "exploration";
  const raw = `${base}-${normalizedAnswerId}`.slice(0, 64).replace(/-+$/g, "") || "exploration";

  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const candidate = suffix === 0
      ? raw
      : `${raw.slice(0, 64 - String(suffix).length - 1).replace(/-+$/g, "")}-${suffix}`;
    if (!exists(candidate)) return assertId(candidate, "bookId");
  }
  throw new Error("unable to create unique book id");
}

function readLegacyFiles(sourceRoot) {
  if (!fs.existsSync(sourceRoot)) throw new Error("legacy PUPKIT source files not found");
  const files = [];

  const visit = (directory, prefix = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => (
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    ))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target, relative);
      else if (entry.isFile()) files.push({
        path: assertRelativePath(relative),
        content: fs.readFileSync(target, "utf8"),
      });
    }
  };

  visit(sourceRoot);
  return files;
}

function updateProjectMainBook(dataDir, projectId) {
  const current = readProject(dataDir, projectId);
  if (!current) return;
  const next = { ...current, mainBookId: "main", updatedAt: now() };
  const manifestFile = path.join(projectDir(dataDir, projectId), "project.json");
  writeJsonAtomic(manifestFile, next);
  try {
    writeProjectIndex(dataDir, next);
  } catch (error) {
    writeJsonAtomic(manifestFile, current);
    throw error;
  }
}

export function createBookStore({ dataDir, publicDir, compile = compileBook }) {
  function getBook(projectId, bookId) {
    return readJson(bookMetadataFile(dataDir, projectId, bookId), null);
  }

  function listBooks(projectId) {
    const directory = dataBooksDir(dataDir, projectId);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => readJson(path.join(directory, entry.name, "book.json"), null))
      .filter(Boolean)
      .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0) || (
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0
      ));
  }

  function publishBookAtomically({ book, sourceHtml }) {
    const finalDataDir = dataBookDir(dataDir, book.projectId, book.id);
    const finalPublicDir = publicBookDir(publicDir, book.projectId, book.id);
    if (fs.existsSync(finalDataDir) || fs.existsSync(finalPublicDir)) throw new Error("book already exists");

    const dataParent = path.dirname(finalDataDir);
    const publicParent = path.dirname(finalPublicDir);
    const token = `${book.id}-${now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dataStagingDir = path.join(dataParent, `.staging-${token}`);
    const publicStagingDir = path.join(publicParent, `.staging-${token}`);
    let publishedPublic = false;
    let publishedData = false;

    fs.mkdirSync(dataStagingDir, { recursive: true });
    fs.mkdirSync(publicStagingDir, { recursive: true });
    try {
      fs.writeFileSync(path.join(dataStagingDir, "source.html"), sourceHtml, "utf8");
      writeJsonAtomic(path.join(dataStagingDir, "book.json"), book);
      compile({
        sourceHtml,
        title: book.title,
        runtimeContext: {
          projectId: book.projectId,
          bookId: book.id,
          sourceSnapshotId: book.sourceSnapshotId,
          kind: book.kind,
          staticNotesUrl: `data/${book.id}.json`,
        },
        outFile: path.join(publicStagingDir, "index.html"),
        publicDir,
        staticNotesFile: path.join(projectDir(dataDir, book.projectId), "notes", `${book.id}.json`),
      });
      fs.renameSync(publicStagingDir, finalPublicDir);
      publishedPublic = true;
      fs.renameSync(dataStagingDir, finalDataDir);
      publishedData = true;
    } catch (error) {
      removeIfPresent(dataStagingDir);
      removeIfPresent(publicStagingDir);
      if (publishedData) removeIfPresent(finalDataDir);
      if (publishedPublic) removeIfPresent(finalPublicDir);
      throw error;
    }
  }

  function registerMainBook({ projectId, title, sourceSnapshotId, sourceHtml, styleFingerprint = null, replace = false }) {
    const safeProjectId = assertId(projectId, "projectId");
    const existing = getBook(safeProjectId, "main");
    if (existing && !replace) throw new Error("main book already exists");
    const book = {
      id: "main",
      projectId: safeProjectId,
      kind: "main",
      title: assertTitle(title),
      parentBookId: null,
      originExplorationId: null,
      originAnswerMessageId: null,
      sourceSnapshotId: assertId(sourceSnapshotId, "sourceSnapshotId"),
      sourceRefs: [],
      sourceHtmlFile: "source.html",
      styleFingerprint: styleFingerprint || null,
      createdAt: now(),
    };

    if (existing && replace) {
      // 覆盖重生成：先备份旧目录，发布成功后清理，失败则恢复
      const dataBackup = `${dataBookDir(dataDir, safeProjectId, "main")}.backup-${now()}`;
      const publicBackup = `${publicBookDir(publicDir, safeProjectId, "main")}.backup-${now()}`;
      const fsMod = fs;
      const restore = () => {
        if (fsMod.existsSync(dataBackup)) fsMod.renameSync(dataBackup, dataBookDir(dataDir, safeProjectId, "main"));
        if (fsMod.existsSync(publicBackup)) fsMod.renameSync(publicBackup, publicBookDir(publicDir, safeProjectId, "main"));
      };
      if (fsMod.existsSync(dataBookDir(dataDir, safeProjectId, "main"))) {
        fsMod.renameSync(dataBookDir(dataDir, safeProjectId, "main"), dataBackup);
      }
      if (fsMod.existsSync(publicBookDir(publicDir, safeProjectId, "main"))) {
        fsMod.renameSync(publicBookDir(publicDir, safeProjectId, "main"), publicBackup);
      }
      try {
        publishBookAtomically({ book, sourceHtml });
        updateProjectMainBook(dataDir, safeProjectId);
        if (fsMod.existsSync(dataBackup)) fsMod.rmSync(dataBackup, { recursive: true, force: true });
        if (fsMod.existsSync(publicBackup)) fsMod.rmSync(publicBackup, { recursive: true, force: true });
        return book;
      } catch (error) {
        restore();
        throw error;
      }
    }

    publishBookAtomically({ book, sourceHtml });
    try {
      updateProjectMainBook(dataDir, safeProjectId);
      return book;
    } catch (error) {
      removeIfPresent(dataBookDir(dataDir, safeProjectId, "main"));
      removeIfPresent(publicBookDir(publicDir, safeProjectId, "main"));
      throw error;
    }
  }

  function growExplorationBook({
    projectId,
    sessionId,
    answerMessageId,
    title,
    answerMarkdown,
    sourceSnapshotId,
    sourceRefs,
    parentBookId = null,
  }) {
    const safeProjectId = assertId(projectId, "projectId");
    const safeSessionId = assertId(sessionId, "sessionId");
    const safeAnswerMessageId = assertId(answerMessageId, "answerMessageId");
    const existing = listBooks(safeProjectId).find((book) => (
      book.originExplorationId === safeSessionId && book.originAnswerMessageId === safeAnswerMessageId
    ));
    if (existing) return existing;

    const bookId = createSlugId(title, safeAnswerMessageId, (candidate) => Boolean(getBook(safeProjectId, candidate)));
    const safeSourceRefs = normalizeSourceRefs(sourceRefs);
    const book = {
      id: bookId,
      projectId: safeProjectId,
      kind: "exploration",
      title: assertTitle(title),
      parentBookId: parentBookId === null ? null : assertId(parentBookId, "parentBookId"),
      originExplorationId: safeSessionId,
      originAnswerMessageId: safeAnswerMessageId,
      sourceSnapshotId: assertId(sourceSnapshotId, "sourceSnapshotId"),
      sourceRefs: safeSourceRefs,
      sourceHtmlFile: "source.html",
      createdAt: now(),
    };
    const sourceHtml = createExplorationBookSource({
      title: book.title,
      answerMarkdown: String(answerMarkdown || ""),
      sourceRefs: safeSourceRefs,
    });

    publishBookAtomically({ book, sourceHtml });
    return book;
  }

  function touchBook(projectId, bookId) {
    const safeProjectId = assertId(projectId, "projectId");
    const safeBookId = assertId(bookId, "bookId");
    const metaFile = bookMetadataFile(dataDir, safeProjectId, safeBookId);
    const meta = readJson(metaFile, null);
    if (!meta) return null;
    const ts = now();
    writeJsonAtomic(metaFile, { ...meta, lastOpenedAt: ts });

    const manifestFile = path.join(projectDir(dataDir, safeProjectId), "project.json");
    const manifest = readJson(manifestFile, null);
    if (manifest) {
      writeJsonAtomic(manifestFile, { ...manifest, lastOpenedAt: ts });
      writeProjectIndex(dataDir, { ...manifest, lastOpenedAt: ts });
    }
    return { lastOpenedAt: ts };
  }

  return { getBook, listBooks, registerMainBook, growExplorationBook, touchBook };
}

export function importLegacyPupkit({ repoDir, dataDir, publicDir, projectId = "pupkit", bookId = "main" }) {
  const safeProjectId = assertId(projectId, "projectId");
  if (assertId(bookId, "bookId") !== "main") throw new Error("legacy PUPKIT book must be main");
  const sourceHtml = fs.readFileSync(path.join(repoDir, "public", "index.html"), "utf8");
  let project = readProject(dataDir, safeProjectId);

  if (!project) {
    project = importLocalProject({
      dataDir,
      projectId: safeProjectId,
      name: "PUPKIT",
      files: readLegacyFiles(path.join(dataDir, "pupkit", "files")),
    });
  }

  const legacyNotes = readJson(path.join(dataDir, "pupkit.json"), []);
  const notesFile = path.join(projectDir(dataDir, safeProjectId), "notes", "main.json");
  if (!fs.existsSync(notesFile)) writeJsonAtomic(notesFile, Array.isArray(legacyNotes) ? legacyNotes : []);

  const books = createBookStore({ dataDir, publicDir });
  const existing = books.getBook(safeProjectId, "main");
  if (existing) return existing;
  return books.registerMainBook({
    projectId: safeProjectId,
    title: "PUPKIT 前端代码解剖课",
    sourceSnapshotId: project.currentSnapshotId,
    sourceHtml,
  });
}
