import fs from "node:fs";
import path from "node:path";
import { assertId } from "./ids.mjs";
import { readJson, writeJsonAtomic } from "./json-store.mjs";

function projectsIndexFile(dataDir) {
  return path.join(dataDir, "projects.json");
}

function projectManifestFile(dataDir, projectId) {
  return path.join(projectDir(dataDir, projectId), "project.json");
}

function recentActivity(item) {
  return Number(item.lastOpenedAt || item.updatedAt || item.createdAt || 0);
}

function compareProjectSummaries(left, right) {
  // 首页排序：最近"打开"优先，其次最近更新
  const openDifference = recentActivity(right) - recentActivity(left);
  if (openDifference !== 0) return openDifference;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function toSummary(manifest) {
  const id = assertId(manifest?.id, "projectId");
  return {
    id,
    name: String(manifest.name || id),
    sourceType: manifest.sourceType || "local",
    currentSnapshotId: manifest.currentSnapshotId || null,
    mainBookId: manifest.mainBookId || null,
    lastOpenedAt: Number(manifest.lastOpenedAt || 0),
    createdAt: Number(manifest.createdAt || 0),
    updatedAt: Number(manifest.updatedAt || 0),
  };
}

export function projectDir(dataDir, projectId) {
  return path.join(dataDir, "projects", assertId(projectId, "projectId"));
}

export function readProject(dataDir, projectId) {
  return readJson(projectManifestFile(dataDir, projectId), null);
}

export function writeProjectIndex(dataDir, manifest) {
  const current = readJson(projectsIndexFile(dataDir), []);
  if (!Array.isArray(current)) throw new Error("invalid projects index");

  const summary = toSummary(manifest);
  const next = current.filter((item) => item?.id !== summary.id);
  next.push(summary);
  next.sort(compareProjectSummaries);
  writeJsonAtomic(projectsIndexFile(dataDir), next);
  return summary;
}

export function removeProjectIndex(dataDir, projectId) {
  const safeProjectId = assertId(projectId, "projectId");
  const current = readJson(projectsIndexFile(dataDir), []);
  if (!Array.isArray(current)) throw new Error("invalid projects index");
  const next = current.filter((item) => item?.id !== safeProjectId).map(toSummary).sort(compareProjectSummaries);
  writeJsonAtomic(projectsIndexFile(dataDir), next);
  return next;
}

export function listProjectSummaries(dataDir) {
  const current = readJson(projectsIndexFile(dataDir), null);
  if (current !== null && !Array.isArray(current)) throw new Error("invalid projects index");
  if (Array.isArray(current) && current.length) return current.map(toSummary).sort(compareProjectSummaries);

  const directory = path.join(dataDir, "projects");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => readJson(path.join(directory, entry.name, "project.json"), null))
    .filter(Boolean)
    .map(toSummary)
    .sort(compareProjectSummaries);
}
