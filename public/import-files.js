/* 本地文件夹导入助手：浏览器侧先做友好过滤，服务端仍是最终校验者。 */
(function () {
  "use strict";

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // 与服务端 lib/imports.mjs 的 IMPORT_LIMITS 保持一致：
  // 不在这里先截住的话，选错文件夹（比如带 node_modules）会先读满整个目录，
  // 再被服务端一句英文的 "request body too large" 拒掉。
  var MAX_FILES = 300;
  var MAX_FILE_BYTES = 100 * 1024;
  var MAX_TOTAL_BYTES = 8 * 1024 * 1024;

  async function readDirectoryTextFiles(fileList) {
    var selected = Array.prototype.slice.call(fileList || []);
    var root = selected[0] && selected[0].webkitRelativePath
      ? selected[0].webkitRelativePath.split("/")[0]
      : "";
    var rootPattern = root ? new RegExp("^" + escapeRegExp(root) + "/") : null;
    var ignored = /(^|\/)\.git\/|(^|\/)(node_modules|dist|build|\.next)(\/|$)/;
    var records = [];
    var skipped = 0;
    var totalBytes = 0;
    var truncated = false;

    for (var index = 0; index < selected.length; index += 1) {
      var file = selected[index];
      var relative = (file.webkitRelativePath || file.name || "").replace(rootPattern || /^$/, "");
      if (!relative || ignored.test(relative) || file.size > MAX_FILE_BYTES) {
        skipped += 1;
        continue;
      }
      if (records.length >= MAX_FILES || totalBytes + file.size > MAX_TOTAL_BYTES) {
        truncated = true;
        skipped += 1;
        continue;
      }
      var content = await file.text();
      if (content.includes("\u0000")) {
        skipped += 1;
        continue;
      }
      totalBytes += file.size;
      records.push({ path: relative, content: content });
    }

    records.skipped = skipped;
    records.truncated = truncated;
    return records;
  }

  async function readDroppedDirectory(dataTransfer) {
    var items = Array.from(dataTransfer.items || []);
    var entries = items.map(function (item) { return item.webkitGetAsEntry ? item.webkitGetAsEntry() : null; }).filter(Boolean);
    if (entries.length !== 1 || !entries[0].isDirectory) throw new Error('请拖入一个项目文件夹，或点击“选择文件夹”。');
    var files = [], visited = 0;
    async function walk(entry, prefix) {
      if (++visited > 10000) throw new Error('这个文件夹内容较多，请先移出依赖或构建目录后重试。');
      if (entry.isDirectory) {
        if (/^(\.git|node_modules|dist|build|\.next)$/.test(entry.name)) return;
        var reader = entry.createReader(), batch;
        do {
          batch = await new Promise(function (resolve, reject) { reader.readEntries(resolve, reject); });
          for (var child of batch) await walk(child, prefix + entry.name + '/');
        } while (batch.length);
      } else if (entry.isFile) {
        var file = await new Promise(function (resolve, reject) { entry.file(resolve, reject); });
        files.push({ name: file.name, size: file.size, webkitRelativePath: prefix + file.name, text: function () { return file.text(); } });
      }
    }
    await walk(entries[0], '');
    if (!files.length) throw new Error('文件夹中没有可读取的项目文件。');
    return files;
  }
  window.ShelfImport = { readDirectoryTextFiles: readDirectoryTextFiles, readDroppedDirectory: readDroppedDirectory };
}());
