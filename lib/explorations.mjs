import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertId } from "./ids.mjs";
import { readJson, writeJsonAtomic } from "./json-store.mjs";
import { projectDir, readProject } from "./projects.mjs";

function now() {
  return Date.now();
}

function newId(prefix) {
  return `${prefix}-${now().toString(36)}-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
}

function explorationsDir(dataDir, projectId) {
  return path.join(projectDir(dataDir, projectId), "explorations");
}

function sessionFile(dataDir, projectId, sessionId) {
  return path.join(explorationsDir(dataDir, projectId), `${assertId(sessionId, "sessionId")}.json`);
}

function createBadResponse(message) {
  return Object.assign(new Error(message), { statusCode: 502, kind: "bad-response" });
}

function requireProject(dataDir, projectId) {
  const project = readProject(dataDir, projectId);
  if (!project) throw new Error("project not found");
  return project;
}

function validatePrompt(prompt) {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.trim().length > 4000) {
    throw new Error("invalid exploration prompt");
  }
  return prompt.trim();
}

function optionalId(value, label) {
  return value === null || value === undefined || value === "" ? null : assertId(value, label);
}

function optionalPosition(value) {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : null;
}

function titleFromQuestion(question) {
  const compact = String(question).replace(/\s+/g, " ").trim();
  return compact.slice(0, 80) || "项目探索";
}

function sourceRefs(chunks) {
  return chunks.map(({ path: filePath, startLine, endLine }) => ({
    path: filePath,
    startLine,
    endLine,
  }));
}

function parseSuggestions(content) {
  let raw = String(content || "").trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw);
  if (fence) raw = fence[1].trim();

  let values;
  try {
    values = JSON.parse(raw);
  } catch {
    throw createBadResponse("模型返回的探索方向不是 JSON");
  }
  if (!Array.isArray(values)) throw createBadResponse("模型返回的探索方向不是数组");

  const suggestions = values
    .filter((value) => value && typeof value.title === "string" && typeof value.rationale === "string")
    .map((value) => ({
      title: value.title.trim().slice(0, 80),
      rationale: value.rationale.trim().slice(0, 240),
    }))
    .filter((value) => value.title && value.rationale)
    .slice(0, 3);

  if (suggestions.length < 2) throw createBadResponse("模型没有返回足够的探索方向");
  return suggestions;
}

export function createExplorationStore({ dataDir, books, retrieveForSnapshot, modelClient, prompts }) {
  if (!books || typeof retrieveForSnapshot !== "function" || !modelClient || !prompts) {
    throw new Error("exploration store dependencies are required");
  }

  function writeSession(session) {
    writeJsonAtomic(sessionFile(dataDir, session.projectId, session.id), session);
  }

  function getSession(projectId, sessionId) {
    assertId(projectId, "projectId");
    const session = readJson(sessionFile(dataDir, projectId, sessionId), null);
    if (!session) throw new Error("exploration not found");
    return session;
  }

  function listSessions(projectId) {
    assertId(projectId, "projectId");
    const directory = explorationsDir(dataDir, projectId);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson(path.join(directory, entry.name), null))
      .filter(Boolean)
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0) || (
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0
      ));
  }

  function createSession({
    projectId,
    originBookId = null,
    sourceSnapshotId = null,
    originChapterId = null,
    originReadingPosition = null,
  }) {
    const safeProjectId = assertId(projectId, "projectId");
    const project = requireProject(dataDir, safeProjectId);
    const snapshotId = sourceSnapshotId === null || sourceSnapshotId === undefined
      ? project.currentSnapshotId
      : assertId(sourceSnapshotId, "sourceSnapshotId");
    retrieveForSnapshot({ projectId: safeProjectId, snapshotId, query: "项目概览", maxChunks: 1 });

    let id = newId("e");
    while (fs.existsSync(sessionFile(dataDir, safeProjectId, id))) id = newId("e");
    const timestamp = now();
    const session = {
      id,
      projectId: safeProjectId,
      originBookId: optionalId(originBookId, "originBookId"),
      originChapterId: optionalId(originChapterId, "originChapterId"),
      originReadingPosition: optionalPosition(originReadingPosition),
      sourceSnapshotId: snapshotId,
      status: "open",
      messages: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    writeSession(session);
    return session;
  }

  async function finishAssistantMessage(session, assistantMessage, question) {
    try {
      const context = retrieveForSnapshot({
        projectId: session.projectId,
        snapshotId: session.sourceSnapshotId,
        query: question,
      });
      assistantMessage.sourceRefs = sourceRefs(context.chunks);
      session.updatedAt = now();
      writeSession(session);
      const content = await modelClient.complete({
        prompt: prompts.buildExplorationPrompt({ question, session, chunks: context.chunks }),
      });
      if (typeof content !== "string" || !content.trim()) throw new Error("模型没有返回内容");
      assistantMessage.content = content.trim();
      assistantMessage.status = "complete";
      delete assistantMessage.error;
    } catch (error) {
      assistantMessage.status = "failed";
      assistantMessage.error = error?.message || String(error);
    }
    session.updatedAt = now();
    writeSession(session);
    return assistantMessage;
  }

  async function appendQuestion({ projectId, sessionId, prompt }) {
    const session = getSession(projectId, sessionId);
    const question = validatePrompt(prompt);
    const timestamp = now();
    const userMessage = { id: newId("m"), role: "user", content: question, createdAt: timestamp };
    const assistantMessage = {
      id: newId("m"),
      role: "assistant",
      status: "pending",
      content: "",
      sourceRefs: [],
      createdAt: timestamp,
    };
    session.messages.push(userMessage);
    session.updatedAt = timestamp;
    writeSession(session);
    session.messages.push(assistantMessage);
    session.updatedAt = now();
    writeSession(session);
    return finishAssistantMessage(session, assistantMessage, question);
  }

  async function retryMessage({ projectId, sessionId, messageId }) {
    const session = getSession(projectId, sessionId);
    const safeMessageId = assertId(messageId, "messageId");
    const index = session.messages.findIndex((message) => message.id === safeMessageId);
    const assistantMessage = session.messages[index];
    const userMessage = session.messages[index - 1];
    if (
      index < 1 ||
      assistantMessage?.role !== "assistant" ||
      assistantMessage.status !== "failed" ||
      userMessage?.role !== "user"
    ) {
      throw new Error("message is not retryable");
    }
    assistantMessage.status = "pending";
    assistantMessage.content = "";
    assistantMessage.sourceRefs = [];
    delete assistantMessage.error;
    session.updatedAt = now();
    writeSession(session);
    return finishAssistantMessage(session, assistantMessage, userMessage.content);
  }

  function growAnswerIntoBook({ projectId, sessionId, answerMessageId, title, parentBookId = null }) {
    const session = getSession(projectId, sessionId);
    const safeAnswerMessageId = assertId(answerMessageId, "answerMessageId");
    const index = session.messages.findIndex((message) => message.id === safeAnswerMessageId);
    const answer = session.messages[index];
    const question = session.messages[index - 1];
    if (index < 1 || answer?.role !== "assistant" || answer.status !== "complete" || question?.role !== "user") {
      throw new Error("answer is not ready to grow into a book");
    }
    if (title !== undefined && (typeof title !== "string" || !title.trim() || title.trim().length > 80)) {
      throw new Error("invalid exploration book title");
    }
    return books.growExplorationBook({
      projectId: session.projectId,
      sessionId: session.id,
      answerMessageId: answer.id,
      title: title?.trim() || titleFromQuestion(question.content),
      answerMarkdown: answer.content,
      sourceSnapshotId: session.sourceSnapshotId,
      sourceRefs: answer.sourceRefs,
      parentBookId,
    });
  }

  async function listSuggestions(projectId) {
    const safeProjectId = assertId(projectId, "projectId");
    const project = requireProject(dataDir, safeProjectId);
    const baseContext = retrieveForSnapshot({
      projectId: safeProjectId,
      snapshotId: project.currentSnapshotId,
      query: "项目架构 运行入口 配置 关键模块",
    });
    const content = await modelClient.complete({
      prompt: prompts.buildSuggestionsPrompt({ chunks: baseContext.chunks }),
    });
    return parseSuggestions(content).map((suggestion) => {
      const context = retrieveForSnapshot({
        projectId: safeProjectId,
        snapshotId: project.currentSnapshotId,
        query: `${suggestion.title} ${suggestion.rationale}`,
      });
      const refs = sourceRefs(context.chunks);
      if (!refs.length) throw createBadResponse("探索方向缺少源码依据");
      return {
        ...suggestion,
        question: `请带我深入理解：${suggestion.title}`,
        sourceRefs: refs,
      };
    });
  }

  return {
    appendQuestion,
    createSession,
    getSession,
    growAnswerIntoBook,
    listSessions,
    listSuggestions,
    retryMessage,
  };
}
