// 主书生成任务：上传项目后，后台按 Skill 式 prompt（经模型客户端）生成主书 HTML。
// 状态机：generating(reading → writing) → ready | failed；任务文件 data/projects/<id>/generation.json
import path from "node:path";
import { httpError } from "./http.mjs";
import { IMPORT_LIMITS } from "./imports.mjs";
import { readJson, writeJsonAtomic } from "./json-store.mjs";
import { buildMainBookPrompt, extractStyleFingerprint, lintBookSafety, lintSkinTokens } from "./prompts.mjs";
import { TEXT_EXTENSIONS } from "./snapshot-files.mjs";

// 单文件上限对齐导入闸门（IMPORT_LIMITS.maxFileBytes）——当前值下这条永远不会触发，
// 因为比它大的文件根本进不了快照。留着是给"导入闸门被调大"那一天兜底：
// 没有它，一个超大文件就能把整个预算吃掉。
const FILE_LIMIT = IMPORT_LIMITS.maxFileBytes;

// 总量预算按模型上下文折算：2.5MB 对应 1M token 上下文，并留出输出余量。
// 折算按最坏情况 3 字节/token（中文密排约 1 token/字，UTF-8 下 3 字节/字）——
// 宁可少喂一点，也不要让请求因超长被上游拒绝。
// 换成上下文更小的模型（如 128K 的 gpt-4o-mini）必须调小。
const DEFAULT_TOTAL_LIMIT = 2.5 * 1024 * 1024;

// 主书是几万字的输出，本身就是分钟级；交互式旁注的 120 秒在这里必然误杀。
const GENERATION_TIMEOUT_MS = 15 * 60 * 1000;

// 预算不够喂全量时，先喂最有价值的：根 README → 清单文件 → 代码 → 其他文档 →
// 语言变体（.ja.md、docs/ja/… 这类多语言副本，砍掉损失最小）。
const LANGUAGE_VARIANT_SEGMENTS = new Set(["ja", "ko", "ru", "fr", "de", "es", "pt", "it", "ar", "hi", "th", "vi", "id", "tr", "pl", "nl"]);
const LANGUAGE_VARIANT_SUFFIX = /[.\-](ja|ko|ru|fr|de|es|pt|it|ar|hi|th|vi|id|tr|pl|nl)(\.|$)/i;
const MANIFEST_NAMES = new Set([
  "package.json", "requirements.txt", "pyproject.toml", "cargo.toml", "go.mod",
  "pom.xml", "build.gradle", "composer.json", "gemfile", "makefile", "dockerfile",
  "tsconfig.json", "docker-compose.yml",
]);
const CODE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".sh",
  ".sql", ".vue", ".svelte",
]);

function promptPriority(filePath) {
  const segments = filePath.split("/");
  const name = segments[segments.length - 1].toLowerCase();
  if (segments.slice(0, -1).some((segment) => LANGUAGE_VARIANT_SEGMENTS.has(segment.toLowerCase()))) return 9;
  if (LANGUAGE_VARIANT_SUFFIX.test(name)) return 9;
  if (segments.length === 1 && /^readme(\.[a-z-]+)?\.md$/i.test(name)) return 0;
  if (MANIFEST_NAMES.has(name)) return 1;
  if (CODE_EXTENSIONS.has(path.extname(name))) return 2;
  return 3;
}

