import path from "node:path";
import { assertId } from "./ids.mjs";
import { readJson, writeJsonAtomic } from "./json-store.mjs";

export function createNotesStore({ dataDir }) {
  const file = (projectId, bookId) => path.join(
    dataDir,
    "projects",
    assertId(projectId, "projectId"),
    "notes",
    `${assertId(bookId, "bookId")}.json`,
  );
  const list = (projectId, bookId) => {
    const notes = readJson(file(projectId, bookId), []);
    if (!Array.isArray(notes)) throw new Error("invalid notes store");
    return notes;
  };

  return {
    list,
    upsert(projectId, bookId, note) {
      if (!note || typeof note.id !== "string" || !note.id) throw new Error("invalid note");
      const notes = list(projectId, bookId);
      const index = notes.findIndex((item) => item.id === note.id);
      if (index >= 0) notes[index] = note;
      else notes.push(note);
      writeJsonAtomic(file(projectId, bookId), notes);
      return notes;
    },
    remove(projectId, bookId, noteId) {
      if (typeof noteId !== "string" || !noteId) throw new Error("invalid note id");
      const notes = list(projectId, bookId).filter((note) => note.id !== noteId);
      writeJsonAtomic(file(projectId, bookId), notes);
      return notes;
    },
  };
}
