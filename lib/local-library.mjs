import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertId } from "./ids.mjs";
import { httpError } from "./http.mjs";
import { readJson, writeJsonAtomic } from "./json-store.mjs";
import { listProjectSummaries, readProject, writeProjectIndex } from "./projects.mjs";

export const LIBRARY_LIMITS = Object.freeze({
  maxBytes: 128 * 1024 * 1024,
  maxFileBytes: 32 * 1024 * 1024,
  maxRequestBytes: 192 * 1024 * 1024,
  maxFiles: 50000,
});
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const bad = (message) => httpError("备份校验失败：" + message, 400, "invalid-backup");
const legacyIdPattern = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/;
const excluded = (segment) => segment === ".DS_Store" || segment === ".env" ||
  (segment.startsWith(".env.") && !/\.(example|sample|template)$/.test(segment)) ||
  segment === "tmp-import" || segment.startsWith(".staging-") || segment.startsWith(".restore-") || segment.includes(".tmp-");

function excludedPath(area, segments) {
  // Source snapshots are immutable user input. Names such as .env there are
  // project source, not this application's configuration or temporary files.
  const sourceStart = area === "data" && segments[0] === "projects" &&
    segments[2] === "source" && segments.length > 4 ? 4 : Infinity;
  if (sourceStart === 4) {
    strictId(segments[1]);
    strictId(segments[3]);
  }
  return segments.some((segment, index) => index < sourceStart && excluded(segment));
}

function safePath(value, area) {
  if (typeof value !== "string" || value.length > 1024 || /[\\:\x00-\x1f]/.test(value)) throw bad("文件路径不合法");
  const segments = value.split("/");
  if (segments.some((item) => !item || item === "." || item === "..") || excludedPath(area, segments)) throw bad("包含不允许的路径");
  return segments;
}

function strictId(value) {
  try { return assertId(value); } catch { throw bad("项目或资料标识不合法"); }
}

