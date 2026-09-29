import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function importer() {
  const window = {};
  vm.runInNewContext(fs.readFileSync('public/import-files.js', 'utf8'), { window });
  return window.ShelfImport;
}
function file(name, content) {
  return { name, webkitRelativePath: `demo/${name}`, size: Buffer.byteLength(content), text: async () => content };
}
test('import preview respects byte budget for Chinese source text and counts omitted files', async () => {
  const content = '汉'.repeat(30 * 1024);
  const selected = Array.from({ length: 120 }, (_, i) => file(`part-${i}.md`, content));
  const files = await importer().readDirectoryTextFiles(selected);
  assert.ok(files.reduce((n, item) => n + Buffer.byteLength(item.content), 0) <= 8 * 1024 * 1024);
  assert.equal(files.skipped, selected.length - files.length);
  assert.equal(files.truncated, true);
});
test('import preview explains file-count exclusions rather than silently dropping the tail', async () => {
  const files = await importer().readDirectoryTextFiles(Array.from({ length: 305 }, (_, i) => file(`${i}.js`, 'ok')));
  assert.equal(files.length, 300);
  assert.equal(files.skipped, 5);
  assert.equal(files.truncated, true);
});
test('import preview excludes dependencies and binaries without hiding a valid source file', async () => {
  const files = await importer().readDirectoryTextFiles([file('node_modules/a.js', 'dep'), file('photo.png', '\0png'), file('src/main.js', 'main')]);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'src/main.js');
  assert.equal(files.skipped, 2);
});

test('directory drop reads every directory batch and preserves nested relative paths', async () => {
  const api = importer();
  const item = (name, content) => ({ name, isFile: true, file(resolve) { resolve({ name, size: content.length, text: async () => content }); } });
  const folder = (name, batches) => ({ name, isDirectory: true, createReader() { let i = 0; return { readEntries(resolve) { resolve(batches[i++] || []); } }; } });
  const root = folder('demo', [[folder('src', [[item('a.js', 'a')], [item('b.js', 'b')]])], [folder('node_modules', [[item('dependency.js', 'ignored')]])]]);
  const selected = await api.readDroppedDirectory({ items: [{ webkitGetAsEntry: () => root }] });
  const files = await api.readDirectoryTextFiles(selected);
  assert.deepEqual(Array.from(files, f => f.path), ['src/a.js', 'src/b.js']);
  assert.deepEqual(Array.from(files, f => f.content), ['a', 'b']);
  await assert.rejects(api.readDroppedDirectory({ items: [] }), /拖入一个项目文件夹/);
});
