import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildFileIndex } from "./file-index.mjs";
import { assertId, assertRelativePath, isInsideRoot } from "./ids.mjs";
import { writeJsonAtomic } from "./json-store.mjs";
import { projectDir, readProject, writeProjectIndex } from "./projects.mjs";

export const IMPORT_LIMITS = {
  maxFiles: 300,
  maxFileBytes: 100 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
};

function now() {
  return Date.now();
}

function assertProjectName(name) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 120) {
    throw new Error("invalid project name");
  }
  return name.trim();
}

function removeIfPresent(target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

function newSnapshotId(sourceRoot) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = `s-${now().toString(36)}-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
    if (!fs.existsSync(path.join(sourceRoot, id))) return id;
  }
  throw new Error("unable to create unique snapshot id");
}

function writeSnapshot(projectRoot, snapshotId, files) {
  const snapshotRoot = path.join(projectRoot, "source", snapshotId);
  fs.mkdirSync(snapshotRoot, { recursive: true });

  for (const file of files) {
    const target = path.resolve(snapshotRoot, file.path);
    if (!isInsideRoot(snapshotRoot, target)) throw new Error("invalid relative path");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, "utf8");
  }
}

function writeSnapshotIndex(projectRoot, snapshotId, files) {
  writeJsonAtomic(
    path.join(projectRoot, "file-index", `${snapshotId}.json`),
    buildFileIndex(files),
  );
}

function newManifest({ projectId, name, snapshotId, readingIntent, readingFocus = "", createdAt = now() }) {
  return {
    id: projectId,
    name,
    sourceType: "local",
    readingIntent,
    ...(readingFocus ? { readingFocus } : {}),
    currentSnapshotId: snapshotId,
    mainBookId: null,
    createdAt,
    updatedAt: createdAt,
  };
}

export function validateImportFiles(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > IMPORT_LIMITS.maxFiles) {
    throw new Error(`导入文件数量不合法（1–${IMPORT_LIMITS.maxFiles} 个）`);
  }

  let totalBytes = 0;
  const paths = new Set();
  return files.map((file) => {
    const safePath = assertRelativePath(file?.path);
    if (paths.has(safePath)) throw new Error(`导入文件里有重复路径：${safePath}`);
    paths.add(safePath);

    if (typeof file?.content !== "string" || file.content.includes("\0")) {
      throw new Error(`不是可导入的文本文件：${safePath}`);
    }
    const bytes = Buffer.byteLength(file.content);
    if (bytes > IMPORT_LIMITS.maxFileBytes) {
      throw new Error(`文件太大（超过 ${Math.round(IMPORT_LIMITS.maxFileBytes / 1024)}KB）：${safePath}`);
    }
    totalBytes += bytes;
    if (totalBytes > IMPORT_LIMITS.maxTotalBytes) {
      throw new Error(`导入总量超过 ${Math.round(IMPORT_LIMITS.maxTotalBytes / 1024 / 1024)}MB 上限`);
    }
    return { path: safePath, content: file.content };
  });
}

export function importLocalProject({ dataDir, projectId, name, files, readingIntent = 'overview', readingFocus = '' }) {
  const safeProjectId = assertId(projectId, "projectId");
  const safeName = assertProjectName(name);
  const validatedFiles = validateImportFiles(files);
  const finalProjectDir = projectDir(dataDir, safeProjectId);
  if (fs.existsSync(finalProjectDir)) throw new Error("project already exists");

  const projectsDir = path.dirname(finalProjectDir);
  const snapshotId = newSnapshotId(path.join(finalProjectDir, "source"));
  const stagingDir = path.join(projectsDir, `.staging-${safeProjectId}-${now()}`);
  const manifest = newManifest({ projectId: safeProjectId, name: safeName, snapshotId, readingIntent, readingFocus });
  let committed = false;

  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    writeSnapshot(stagingDir, snapshotId, validatedFiles);
    writeSnapshotIndex(stagingDir, snapshotId, validatedFiles);
    writeJsonAtomic(path.join(stagingDir, "project.json"), manifest);
    fs.renameSync(stagingDir, finalProjectDir);
    committed = true;
    writeProjectIndex(dataDir, manifest);
    return manifest;
  } catch (error) {
    removeIfPresent(stagingDir);
    if (committed) removeIfPresent(finalProjectDir);
    throw error;
  }
}

export function refreshSnapshot({ dataDir, projectId, files }) {
  const safeProjectId = assertId(projectId, "projectId");
  const validatedFiles = validateImportFiles(files);
  const finalProjectDir = projectDir(dataDir, safeProjectId);
  const originalManifest = readProject(dataDir, safeProjectId);
  if (!originalManifest) throw new Error("project not found");

  const snapshotId = newSnapshotId(path.join(finalProjectDir, "source"));
  const stagingDir = path.join(finalProjectDir, `.staging-${snapshotId}`);
  const nextManifest = {
    ...originalManifest,
    currentSnapshotId: snapshotId,
    updatedAt: now(),
  };
  const finalSnapshotDir = path.join(finalProjectDir, "source", snapshotId);
  const finalIndexFile = path.join(finalProjectDir, "file-index", `${snapshotId}.json`);
  let movedSnapshot = false;
  let movedIndex = false;
  let rewroteManifest = false;

  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    writeSnapshot(stagingDir, snapshotId, validatedFiles);
    writeSnapshotIndex(stagingDir, snapshotId, validatedFiles);
    fs.mkdirSync(path.dirname(finalSnapshotDir), { recursive: true });
    fs.mkdirSync(path.dirname(finalIndexFile), { recursive: true });
    fs.renameSync(path.join(stagingDir, "source", snapshotId), finalSnapshotDir);
    movedSnapshot = true;
    fs.renameSync(path.join(stagingDir, "file-index", `${snapshotId}.json`), finalIndexFile);
    movedIndex = true;
    writeJsonAtomic(path.join(finalProjectDir, "project.json"), nextManifest);
    rewroteManifest = true;
    writeProjectIndex(dataDir, nextManifest);
    return nextManifest;
  } catch (error) {
    if (rewroteManifest) writeJsonAtomic(path.join(finalProjectDir, "project.json"), originalManifest);
    if (movedIndex) removeIfPresent(finalIndexFile);
    if (movedSnapshot) removeIfPresent(finalSnapshotDir);
    throw error;
  } finally {
    removeIfPresent(stagingDir);
  }
}
