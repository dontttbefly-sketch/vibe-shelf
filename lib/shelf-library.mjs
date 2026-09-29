import fs from "node:fs";
import path from "node:path";
import { assertId } from "./ids.mjs";
import { readJson } from "./json-store.mjs";

export const SHELF_PREVIEW_LIMITS = Object.freeze({ htmlBytes: 1024 * 1024, summary: 320, chapters: 24, chapterTitle: 100, books: 200 });
const validId = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const timestamp = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const text = (value, limit = 180) => typeof value === "string"
  ? value.replace(/<[^>]*>/g, " ").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit) : "";

function entities(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", middot: "·" };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|ndash|mdash|hellip|middot);/gi, (match, entity) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] || match;
    const number = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : "";
  });
}

function fingerprint(value) {
  if (!value || typeof value !== "object") return null;
  const colors = Array.isArray(value.colors) ? value.colors.filter((color) => typeof color === "string" &&
    (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color) || /^rgba?\([\d.,%\s]+\)$/i.test(color))).slice(0, 16) : [];
  const fonts = Array.isArray(value.fonts) ? value.fonts.filter((font) => typeof font === "string" && font.length <= 180 && !/[;{}<>\\/():]/.test(font)).slice(0, 6) : [];
  return colors.length || fonts.length ? { colors, fonts } : null;
}

// This is a bounded text extractor, not an HTML renderer. It ignores executable,
// hidden and source-code regions; no element, stylesheet or URL is instantiated.
export function extractShelfPreview(html, readingUrl) {
  const blockedTags = new Set(["head", "script", "style", "pre", "code", "template", "iframe", "object", "embed", "svg", "canvas", "noscript", "nav", "aside", "form", "button", "input", "textarea", "select"]);
  const rawTags = new Set(["script", "style", "textarea"]);
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const stack = [];
  const chapters = [];
  const chapterIds = new Set();
  let subtitle = "", paragraph = "", offset = 0, tokens = 0, chaptersTruncated = false;
  const lower = html.toLowerCase();
  function finish(node) {
    if (node.blocked || !node.capture) return;
    const content = text(entities(node.text), node.capture === "heading" ? SHELF_PREVIEW_LIMITS.chapterTitle : SHELF_PREVIEW_LIMITS.summary);
    if (!content) return;
    if (node.capture === "subtitle" && !subtitle) subtitle = content;
    if (node.capture === "paragraph" && !paragraph) paragraph = content;
    if (node.capture === "heading" && node.chapterId && !chapterIds.has(node.chapterId)) {
      chapterIds.add(node.chapterId);
      if (chapters.length < SHELF_PREVIEW_LIMITS.chapters) chapters.push({ id: node.chapterId, title: content, href: readingUrl + "#" + encodeURIComponent(node.chapterId) });
      else chaptersTruncated = true;
    }
  }
  while (offset < html.length && tokens++ < 40000) {
    if (html[offset] !== "<") {
      const end = html.indexOf("<", offset);
      const chunk = html.slice(offset, end < 0 ? html.length : end);
      if (!stack.at(-1)?.blocked) {
        const collector = [...stack].reverse().find((node) => node.capture);
        if (collector && collector.text.length < 2048) collector.text += chunk.slice(0, 2048 - collector.text.length);
      }
      offset = end < 0 ? html.length : end;
      continue;
    }
    if (html.startsWith("<!--", offset)) {
      const end = html.indexOf("-->", offset + 4);
      offset = end < 0 ? html.length : end + 3;
      continue;
    }
    let end = offset + 1, quote = null;
    for (; end < html.length; end++) {
      const char = html[end];
      if (quote) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (end === html.length) break;
    const token = html.slice(offset, end + 1);
    offset = end + 1;
    const match = token.match(/^<(\/?)\s*([a-z][a-z0-9:-]*)\b/i);
    if (!match || token.length > 16384) continue;
    const closing = Boolean(match[1]), tag = match[2].toLowerCase();
    if (closing) {
      const found = stack.map((node) => node.tag).lastIndexOf(tag);
      if (found >= 0) while (stack.length > found) finish(stack.pop());
      continue;
    }
    if (rawTags.has(tag)) {
      let close = lower.indexOf("</" + tag, offset);
      while (close >= 0 && !/[\s/>]/.test(lower[close + tag.length + 2] || "")) close = lower.indexOf("</" + tag, close + tag.length + 2);
      offset = close < 0 ? html.length : close;
      continue;
    }
    const attrs = {};
    for (const attr of token.slice(match[0].length, -1).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      attrs[attr[1].toLowerCase()] = entities(attr[2] ?? attr[3] ?? attr[4] ?? "");
    }
    const classes = String(attrs.class || "").split(/\s+/);
    const parent = stack.at(-1);
    const node = {
      tag, text: "", capture: null,
      blocked: Boolean(parent?.blocked || blockedTags.has(tag) || "hidden" in attrs || attrs["aria-hidden"] === "true" || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs.style || "")),
      inMain: Boolean(parent?.inMain || classes.includes("book-main")),
      inHeader: Boolean(parent?.inHeader || classes.includes("book-header")),
      chapterId: parent?.chapterId || null,
    };
    if (classes.includes("chapter")) node.chapterId = typeof attrs.id === "string" && attrs.id.length <= 160 && !/[\s<>\x00-\x1f]/.test(attrs.id) ? attrs.id : null;
    if (!node.blocked) {
      if (classes.includes("sub") && node.inHeader) node.capture = "subtitle";
      else if (tag === "h2" && node.inMain && node.chapterId) node.capture = "heading";
      else if (tag === "p" && node.inMain && !paragraph) node.capture = "paragraph";
    }
    if (tag === "br" && parent?.capture) parent.text += " ";
    if (!voidTags.has(tag) && !/\/\s*>$/.test(token)) stack.push(node);
    if (stack.length > 128) break;
  }
  while (stack.length) finish(stack.pop());
  return { summary: subtitle || paragraph, chapters, chaptersTruncated };
}

