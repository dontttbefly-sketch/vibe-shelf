import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createBookStore } from "./books.mjs";
import { createExplorationStore } from "./explorations.mjs";
import { isInsideRoot } from "./ids.mjs";
import { readJson, writeJsonAtomic } from "./json-store.mjs";
import { httpError, readJsonBody, safeStaticPath, sendJson } from "./http.mjs";
import { createNotesStore } from "./notes-store.mjs";
import { createProjectService } from "./project-service.mjs";
import { createMainBookGeneration } from "./main-book-generation.mjs";
import {
  buildExplorationPrompt,
  buildFollowupPrompt,
  buildNotePrompt,
  buildSearchPrompt,
  buildSuggestionsPrompt,
} from "./prompts.mjs";

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};
const LEGACY_FILE_LIMIT = 100 * 1024;

function safeLegacyBook(book) {
  return /^[\w-]+$/.test(book || "") ? book : "book";
}

function createLegacyNotesStore({ dataDir }) {
  const file = (book) => path.join(dataDir, `${safeLegacyBook(book)}.json`);
  return {
    list(book) {
      const notes = readJson(file(book), []);
      return Array.isArray(notes) ? notes : [];
    },
    upsert(book, note) {
      const notes = this.list(book);
      const index = notes.findIndex((item) => item.id === note.id);
      if (index >= 0) notes[index] = note;
      else notes.push(note);
      writeJsonAtomic(file(book), notes);
      return notes;
    },
    remove(book, noteId) {
      const notes = this.list(book).filter((note) => note.id !== noteId);
      writeJsonAtomic(file(book), notes);
      return notes;
    },
  };
}

function legacyFilesRoot(dataDir, book) {
  return path.join(dataDir, safeLegacyBook(book), "files");
}

function listLegacyFiles(dataDir, book) {
  const root = legacyFilesRoot(dataDir, book);
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (directory, prefix = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath, relative);
      else if (entry.isFile()) files.push({ path: relative, size: entry.size });
    }
  };
  visit(root);
  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function readLegacyFile(dataDir, book, relativePath) {
  if (typeof relativePath !== "string" || !relativePath) return null;
  const root = legacyFilesRoot(dataDir, book);
  const file = path.resolve(root, relativePath);
  if (!isInsideRoot(root, file) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return null;
  const size = fs.statSync(file).size;
  if (size > LEGACY_FILE_LIMIT) return { path: relativePath, tooLarge: true, size };
  return { path: relativePath, content: fs.readFileSync(file, "utf8") };
}

function sendError(res, error) {
  sendJson(res, error.statusCode || 500, {
    error: {
      kind: error.kind || "server",
      message: error.message || String(error),
    },
  });
}

function projectError(error) {
  if (error?.statusCode) return error;
  const message = error?.message || String(error);
  if (/not found|不存在|路径非法|snapshot file/i.test(message)) {
    return httpError(message, 404, "not-found");
  }
  if (/already exists/i.test(message)) return httpError(message, 409, "conflict");
  if (/invalid|duplicate|missing|too large|exceeds|找不到 <style>|定位 body|书页 HTML/i.test(message)) {
    return httpError(message, 400, "bad-request");
  }
  return error;
}

function projectOperation(operation) {
  try {
    return operation();
  } catch (error) {
    throw projectError(error);
  }
}

async function projectAsyncOperation(operation) {
  try {
    return await operation();
  } catch (error) {
    throw projectError(error);
  }
}

function sourceFilesForPrompt(chunks) {
  return chunks.map((chunk) => ({
    path: `${chunk.path}:${chunk.startLine}-${chunk.endLine}`,
    content: chunk.text,
  }));
}

async function complete(modelClient, prompt) {
  if (!modelClient || typeof modelClient.complete !== "function") {
    throw httpError("模型服务不可用", 503, "model-unavailable");
  }
  return modelClient.complete({ prompt, maxTokens: 4000, temperature: 0.6 });
}

function parseSearchContent(content) {
  const clean = String(content || "").replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  let parsed = null;
  try {
    parsed = JSON.parse(clean);
  } catch {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(clean.slice(start, end + 1));
      } catch {}
    }
  }
  if (!parsed || typeof parsed !== "object") parsed = { answer: clean };
  const matchType = ["exact", "partial", "none"].includes(parsed.matchType) ? parsed.matchType : "partial";
  const jumpIndex = Number.isInteger(parsed.jumpIndex) ? parsed.jumpIndex : null;
  return {
    matchType,
    jumpIndex,
    jumpTitle: typeof parsed.jumpTitle === "string" ? parsed.jumpTitle : "",
    answer: typeof parsed.answer === "string" ? parsed.answer : clean,
  };
}

