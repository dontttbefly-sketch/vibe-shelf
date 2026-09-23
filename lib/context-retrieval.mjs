function compareChunks(left, right) {
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  return Number(left.startLine) - Number(right.startLine);
}

function sourcePriority(filePath) {
  const path = String(filePath).toLowerCase();
  const filename = path.split("/").pop() || path;

  if (filename === "readme" || filename.startsWith("readme.")) return 0;
  if (
    filename === "package.json" ||
    filename === "deno.json" ||
    filename === "composer.json" ||
    filename === "cargo.toml" ||
    filename === "pyproject.toml" ||
    filename.endsWith(".config.js") ||
    filename.endsWith(".config.mjs") ||
    filename.endsWith(".config.ts")
  ) return 1;
  if (/^(index|main|server|app)\.[a-z0-9]+$/.test(filename)) return 2;
  return 3;
}

function queryTerms(query) {
  return new Set(String(query).toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || []);
}

function scoreChunk(chunk, terms) {
  const filePath = String(chunk.path || "").toLowerCase();
  const text = String(chunk.text || "").toLowerCase();
  let score = 0;

  for (const term of terms) {
    if (filePath.includes(term)) score += 4;
    if (text.includes(term)) score += 1;
  }
  return score;
}

export function retrieveContext(index, query, maxChunks = 6) {
  const limit = Number.isInteger(maxChunks) && maxChunks > 0 ? maxChunks : 6;
  const chunks = Array.isArray(index) ? index : [];
  const terms = queryTerms(query);
  const scored = chunks
    .map((chunk) => ({ chunk, score: scoreChunk(chunk, terms) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || compareChunks(left.chunk, right.chunk))
    .map(({ chunk }) => chunk);

  if (scored.length) return scored.slice(0, limit);

  return chunks
    .slice()
    .sort((left, right) => sourcePriority(left.path) - sourcePriority(right.path) || compareChunks(left, right))
    .slice(0, limit);
}
