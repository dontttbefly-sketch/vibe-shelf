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

// 中文没有空格：整句会被切成一个超长 term，永远匹配不上索引，中文提问于是全部退化成
// sourcePriority 兜底（README + 入口文件），每次划词解释喂给模型的都是同一批文件。
// 按字取 bigram（"路由怎么注册" → 路由/由怎/怎么/么注/注册），再滤掉纯语法的疑问词，
// 让中文提问能落到具体文件上。英文标识符与路径仍按整词切。
const CJK_RANGES = "\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff";
const SEGMENT_PATTERN = new RegExp(`[${CJK_RANGES}]+|[^${CJK_RANGES}]+`, "g");
const CJK_ONLY_PATTERN = new RegExp(`^[${CJK_RANGES}]+$`);
const WORD_PATTERN = /[\p{L}\p{N}_][\p{L}\p{N}_.\-/]*/gu;

// 高频疑问词/指示词：留着会让所有块都 +1，把真正的信号淹掉
const CJK_STOP_BIGRAMS = new Set([
  "什么", "怎么", "怎样", "如何", "为何", "为什", "哪些", "哪里", "哪个", "这个", "那个",
  "这些", "那些", "我们", "你们", "他们", "它们", "是否", "是不", "不是", "可以", "能否",
  "一下", "一个", "的话", "时候", "就是", "还是", "或者", "以及", "还有", "因为", "所以",
  "但是", "如果", "那么", "应该", "需要", "知道", "告诉", "帮我", "请问",
]);

function cjkBigrams(run) {
  if (run.length < 2) return [];
  if (run.length === 2) return CJK_STOP_BIGRAMS.has(run) ? [] : [run];
  const grams = [];
  for (let i = 0; i < run.length - 1; i += 1) {
    const gram = run.slice(i, i + 2);
    if (!CJK_STOP_BIGRAMS.has(gram)) grams.push(gram);
  }
  return grams;
}

function queryTerms(query) {
  const text = String(query || "").toLowerCase();
  const terms = new Set();
  for (const segment of text.match(SEGMENT_PATTERN) || []) {
    if (CJK_ONLY_PATTERN.test(segment)) {
      for (const gram of cjkBigrams(segment)) terms.add(gram);
      continue;
    }
    for (const word of segment.match(WORD_PATTERN) || []) {
      if (word.length >= 2) terms.add(word);
    }
  }
  return terms;
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