function readBookPreview(dataDir, projectId, bookId, readingUrl) {
  const empty = { summary: "", chapters: [], chaptersTruncated: false };
  let fd;
  try {
    let target = path.resolve(dataDir);
    for (const segment of ["projects", projectId, "books", bookId, "source.html"]) {
      target = path.join(target, segment);
      if (fs.lstatSync(target).isSymbolicLink()) return { ...empty, previewStatus: "unavailable" };
    }
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { ...empty, previewStatus: "unavailable" };
    if (stat.size > SHELF_PREVIEW_LIMITS.htmlBytes) return { ...empty, previewStatus: "too-large" };
    const bytes = Buffer.alloc(stat.size);
    fs.readSync(fd, bytes, 0, bytes.length, 0);
    const result = extractShelfPreview(bytes.toString("utf8"), readingUrl);
    return { ...result, previewStatus: result.summary || result.chapters.length ? "ready" : "empty" };
  } catch {
    return { ...empty, previewStatus: "unavailable" };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function createShelfLibrary({ dataDir, projects, books }) {
  function metadata(projectId) {
    const project = projects.requireProjectById(assertId(projectId));
    const allBooks = books.listBooks(projectId).filter((book) => validId(book?.id) && ["main", "exploration"].includes(book.kind)).map((book) => ({
      id: book.id, title: text(book.title), kind: book.kind, url: projects.bookUrl(projectId, book.id),
      styleFingerprint: fingerprint(book.styleFingerprint),
      parentBookId: validId(book.parentBookId) ? book.parentBookId : null,
      originExplorationId: validId(book.originExplorationId) ? book.originExplorationId : null,
      originAnswerMessageId: validId(book.originAnswerMessageId) ? book.originAnswerMessageId : null,
      sourceSnapshotId: validId(book.sourceSnapshotId) ? book.sourceSnapshotId : null,
      createdAt: timestamp(book.createdAt), updatedAt: timestamp(book.updatedAt) || timestamp(book.createdAt),
    }));
    const mainBook = allBooks.find((book) => book.id === (project.mainBookId || "main") && book.kind === "main") || null;
    // Read-only: previewing must not touch reading history or repair generation jobs.
    const generation = readJson(path.join(dataDir, "projects", projectId, "generation.json"), null);
    const generationStatus = ["idle", "ready", "generating", "failed"].includes(generation?.status) ? generation.status : "idle";
    const status = ["generating", "failed"].includes(generationStatus) ? generationStatus : mainBook ? "ready" : "pending";
    const updatedAt = allBooks.reduce((latest, book) => Math.max(latest, book.updatedAt), Math.max(timestamp(project.updatedAt), timestamp(project.createdAt), timestamp(generation?.updatedAt)));
    return { project, allBooks, mainBook, updatedAt, status, generationStatus };
  }
  function summary(project) {
    const meta = metadata(project.id);
    return {
      ...project, updatedAt: meta.updatedAt, bookCount: meta.allBooks.length, status: meta.status,
      mainBook: meta.mainBook ? { id: meta.mainBook.id, title: meta.mainBook.title, url: meta.mainBook.url, styleFingerprint: meta.mainBook.styleFingerprint } : null,
      books: meta.allBooks.map(({ id, title, kind, updatedAt, url }) => ({ id, title, kind, updatedAt, url })),
    };
  }
  function preview(projectId) {
    const meta = metadata(projectId);
    const explorationBooks = meta.allBooks.filter((book) => book.kind === "exploration");
    return {
      projectId, title: meta.mainBook?.title || text(meta.project.name), readingUrl: meta.mainBook?.url || null,
      ready: Boolean(meta.mainBook), status: meta.status, generationStatus: meta.generationStatus,
      updatedAt: meta.updatedAt, bookCount: meta.allBooks.length, styleFingerprint: meta.mainBook?.styleFingerprint || null,
      books: explorationBooks.slice(0, SHELF_PREVIEW_LIMITS.books).map(({ styleFingerprint: ignored, ...book }) => book),
      booksTruncated: explorationBooks.length > SHELF_PREVIEW_LIMITS.books,
      ...(meta.mainBook ? readBookPreview(dataDir, projectId, meta.mainBook.id, meta.mainBook.url)
        : { summary: "", chapters: [], chaptersTruncated: false, previewStatus: "no-book" }),
    };
  }
  return { summary, preview };
}
