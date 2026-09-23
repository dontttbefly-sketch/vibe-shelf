import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-shelf-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
