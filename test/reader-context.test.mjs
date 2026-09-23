import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("reader supports a project/book context without removing legacy fallback", () => {
  const source = fs.readFileSync("public/notes.js", "utf8");
  assert.match(source, /window\.SHELF_CONTEXT/);
  assert.match(source, /projectId/);
  assert.match(source, /projectNotesPath/);
  assert.match(source, /projectSnapshotPath/);
  assert.match(source, /projectBookPath/);
  assert.match(source, /projectBookPath\("explain"\)/);
  assert.match(source, /projectBookPath\("followup"\)/);
  assert.match(source, /window\.SHELF_BOOK \|\| "default"/);
  assert.match(source, /staticNotesUrl/);
});

test("reader includes the matured single-page annotation interactions", () => {
  const source = fs.readFileSync("public/notes.js", "utf8");
  const styles = fs.readFileSync("public/notes.css", "utf8");

  assert.match(source, /searchPanel/);
  assert.match(source, /openGlobalSearch/);
  assert.match(source, /playSearchInsertMotion/);
  assert.match(source, /nb-promoted-restore/);
  assert.match(source, /applyNotePlacement/);
  assert.match(source, /miniTimer/);
  assert.match(source, /markQuoteIn/);

  assert.match(styles, /\.nb-search-panel/);
  assert.match(styles, /\.nb-promoted-restore/);
  assert.match(styles, /@keyframes nbRestoreQuote/);
  assert.match(styles, /@keyframes nbPromotedInserted/);
  assert.match(styles, /@keyframes nbSearchCommit/);
});

test("reader allows long code selections to open annotation entry", () => {
  const source = fs.readFileSync("public/notes.js", "utf8");

  assert.match(source, /MAX_SELECTION_QUOTE_CHARS\s*=\s*4000/);
  assert.match(source, /quote\.length > MAX_SELECTION_QUOTE_CHARS/);
  assert.match(source, /text\.length > MAX_SELECTION_QUOTE_CHARS/);
  assert.doesNotMatch(source, /(?:quote|text)\.length > 300/);
});
