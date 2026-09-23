/* 本地文件夹导入助手：浏览器侧先做友好过滤，服务端仍是最终校验者。 */
(function () {
  "use strict";

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  async function readDirectoryTextFiles(fileList) {
    var selected = Array.prototype.slice.call(fileList || []);
    var root = selected[0] && selected[0].webkitRelativePath
      ? selected[0].webkitRelativePath.split("/")[0]
      : "";
    var rootPattern = root ? new RegExp("^" + escapeRegExp(root) + "/") : null;
    var ignored = /(^|\/)\.git\/|(^|\/)(node_modules|dist|build|\.next)(\/|$)/;
    var records = [];
    var skipped = 0;

    for (var index = 0; index < selected.length; index += 1) {
      var file = selected[index];
      var relative = (file.webkitRelativePath || file.name || "").replace(rootPattern || /^$/, "");
      if (!relative || ignored.test(relative) || file.size > 100 * 1024) {
        skipped += 1;
        continue;
      }
      var content = await file.text();
      if (content.includes("\u0000")) {
        skipped += 1;
        continue;
      }
      records.push({ path: relative, content: content });
    }

    records.skipped = skipped;
    return records;
  }

  window.ShelfImport = { readDirectoryTextFiles: readDirectoryTextFiles };
}());
