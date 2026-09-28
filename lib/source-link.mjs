// 编译期源码锚定：把书里"逐字摘自源码"的代码块对快照做内容匹配，命中才注入
// data-file / data-line——行号的唯一可信来源是快照，不是模型的自述。
// 匹配不上的块（模型改写过、拼接过）不注入；歧义（多文件同内容样板）用块前
// 最近的引用消歧，消不掉就放弃——跳错行比不跳更伤信任。
import Core from "../public/reader-core.js";

const MIN_RUN = 5;        // 连续命中行数下限，弱锚宁可不要
const HINT_WINDOW = 4000; // 块前多远内找"最近的引用"做消歧提示

function decodeEntities(value) {
  return String(value)
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function escapeAttr(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function normalizeLine(line) {
  return String(line).replace(/\s+/g, " ").trim();
}

function buildFileIndex(files) {
  const index = [];
  for (const file of files || []) {
    const lines = String(file.content || "").split("\n").map(normalizeLine);
    const lookup = new Map();
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i]) continue;
      const bucket = lookup.get(lines[i]);
      if (bucket) bucket.push(i);
      else lookup.set(lines[i], [i]);
    }
    index.push({ path: file.path, lines, lookup });
  }
  return index;
}

function bestRunInFile(blockLines, file) {
  let best = null;
  for (let a = 0; a < blockLines.length; a += 1) {
    const line = blockLines[a];
    if (!line) continue;
    const starts = file.lookup.get(line);
    if (!starts) continue;
    for (const j of starts) {
      let run = 1;
      while (
        a + run < blockLines.length &&
        j + run < file.lines.length &&
        blockLines[a + run] &&
        blockLines[a + run] === file.lines[j + run]
      ) run += 1;
      if (!best || run > best.run) best = { run, path: file.path, fileLine: j, blockLine: a };
    }
  }
  return best;
}

// 每个文件取自己的最长命中，再跨文件比——同长度的都算候选，由调用方消歧
function findCandidates(blockLines, fileIndex) {
  const perFile = [];
  for (const file of fileIndex) {
    const best = bestRunInFile(blockLines, file);
    if (best) perFile.push(best);
  }
  if (!perFile.length) return { candidates: [], best: 0 };
  perFile.sort((left, right) => right.run - left.run);
  const top = perFile[0].run;
  return { candidates: perFile.filter((candidate) => candidate.run === top), best: top };
}

// 平局排序：同一段内容常在代码文件和多语言 README 里逐字重复，内容匹配分不出来。
// 序：代码文件 > 中文文档 > 无语言后缀文档 > 英文文档 > 其他语言 > 语言子目录里的文档。
const LANGUAGE_CODES = new Set(["zh", "en", "ja", "ko", "ru", "fr", "de", "es", "pt", "it", "ar", "hi", "th", "vi", "id", "tr", "pl", "nl"]);
const LANGUAGE_SUFFIX_RE = /[.\-](zh|en|ja|ko|ru|fr|de|es|pt|it|ar|hi|th|vi|id|tr|pl|nl)(?=\.[a-z0-9]+$|$)/i;

function candidateRank(filePath) {
  const segments = filePath.split("/");
  const name = segments[segments.length - 1].toLowerCase();
  const docPenalty = /\.(md|mdx|txt)$/.test(name) ? 2 : 0;
  let langPenalty = 1;
  const dirCode = segments.slice(0, -1).map((segment) => segment.toLowerCase()).find((segment) => LANGUAGE_CODES.has(segment));
  if (dirCode) langPenalty = dirCode === "zh" ? 0.5 : dirCode === "en" ? 1.5 : 4;
  else {
    const match = LANGUAGE_SUFFIX_RE.exec(name);
    if (match) {
      const code = match[1].toLowerCase();
      langPenalty = code === "zh" ? 0 : code === "en" ? 2 : 3;
    }
  }
  return docPenalty + langPenalty;
}

function pickByRank(candidates) {
  const ranks = candidates.map((candidate) => candidateRank(candidate.path));
  const best = Math.min(...ranks);
  const winners = candidates.filter((candidate, index) => ranks[index] === best);
  return winners.length === 1 ? winners[0] : null;
}

function scanRefs(html) {
  const re = Core.makeSrcRefRe();
  const refs = [];
  let match;
  while ((match = re.exec(html))) refs.push({ token: match[1], index: match.index });
  return refs;
}

function hintPathBefore(refs, offset, files) {
  for (let i = refs.length - 1; i >= 0; i -= 1) {
    if (refs[i].index >= offset) continue;
    if (offset - refs[i].index > HINT_WINDOW) return null;
    return Core.resolveSourcePath(refs[i].token, files);
  }
  return null;
}

export function anchorCodeBlocks(html, files) {
  const fileIndex = buildFileIndex(files);
  const refs = scanRefs(html);
  const stats = { blocks: 0, anchored: 0, ambiguous: 0 };
  if (!fileIndex.length) return { html, stats };

  const output = String(html).replace(
    /<pre\b([^>]*)>(\s*<code\b[^>]*>[\s\S]*?<\/code>\s*<\/pre>)/g,
    (full, attrs, rest, offset) => {
      stats.blocks += 1;
      if (/\bdata-file\s*=/.test(attrs)) return full;
      const blockLines = decodeEntities(rest.slice(rest.indexOf(">") + 1, rest.lastIndexOf("</code>"))).split("\n").map(normalizeLine);
      if (blockLines.filter(Boolean).length < MIN_RUN) return full;
      const { candidates, best } = findCandidates(blockLines, fileIndex);
      if (best < MIN_RUN) return full;

      let chosen = candidates.length === 1 ? candidates[0] : null;
      if (!chosen) chosen = pickByRank(candidates);
      if (!chosen) {
        const hint = hintPathBefore(refs, offset, files);
        if (hint) chosen = candidates.find((candidate) => candidate.path === hint) || null;
        if (!chosen) {
          stats.ambiguous += 1;
          return full;
        }
      }
      const startLine = chosen.fileLine - chosen.blockLine + 1;
      stats.anchored += 1;
      return `<pre data-file="${escapeAttr(chosen.path)}" data-line="${startLine}"${attrs}>${rest}`;
    },
  );
  return { html: output, stats };
}
