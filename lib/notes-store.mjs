import path from "node:path";
import { assertId } from "./ids.mjs";
import { readJson, writeJsonAtomic } from "./json-store.mjs";
import { isDeepStrictEqual } from "node:util";
import { httpError } from "./http.mjs";

export function createNotesStore({ dataDir }) {
  const file = (projectId, bookId) => path.join(
    dataDir,
    "projects",
    assertId(projectId, "projectId"),
    "notes",
    `${assertId(bookId, "bookId")}.json`,
  );
  const readList = (projectId, bookId) => {
    const notes = readJson(file(projectId, bookId), []);
    if (!Array.isArray(notes)) throw new Error("invalid notes store");
    return notes;
  };
  const deletedFile = (projectId, bookId) => file(projectId, bookId).replace(/\.json$/, ".deleted.json");
  const revision = note => Number.isInteger(note?.revision) && note.revision >= 0 ? note.revision : 0;
  const content = note => {
    const { revision: _revision, ...rest } = note;
    return rest;
  };
  const conflict = () => httpError("这条旁注已在其他窗口更新或删除，本地草稿请保留后另存", 409, "note-conflict");
  const list = (projectId, bookId, { withRevisions = false } = {}) => (
    readList(projectId, bookId).map(note => withRevisions ? { ...note, revision: revision(note) } : content(note))
  );

  return {
    list,
    upsert(projectId, bookId, note) {
      if (!note || typeof note.id !== "string" || !note.id) throw new Error("invalid note");
      if (note.revision !== undefined && (!Number.isInteger(note.revision) || note.revision < 0)) {
        throw httpError("invalid note revision", 400, "bad-request");
      }
      const notes = readList(projectId, bookId);
      const index = notes.findIndex((item) => item.id === note.id);
      const current = notes[index];
      if (current && isDeepStrictEqual(content(current), content(note))) return notes;
      if (current && revision(current) !== revision(note)) throw conflict();
      if (!current && (revision(note) > 0 || readJson(deletedFile(projectId, bookId), {})[note.id])) throw conflict();
      const next = { ...note, revision: revision(current) + 1 };
      if (index >= 0) notes[index] = next;
      else notes.push(next);
      writeJsonAtomic(file(projectId, bookId), notes);
      return notes;
    },
    remove(projectId, bookId, noteId, expectedRevision) {
      if (typeof noteId !== "string" || !noteId) throw new Error("invalid note id");
      const existing = readList(projectId, bookId);
      const current = existing.find(note => note.id === noteId);
      if (!current) return existing;
      const expected = expectedRevision === null || expectedRevision === undefined ? 0 : Number(expectedRevision);
      if (!Number.isInteger(expected) || expected !== revision(current)) throw conflict();
      const deleted = readJson(deletedFile(projectId, bookId), {});
      deleted[noteId] = revision(current) + 1;
      // 先留删除标记。即使进程在两次原子写之间中断，也不能让旧离线稿复活。
      writeJsonAtomic(deletedFile(projectId, bookId), deleted);
      const notes = existing.filter((note) => note.id !== noteId);
      writeJsonAtomic(file(projectId, bookId), notes);
      return notes;
    },
  };
}
