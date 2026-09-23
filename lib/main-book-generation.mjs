// 主书生成任务：上传项目后，后台按 Skill 式 prompt（经模型客户端）生成主书 HTML。
// 状态机：generating(reading → writing) → ready | failed；任务文件 data/projects/<id>/generation.json
import path from "node:path";
import { httpError } from "./http.mjs";
import { readJson, writeJsonAtomic } from "./json-store.mjs";
import { buildMainBookPrompt } from "./prompts.mjs";

const FILE_LIMIT = 60 * 1024;       // 单文件进 prompt 的上限
const TOTAL_LIMIT = 240 * 1024;     // 全部材料进 prompt 的上限
const TEXT_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".html", ".htm", ".css",
  ".md", ".txt", ".yml", ".yaml", ".toml", ".py", ".rb", ".go", ".rs", ".java",
  ".kt", ".swift", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".sh", ".sql",
  ".vue", ".svelte", ".scss", ".less", ".xml",
]);

export function createMainBookGeneration({ dataDir, books, modelClient, projects }) {
  if (!books || !modelClient || !projects) {
    throw new Error("main book generation requires books/modelClient/projects");
  }

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

  function collectSnapshotFiles(projectId, snapshotId) {
    const listed = projects.getSnapshotFiles(projectId, snapshotId);
    const files = [];
    let total = 0;
    let omitted = 0;
    for (const entry of listed) {
      const extension = path.extname(entry.path).toLowerCase();
      if (extension && !TEXT_EXTENSIONS.has(extension)) { omitted += 1; continue; }
      if (entry.size > FILE_LIMIT) { omitted += 1; continue; }
      if (total + entry.size > TOTAL_LIMIT) { omitted += 1; continue; }
      try {
        const file = projects.getSnapshotFile(projectId, snapshotId, entry.path);
        files.push({ path: file.path, content: file.content });
        total += entry.size;
      } catch {
        omitted += 1;
      }
    }
    return { files, omitted };
  }

  async function run({ projectId, name, snapshotId, replace }) {
    try {
      write(projectId, { status: "generating", stage: "reading", startedAt: Date.now() });
      const { files } = collectSnapshotFiles(projectId, snapshotId);
      if (!files.length) throw httpError("快照里没有可读的文本源码文件，无法生成主书", 400, "no-source");

      write(projectId, { status: "generating", stage: "writing" });
      const prompt = buildMainBookPrompt({ name, files });
      const raw = await modelClient.complete({ prompt, maxTokens: 16000, temperature: 0.5 });
      const sourceHtml = stripCodeFence(raw);

      const book = books.registerMainBook({
        projectId,
        title: `${name} · 项目主书`,
        sourceSnapshotId: snapshotId,
        sourceHtml,
        replace,
      });
      write(projectId, { status: "ready", stage: null, bookId: book.id, error: null });
    } catch (error) {
      write(projectId, {
        status: "failed",
        stage: null,
        bookId: null,
        error: error?.message || String(error),
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