function readTotalLimit(environment) {
  const raw = Number(environment.SHELF_PROMPT_BUDGET_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TOTAL_LIMIT;
}

export function createMainBookGeneration({ dataDir, books, modelClient, projects, environment = process.env }) {
  if (!books || !modelClient || !projects) {
    throw new Error("main book generation requires books/modelClient/projects");
  }
  const totalLimit = readTotalLimit(environment);

  function generationFile(projectId) {
    return path.join(dataDir, "projects", projectId, "generation.json");
  }

  function read(projectId) {
    const data = readJson(generationFile(projectId), null);
    if (!data) return { status: "idle", stage: null, error: null, bookId: null };
    return data;
  }

  function write(projectId, patch) {
    const current = readJson(generationFile(projectId), {});
    writeJsonAtomic(generationFile(projectId), { ...current, ...patch, updatedAt: Date.now() });
  }

  function stripCodeFence(text) {
    const trimmed = String(text).trim();
    const match = trimmed.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```\s*$/);
    return (match ? match[1] : trimmed).trim();
  }

  // 预算有限，必然有文件进不了 prompt——但"进了哪些、丢了多少"必须能报给用户，
  // 否则主书缺了半本书而界面上一片正常。非文本文件不算损失，单独计数。
  function collectSnapshotFiles(projectId, snapshotId) {
    const listed = [...projects.getSnapshotFiles(projectId, snapshotId)].sort((left, right) => (
      promptPriority(left.path) - promptPriority(right.path)
      || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    ));
    const files = [];
    let total = 0;
    const skipped = { nonText: 0, tooLarge: 0, overBudget: 0, unreadable: 0 };
    for (const entry of listed) {
      const extension = path.extname(entry.path).toLowerCase();
      if (extension && !TEXT_EXTENSIONS.has(extension)) { skipped.nonText += 1; continue; }
      if (entry.size > FILE_LIMIT) { skipped.tooLarge += 1; continue; }
      if (total + entry.size > totalLimit) { skipped.overBudget += 1; continue; }
      try {
        const file = projects.getSnapshotFile(projectId, snapshotId, entry.path);
        files.push({ path: file.path, content: file.content });
        total += entry.size;
      } catch {
        skipped.unreadable += 1;
      }
    }
    return { files, totalBytes: total, skipped };
  }

  function collectUsedStyleFingerprints() {
    try {
      const fingerprints = [];
      for (const project of projects.listSummaries()) {
        for (const book of books.listBooks(project.id)) {
          if (book?.styleFingerprint) fingerprints.push(book.styleFingerprint);
        }
      }
      return fingerprints;
    } catch {
      return [];
    }
  }

  async function run({ projectId, name, snapshotId, replace }) {
    try {
      write(projectId, { status: "generating", stage: "reading", startedAt: Date.now() });
      const { files, totalBytes, skipped } = collectSnapshotFiles(projectId, snapshotId);
      if (!files.length) throw httpError("快照里没有可读的文本源码文件，无法生成主书", 400, "no-source");

      write(projectId, { status: "generating", stage: "writing" });
      const usedStyles = collectUsedStyleFingerprints();
      const prompt = buildMainBookPrompt({ name, files, usedStyles });
      const raw = await modelClient.complete({
        prompt,
        maxTokens: 16000,
        temperature: 0.5,
        timeoutMs: GENERATION_TIMEOUT_MS,
      });
      const sourceHtml = stripCodeFence(raw);
      const lint = lintSkinTokens(sourceHtml);
      if (!lint.ok) {
        console.warn(`[skin-tokens] ${name} 主书缺 token: ${lint.missing.join(", ")}（夜间模式会漏底色）`);
      }
      const risky = lintBookSafety(sourceHtml);
      if (risky.length) {
        console.warn(`[book-safety] ${name} 主书含可疑标签：${risky.join(", ")}（发布到 Pages 前先人工确认）`);
      }

      const book = books.registerMainBook({
        projectId,
        title: `${name} · 项目主书`,
        sourceSnapshotId: snapshotId,
        sourceHtml,
        styleFingerprint: extractStyleFingerprint(sourceHtml),
        replace,
      });
      write(projectId, {
        status: "ready",
        stage: null,
        bookId: book.id,
        error: null,
        skinWarnings: lint.ok ? null : lint.missing,
        sourceCoverage: {
          included: files.length,
          includedBytes: totalBytes,
          skippedTooLarge: skipped.tooLarge,
          skippedOverBudget: skipped.overBudget,
          skippedUnreadable: skipped.unreadable,
        },
      });
    } catch (error) {
      write(projectId, {
        status: "failed",
        stage: null,
        bookId: null,
        error: error?.message || String(error),
        sourceCoverage: null,
      });
    }
  }

  function start({ projectId, replace = false }) {
    const project = projects.requireProjectById(projectId);
    const current = read(projectId);
    if (current.status === "generating") {
      throw httpError("主书正在生成中，请等待完成", 409, "generation-running");
    }
    write(projectId, {
      status: "generating",
      stage: "reading",
      error: null,
      bookId: null,
      sourceCoverage: null, // 上一轮的覆盖率不能留到这一轮
      startedAt: Date.now(),
    });
    // 异步执行；HTTP 响应先返回任务状态
    run({
      projectId,
      name: project.name,
      snapshotId: project.currentSnapshotId,
      replace,
    }).catch(() => {});
    return read(projectId);
  }

  return { read, start };
}