function lstatIfPresent(target) {
  try { return fs.lstatSync(target); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function assertNoSymlink(root, relative = "") {
  const resolvedRoot = path.resolve(root);
  if (lstatIfPresent(resolvedRoot)?.isSymbolicLink()) throw bad("资料目录不能是符号链接");
  let current = resolvedRoot;
  for (const segment of relative.split("/").filter(Boolean)) {
    current = path.join(current, segment);
    if (lstatIfPresent(current)?.isSymbolicLink()) throw bad("资料中包含符号链接");
  }
}

function validRestoreGroup(group) {
  if (!group || !["data", "public"].includes(group.area)) throw bad("恢复记录不合法");
  const parts = safePath(group.path);
  if (parts[0] === "projects" && parts.length === 2) return Boolean(strictId(parts[1]));
  if (group.area === "data" && parts.length === 1) {
    const id = parts[0].endsWith(".json") ? parts[0].slice(0, -5) : parts[0];
    if (legacyIdPattern.test(id) && id !== "projects") return true;
  }
  if (group.area === "public" && parts.length === 2 && parts[0] === "data" &&
      parts[1].endsWith(".json") && legacyIdPattern.test(parts[1].slice(0, -5))) return true;
  throw bad("恢复记录包含非资料路径");
}

function validateBackup(backup) {
  if (!backup || backup.format !== "vibe-shelf-library" || backup.version !== 1 ||
      !["library-backup", "project-backup"].includes(backup.kind) ||
      !Number.isFinite(backup.createdAt) || !Array.isArray(backup.projectIds) ||
      !Array.isArray(backup.legacyIds) || !Array.isArray(backup.projectIndex) || !Array.isArray(backup.files)) {
    throw bad("格式或版本不支持");
  }
  const { checksum, ...payload } = backup;
  if (typeof checksum !== "string" || sha(JSON.stringify(payload)) !== checksum) throw bad("整份备份校验和不符");
  const projectIds = new Set(backup.projectIds.map(strictId));
  const legacyIds = new Set(backup.legacyIds);
  if (projectIds.size !== backup.projectIds.length || legacyIds.size !== backup.legacyIds.length ||
      backup.legacyIds.some((id) => typeof id !== "string" || !legacyIdPattern.test(id))) throw bad("重复或非法资料标识");
  if (backup.projectIndex.some((item) => !item || typeof item !== "object" || !projectIds.has(item.id) || typeof item.name !== "string")) throw bad("项目索引格式不合法");
  if (backup.files.length > LIBRARY_LIMITS.maxFiles) throw httpError("备份文件数超过 50,000 上限。", 413, "too-large");
  const files = new Map();
  const foldedPaths = new Set();
  let total = 0;
  for (const entry of backup.files) {
    if (!entry || !["data", "public"].includes(entry.area) || entry.type !== "file" || entry.encoding !== "base64" ||
        typeof entry.data !== "string" || !Number.isSafeInteger(entry.size) || entry.size < 0) throw bad("文件类型或长度不合法");
    const segments = safePath(entry.path, entry.area);
    const [first, second, third] = segments;
    const isProject = first === "projects" && projectIds.has(second) && segments.length >= 3;
    const isLegacy = entry.area === "data"
      ? (segments.length === 1 && first.endsWith(".json") && legacyIds.has(first.slice(0, -5))) ||
        (legacyIds.has(first) && second === "files" && segments.length >= 3)
      : first === "data" && segments.length === 2 && second.endsWith(".json") && legacyIds.has(second.slice(0, -5));
    if (!isProject && !isLegacy) throw bad("文件不属于备份中的项目");
    if (entry.area === "public" && isProject && third !== "books") throw bad("已编译书的路径不合法");
    if (entry.size > LIBRARY_LIMITS.maxFileBytes || total + entry.size > LIBRARY_LIMITS.maxBytes ||
        entry.data.length > Math.ceil(LIBRARY_LIMITS.maxFileBytes / 3) * 4) {
      throw httpError("备份超过 128MB 总量或 32MB 单文件上限，请按项目分别导出。", 413, "too-large");
    }
    const bytes = Buffer.from(entry.data, "base64");
    if (bytes.length !== entry.size || bytes.toString("base64") !== entry.data || sha(bytes) !== entry.sha256) throw bad("文件内容校验和不符");
    const key = entry.area + "/" + entry.path;
    const folded = key.normalize("NFC").toLowerCase();
    if (foldedPaths.has(folded)) throw bad("文件路径重复");
    foldedPaths.add(folded);
    files.set(key, { ...entry, bytes });
    total += bytes.length;
  }
  const json = (key) => {
    const entry = files.get(key);
    if (!entry) throw bad("缺少必要资料：" + key);
    try { return JSON.parse(entry.bytes.toString("utf8")); } catch { throw bad("资料 JSON 已损坏：" + key); }
  };
  const manifests = [];
  const checkNotes = (key) => {
    const notes = json(key);
    if (!Array.isArray(notes) || notes.some((note) => !note || typeof note !== "object" || Array.isArray(note) ||
        typeof note.id !== "string" || !note.id)) throw bad("旁注格式不合法");
  };
  for (const id of projectIds) {
    const prefix = "data/projects/" + id + "/";
    const manifest = json(prefix + "project.json");
    if (!manifest || manifest.id !== id || typeof manifest.name !== "string" || !manifest.name.trim() ||
        (manifest.archived !== undefined && typeof manifest.archived !== "boolean")) throw bad("项目清单不合法");
    strictId(manifest.currentSnapshotId);
    const checkSnapshot = (snapshotId) => {
      strictId(snapshotId);
      const index = json(prefix + "file-index/" + snapshotId + ".json");
      if (!Array.isArray(index) || ![...files.keys()].some((key) => key.startsWith(prefix + "source/" + snapshotId + "/"))) throw bad("缺少源码快照");
      for (const item of index) {
        if (!item || typeof item.path !== "string" || typeof item.text !== "string" ||
            !Number.isInteger(item.startLine) || item.startLine < 1 || !Number.isInteger(item.endLine) || item.endLine < item.startLine ||
            !files.has(prefix + "source/" + snapshotId + "/" + item.path)) throw bad("源码索引与快照不一致");
      }
    };
    checkSnapshot(manifest.currentSnapshotId);
    for (const key of files.keys()) {
      if (key.startsWith(prefix + "books/") && key.endsWith("/book.json")) {
        const book = json(key);
        const bookId = key.slice((prefix + "books/").length).split("/")[0];
        if (!book || book.id !== bookId || book.projectId !== id || typeof book.title !== "string" ||
            !["main", "exploration"].includes(book.kind) || !files.has(prefix + "books/" + bookId + "/source.html") ||
            !files.has("public/projects/" + id + "/books/" + bookId + "/index.html")) throw bad("书的资料不完整");
        strictId(bookId);
        checkSnapshot(book.sourceSnapshotId);
      }
      if (key.startsWith(prefix + "notes/")) {
        if (key.endsWith(".deleted.json")) {
          const deleted = json(key);
          if (!deleted || typeof deleted !== "object" || Array.isArray(deleted) ||
              Object.entries(deleted).some(([noteId, revision]) => !noteId || !Number.isInteger(revision) || revision < 1)) throw bad("旁注删除记录格式不合法");
        } else checkNotes(key);
      }
      if (key.startsWith(prefix + "explorations/")) {
        const session = json(key);
        if (!session || session.projectId !== id || !Array.isArray(session.messages) ||
            session.messages.some((message) => !message || typeof message.id !== "string" ||
              !["user", "assistant"].includes(message.role) || typeof message.content !== "string" ||
              (message.role === "assistant" && !["pending", "complete", "failed"].includes(message.status)))) throw bad("探索格式不合法");
        strictId(session.id);
        checkSnapshot(session.sourceSnapshotId);
      }
    }
    if (manifest.mainBookId && !files.has(prefix + "books/" + strictId(manifest.mainBookId) + "/book.json")) throw bad("缺少项目主书");
    manifests.push(manifest);
  }
  for (const id of legacyIds) {
    if (files.has("data/" + id + ".json")) checkNotes("data/" + id + ".json");
    if (files.has("public/data/" + id + ".json")) checkNotes("public/data/" + id + ".json");
  }
  return { files, manifests, total };
}

export function createLocalLibrary({ dataDir, publicDir }) {
  const roots = { data: path.resolve(dataDir), public: path.resolve(publicDir) };
  const indexPath = path.join(roots.data, "projects.json");

  function rollback(transaction) {
    for (const group of [...transaction.published].reverse()) {
      validRestoreGroup(group);
      assertNoSymlink(roots[group.area], group.path);
      fs.rmSync(path.join(roots[group.area], group.path), { recursive: true, force: true });
    }
    if (transaction.indexBefore !== null) {
      const previous = JSON.parse(Buffer.from(transaction.indexBefore, "base64").toString("utf8"));
      if (!Array.isArray(previous)) throw bad("原资料索引已损坏");
      writeJsonAtomic(indexPath, previous);
    } else {
      fs.rmSync(indexPath, { force: true });
    }
  }

  // A killed process cannot run catch/finally. A small write-ahead journal
  // lets the next launch remove only this transaction's newly created roots.
  if (fs.existsSync(roots.data)) for (const entry of fs.readdirSync(roots.data, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\.restore-[0-9a-f-]{36}$/.test(entry.name)) continue;
    const transaction = readJson(path.join(roots.data, entry.name, "transaction.json"), null);
    if (transaction) {
      if (transaction.version !== 1 || transaction.token !== entry.name || !Array.isArray(transaction.published)) throw bad("恢复事务记录损坏");
      if (transaction.status !== "committed") rollback(transaction);
    }
    fs.rmSync(path.join(roots.data, entry.name), { recursive: true, force: true });
    fs.rmSync(path.join(roots.public, entry.name), { recursive: true, force: true });
  }

  function backup(projectId = null) {
    const projectIds = projectId ? [assertId(projectId)] : [...new Set([
      ...listProjectSummaries(dataDir).map((item) => item.id),
      ...(fs.existsSync(path.join(dataDir, "projects"))
      ? fs.readdirSync(path.join(dataDir, "projects"), { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => assertId(entry.name))
      : []),
    ])];
    const legacyIds = new Set();
    if (fs.existsSync(dataDir)) for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
      const id = entry.isFile() && entry.name.endsWith(".json") ? entry.name.slice(0, -5) : entry.name;
      if (id !== "projects" && legacyIdPattern.test(id) && (!projectId || id === projectId) &&
          ((entry.isFile() && entry.name.endsWith(".json")) || fs.existsSync(path.join(dataDir, id, "files")))) legacyIds.add(id);
    }
    const files = [];
    let total = 0;
    function add(area, relative) {
      const full = path.join(roots[area], relative);
      let stat;
      try { stat = fs.lstatSync(full); } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      assertNoSymlink(roots[area], relative);
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(full).sort()) {
          const child = relative + "/" + name;
          if (!excludedPath(area, child.split("/"))) add(area, child);
        }
        return;
      }
      if (!stat.isFile()) throw bad("不能备份特殊文件");
      safePath(relative, area);
      if (stat.size > LIBRARY_LIMITS.maxFileBytes || total + stat.size > LIBRARY_LIMITS.maxBytes || files.length >= LIBRARY_LIMITS.maxFiles) {
        throw httpError("资料超过备份上限（总量 128MB、单文件 32MB），请按项目分别导出。", 413, "too-large");
      }
      const bytes = fs.readFileSync(full);
      files.push({ area, path: relative, type: "file", encoding: "base64", size: bytes.length, sha256: sha(bytes), data: bytes.toString("base64") });
      total += bytes.length;
    }
    for (const id of projectIds) {
      if (!readProject(dataDir, id)) throw httpError("项目不存在或清单损坏：" + id, 404, "not-found");
      add("data", "projects/" + id);
      add("public", "projects/" + id);
    }
    for (const id of legacyIds) {
      add("data", id + ".json");
      add("data", id + "/files");
      add("public", "data/" + id + ".json");
    }
    const payload = {
      format: "vibe-shelf-library", version: 1, kind: projectId ? "project-backup" : "library-backup",
      createdAt: Date.now(), projectIds: projectIds.sort(), legacyIds: [...legacyIds].sort(),
      projectIndex: listProjectSummaries(dataDir).filter((item) => projectIds.includes(item.id)), files,
    };
    const result = { ...payload, checksum: sha(JSON.stringify(payload)) };
    validateBackup(result);
    return result;
  }

  function restore(input) {
    const { files, manifests, total } = validateBackup(input);
    assertNoSymlink(roots.data, "projects.json");
    const groups = new Map();
    for (const entry of files.values()) {
      const segments = entry.path.split("/");
      const relative = segments[0] === "projects" ? segments.slice(0, 2).join("/")
        : entry.area === "data" && segments.length > 1 ? segments[0] : entry.path;
      groups.set(entry.area + "/" + relative, { area: entry.area, path: relative });
    }
    const existing = new Set(listProjectSummaries(dataDir).map((item) => item.id));
    if (input.projectIds.some((id) => existing.has(id))) throw httpError("项目已存在，恢复只会新增项目。", 409, "restore-conflict");
    for (const group of groups.values()) {
      assertNoSymlink(roots[group.area], group.path);
      if (lstatIfPresent(path.join(roots[group.area], group.path))) throw httpError("资料已存在，未覆盖：" + group.path, 409, "restore-conflict");
    }
    const token = ".restore-" + crypto.randomUUID();
    const staging = { data: path.join(roots.data, token), public: path.join(roots.public, token) };
    const transaction = {
      version: 1, token, status: "preparing", published: [],
      indexBefore: fs.existsSync(indexPath) ? fs.readFileSync(indexPath).toString("base64") : null,
    };
    const journalPath = path.join(staging.data, "transaction.json");
    let cleanable = false;
    try {
      writeJsonAtomic(journalPath, transaction);
      for (const entry of files.values()) {
        const target = path.join(staging[entry.area], entry.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.bytes, { flag: "wx" });
      }
      // Everything is checked and staged before the first project becomes
      // visible. Synchronous commit prevents another request interleaving.
      for (const group of groups.values()) {
        validRestoreGroup(group);
        const target = path.join(roots[group.area], group.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        transaction.status = "publishing";
        transaction.published.push(group);
        writeJsonAtomic(journalPath, transaction);
        fs.renameSync(path.join(staging[group.area], group.path), target);
      }
      for (const manifest of manifests) writeProjectIndex(dataDir, manifest);
      transaction.status = "committed";
      writeJsonAtomic(journalPath, transaction);
      cleanable = true;
      return { ok: true, projectIds: input.projectIds, legacyIds: input.legacyIds, fileCount: files.size, bytes: total };
    } catch (error) {
      rollback(transaction);
      cleanable = true;
      throw error;
    } finally {
      if (cleanable) for (const target of Object.values(staging)) fs.rmSync(target, { recursive: true, force: true });
    }
  }

  function archive(projectId, archived) {
    const id = assertId(projectId);
    if (typeof archived !== "boolean") throw httpError("archived 必须为 true 或 false。", 400, "bad-request");
    const project = readProject(dataDir, id);
    if (!project) throw httpError("项目不存在。", 404, "not-found");
    const updated = { ...project, archived, updatedAt: Date.now() };
    writeJsonAtomic(path.join(dataDir, "projects", id, "project.json"), updated);
    return updated;
  }

  return { backup, restore, archive };
}