async function routeRequest({
  req,
  res,
  dataDir,
  publicDir,
  modelClient,
  legacyNotes,
  projectNotes,
  projects,
  explorations,
  mainBookGeneration,
  books,
}) {
  const url = new URL(req.url, "http://localhost");
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw httpError("invalid URL path", 400, "bad-request");
  }

  if (pathname === "/api/explain" && req.method === "POST") {
    const input = await readJsonBody(req);
    const content = await complete(modelClient, buildNotePrompt(input));
    return sendJson(res, 200, { content });
  }

  if (pathname === "/api/followup" && req.method === "POST") {
    const input = await readJsonBody(req);
    const content = await complete(modelClient, buildFollowupPrompt(input));
    return sendJson(res, 200, { content });
  }

  if (pathname === "/api/search" && req.method === "POST") {
    const input = await readJsonBody(req);
    const content = await complete(modelClient, buildSearchPrompt(input));
    return sendJson(res, 200, parseSearchContent(content));
  }

  if (pathname === "/api/notes" && req.method === "GET") {
    return sendJson(res, 200, legacyNotes.list(url.searchParams.get("book") || "pupkit"));
  }

  if (pathname === "/api/notes" && req.method === "POST") {
    const { book, note } = await readJsonBody(req);
    if (!note || !note.id) throw httpError("缺少 note.id", 400, "bad-request");
    return sendJson(res, 200, { ok: true, notes: legacyNotes.upsert(book, note) });
  }

  if (pathname === "/api/notes" && req.method === "DELETE") {
    return sendJson(res, 200, {
      ok: true,
      notes: legacyNotes.remove(url.searchParams.get("book") || "pupkit", url.searchParams.get("id")),
    });
  }

  if (pathname === "/api/files" && req.method === "GET") {
    return sendJson(res, 200, { files: listLegacyFiles(dataDir, url.searchParams.get("book") || "pupkit") });
  }

  if (pathname === "/api/file" && req.method === "GET") {
    const result = readLegacyFile(dataDir, url.searchParams.get("book") || "pupkit", url.searchParams.get("path") || "");
    if (!result) throw httpError("文件不存在或路径非法", 404, "not-found");
    return sendJson(res, 200, result);
  }

  if (pathname === "/api/projects" && req.method === "GET") {
    return sendJson(res, 200, {
      projects: projectOperation(() => projects.listSummaries()).map((project) => ({
        ...project,
        generationStatus: mainBookGeneration.read(project.id).status,
      })),
    });
  }

  if (pathname === "/api/projects/import" && req.method === "POST") {
    const input = await readJsonBody(req);
    // 两条路径：自带主书 HTML（兼容旧流程）或不带主书 → 后台异步生成（新决策）
    if (input.mainBook && typeof input.mainBook === "object") {
      const project = projectOperation(() => projects.importWithMainBook(input));
      return sendJson(res, 201, { project, generation: null });
    }
    const project = projectOperation(() => projects.importProjectFiles(input));
    const generation = projectOperation(() => mainBookGeneration.start({ projectId: project.id, replace: false }));
    return sendJson(res, 201, { project, generation });
  }

  const generationMatch = pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/generation$/);
  if (generationMatch && req.method === "GET") {
    projectOperation(() => projects.requireProjectById(generationMatch[1]));
    return sendJson(res, 200, { generation: mainBookGeneration.read(generationMatch[1]) });
  }
  if (generationMatch && req.method === "POST") {
    const generation = await projectAsyncOperation(() => {
      projects.requireProjectById(generationMatch[1]);
      return mainBookGeneration.start({ projectId: generationMatch[1], replace: true });
    });
    return sendJson(res, 200, { generation });
  }

  let match = pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/books\/([a-z0-9-]+)\/notes$/);
  if (match) {
    const [, projectId, bookId] = match;
    projectOperation(() => projects.getBook(projectId, bookId));
    if (req.method === "GET") {
      // 阅读页打开 = 一次"继续阅读"的上报
      projectOperation(() => books.touchBook(projectId, bookId));
      return sendJson(res, 200, projectNotes.list(projectId, bookId));
    }
    if (req.method === "POST") {
      const { note } = await readJsonBody(req);
      if (!note?.id) throw httpError("缺少 note.id", 400, "bad-request");
      return sendJson(res, 200, { ok: true, notes: projectNotes.upsert(projectId, bookId, note) });
    }
    if (req.method === "DELETE") {
      const noteId = url.searchParams.get("id");
      if (!noteId) throw httpError("缺少 note id", 400, "bad-request");
      return sendJson(res, 200, { ok: true, notes: projectNotes.remove(projectId, bookId, noteId) });
    }
  }

  match = pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/books\/([a-z0-9-]+)\/(explain|followup)$/);
  if (match && req.method === "POST") {
    const [, projectId, bookId, action] = match;
    const input = await readJsonBody(req);
    const query = input.question || input.instruction || input.selection || input.quote || input.blockText || "";
    const context = projectOperation(() => projects.getBookContext(projectId, bookId, query));
    const promptInput = { ...input, files: sourceFilesForPrompt(context.chunks) };
    const content = await complete(
      modelClient,
      action === "explain" ? buildNotePrompt(promptInput) : buildFollowupPrompt(promptInput),
    );
    return sendJson(res, 200, { content, sourceRefs: context.sourceRefs });
  }

  match = pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/exploration-suggestions$/);
  if (match && req.method === "GET") {
    const suggestions = await projectAsyncOperation(() => explorations.listSuggestions(match[1]));
    return sendJson(res, 200, { suggestions });
  }

  match = pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/explorations$/);
  if (match && req.method === "POST") {
    const input = await readJsonBody(req);
    const session = projectOperation(() => explorations.createSession({ projectId: match[1], ...input }));
    return sendJson(res, 201, { session });
  }
  if (match && req.method === "GET") {
    return sendJson(res, 200, { sessions: projectOperation(() => explorations.listSessions(match[1])) });
  }

  match = pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/explorations\/([a-z0-9-]+)\/messages\/([a-z0-9-]+)\/retry$/);
  if (match && req.method === "POST") {
    const assistantMessage = await projectAsyncOperation(() => explorations.retryMessage({
      projectId: match[1],
      sessionId: match[2],
      messageId: match[3],
    }));
    return sendJson(res, 200, { assistantMessage });
  }

  match = pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/explorations\/([a-z0-9-]+)\/messages$/);
  if (match && req.method === "POST") {
    const { prompt } = await readJsonBody(req);
    const assistantMessage = await projectAsyncOperation(() => explorations.appendQuestion({
      projectId: match[1],
      sessionId: match[2],
      prompt,
    }));
    return sendJson(res, 200, { assistantMessage });
  }

  match = pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/explorations\/([a-z0-9-]+)\/books$/);
  if (match && req.method === "POST") {
    const { answerMessageId, title, parentBookId } = await readJsonBody(req);
    const book = projectOperation(() => explorations.growAnswerIntoBook({
      projectId: match[1],
      sessionId: match[2],
      answerMessageId,
      title,
      parentBookId,
    }));
    return sendJson(res, 201, { book: { ...book, url: projects.bookUrl(book.projectId, book.id) } });
  }

  match = pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/explorations\/([a-z0-9-]+)$/);
  if (match && req.method === "GET") {
    return sendJson(res, 200, { session: projectOperation(() => explorations.getSession(match[1], match[2])) });
  }

  match = pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/snapshots$/);
  if (match && req.method === "POST") {
    const input = await readJsonBody(req);
    const project = projectOperation(() => projects.refreshProjectSnapshot(match[1], input.files));
    return sendJson(res, 201, { project });
  }

  match = pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/snapshots\/([a-z0-9-]+)\/files$/);
  if (match && req.method === "GET") {
    try {
      return sendJson(res, 200, { files: projects.getSnapshotFiles(match[1], match[2]) });
    } catch {
      throw httpError("文件不存在或路径非法", 404, "not-found");
    }
  }

  match = pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/snapshots\/([a-z0-9-]+)\/file$/);
  if (match && req.method === "GET") {
    try {
      return sendJson(res, 200, projects.getSnapshotFile(match[1], match[2], url.searchParams.get("path") || ""));
    } catch {
      throw httpError("文件不存在或路径非法", 404, "not-found");
    }
  }

  match = pathname.match(/^\/api\/projects\/([a-z0-9-]+)$/);
  if (match && req.method === "GET") {
    const view = projectOperation(() => projects.getProjectView(match[1]));
    return sendJson(res, 200, {
      ...view,
      recentExplorations: projectOperation(() => explorations.listSessions(match[1]).slice(0, 6)),
    });
  }

  const staticPath = safeStaticPath(publicDir, pathname);
  const file = staticPath && fs.existsSync(staticPath) && fs.statSync(staticPath).isDirectory()
    ? path.join(staticPath, "index.html")
    : staticPath;
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404");
    return;
  }
  const extension = path.extname(file).toLowerCase();
  res.writeHead(200, { "content-type": MIME[extension] || "application/octet-stream" });
  res.end(fs.readFileSync(file));
}

export function createShelfServer({ dataDir, publicDir, modelClient }) {
  const legacyNotes = createLegacyNotesStore({ dataDir });
  const projectNotes = createNotesStore({ dataDir });
  const books = createBookStore({ dataDir, publicDir });
  const projects = createProjectService({ dataDir, publicDir, books });
  const mainBookGeneration = createMainBookGeneration({ dataDir, books, modelClient, projects });
  const explorations = createExplorationStore({
    dataDir,
    books,
    retrieveForSnapshot: ({ projectId, snapshotId, query, maxChunks }) => (
      projects.getSnapshotContext(projectId, snapshotId, query, maxChunks)
    ),
    modelClient,
    prompts: { buildExplorationPrompt, buildSuggestionsPrompt },
  });
  return http.createServer(async (req, res) => {
    try {
      await routeRequest({
        req,
        res,
        dataDir,
        publicDir,
        modelClient,
        legacyNotes,
        projectNotes,
        projects,
        explorations,
        mainBookGeneration,
        books,
      });
    } catch (error) {
      sendError(res, error);
    }
  });
}
