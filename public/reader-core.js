// reader-core.js — 阅读器纯函数区
// 从 notes.js 抽出的无 DOM 依赖函数，UMD 双端：浏览器挂 window.ShelfReaderCore，
// Node 测试可直接 require（test/reader-core.test.mjs）。
// notes.js 依赖本文件先于它加载（book-compiler 注入顺序保证）；只加函数，不碰 DOM。
(function (global) {
  "use strict";

  var DIFF_TOKEN_LIMIT = 1200; // 超过这个长度降级为整块增删，避免 O(n·m) 回溯卡顿
  // 成对标记：\u0002 del 起 / \u0003 del 止 / \u0004 add 起 / \u0005 add 止
  var MK_D0 = "\u0002", MK_D1 = "\u0003", MK_A0 = "\u0004", MK_A1 = "\u0005";

  // 分词：ASCII 词/数字成块，中文按字切；标点与空白各自成块，保证不会把词拆碎
  function tokenize(str) {
    var s = String(str || "");
    var re = /[A-Za-z0-9_]+|\s+|[一-鿿]|[\s\S]/g;
    return s.match(re) || [];
  }

  // 合并同类相邻块，减少碎片
  function mergeAdjacent(ops) {
    var out = [];
    ops.forEach(function (o) {
      var last = out[out.length - 1];
      if (last && last.t === o.t) last.text += o.text;
      else out.push({ t: o.t, text: o.text });
    });
    return out;
  }

  // 语义清理：把贴着增删块的一两个相同字并入增删块（中夹/前缀/后缀三种位置）。
  // 否则会出现「划掉『很危』/ 高亮『存在注入风』/ 留着『险』」这种碎块，读起来很糟。
  function cleanupDiff(ops) {
    var out = ops.slice();
    // 先归一化：同一处增删统一成"先删后增"，读起来才是"原来 X 变成 Y"。
    // （必须放在合并循环之前——LCS 回溯产出 add 在前，顺序不对则下面的模式永远匹配不上）
    for (var k = 0; k < out.length - 1; k++) {
      if (out[k].t === "add" && out[k + 1].t === "del") {
        var tmp = out[k]; out[k] = out[k + 1]; out[k + 1] = tmp;
      }
    }
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i < out.length - 2; i++) {
        var a = out[i], b = out[i + 1], c = out[i + 2];
        // del + same + add → 两边都吞掉夹字
        if (a.t === "del" && b.t === "same" && c.t === "add" && b.text.length <= 2) {
          out.splice(i, 3, { t: "del", text: a.text + b.text }, { t: "add", text: b.text + c.text });
          changed = true;
          break;
        }
        // del + add + same → 后缀共字并入两侧（原「很危险→存在注入风险」就是这种）
        if (a.t === "del" && b.t === "add" && c.t === "same" && c.text.length <= 2) {
          out.splice(i, 3, { t: "del", text: a.text + c.text }, { t: "add", text: b.text + c.text });
          changed = true;
          break;
        }
        // same + del + add → 前缀共字并入两侧
        if (a.t === "same" && b.t === "del" && c.t === "add" && a.text.length <= 2) {
          out.splice(i, 3, { t: "del", text: a.text + b.text }, { t: "add", text: a.text + c.text });
          changed = true;
          break;
        }
      }
    }
    return mergeAdjacent(out);
  }

  // LCS 字词级 diff：返回 [{ t:'same'|'add'|'del', text }]，顺序为阅读顺序
  function tokenDiff(aStr, bStr) {
    var a = tokenize(aStr), b = tokenize(bStr);
    var m = a.length, n = b.length;
    if (m > DIFF_TOKEN_LIMIT || n > DIFF_TOKEN_LIMIT) {
      if (aStr === bStr) return aStr ? [{ t: "same", text: aStr }] : [];
      var big = [];
      if (aStr) big.push({ t: "del", text: aStr });
      if (bStr) big.push({ t: "add", text: bStr });
      return big;
    }
    var dp = [];
    for (var i = 0; i <= m; i++) dp.push(new Uint32Array(n + 1));
    for (var i = 1; i <= m; i++) {
      for (var j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    var rev = []; var i = m, j = n;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) { rev.push({ t: "same", text: b[j - 1] }); i--; j--; }
      else if (dp[i - 1][j] >= dp[i][j - 1]) { rev.push({ t: "del", text: a[i - 1] }); i--; }
      else { rev.push({ t: "add", text: b[j - 1] }); j--; }
    }
    while (i > 0) { rev.push({ t: "del", text: a[i - 1] }); i--; }
    while (j > 0) { rev.push({ t: "add", text: b[j - 1] }); j--; }
    rev.reverse();
    return cleanupDiff(mergeAdjacent(rev));
  }

  // 把 diff 结果标成带成对标记的纯文本，交给 markdown 渲染器统一处理
  function markMd(ops) {
    return ops.map(function (o) {
      if (o.t === "same") return o.text;
      if (o.t === "del") return MK_D0 + o.text + MK_D1;
      return MK_A0 + o.text + MK_A1;
    }).join("");
  }

  function countMarkOps(ops) {
    var adds = 0, dels = 0;
    ops.forEach(function (o) { if (o.t === "add") adds++; else if (o.t === "del") dels++; });
    return { adds: adds, dels: dels };
  }

  // 选中内容的标签文案：只露前三个字 + 省略号，让用户一眼确认"我选中的是这段"。
  // 不足三个字时不加省略号（不加就不会谎报"后面还有内容"）。
  function clipSelection(text) {
    var s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    if (!s) return "";
    return s.length > 3 ? s.slice(0, 3) + "…" : s;
  }

  // ---- 源码引用：识别与解析（双端共享：阅读器 linkify + 服务端编译期锚定/消歧）----
  var SRC_REF_EXTENSIONS = "py|js|mjs|cjs|ts|tsx|jsx|go|rs|java|kt|swift|c|h|cpp|hpp|cs|rb|php|sh|sql|css|scss|less|html|htm|vue|svelte|json|ya?ml|toml|md|txt|xml|ini|conf|cfg|env";

  // 路径[:行号]。带行号时允许裸文件名（如 code.py:42）；不带行号时必须含 "/"——
  // 裸 code.py 这类名字项目里常有多份，链谁都可能是错的，交给调用方按此过滤。
  // 尾部 lookahead 防截断：没有它 "app.tsx" 会匹配成 "app.ts" 再漏出一个 "x"。
  // 全局正则带 lastIndex 状态，每次调用返回新实例，避免调用方互相踩。
  function makeSrcRefRe() {
    return new RegExp(
      "([A-Za-z0-9_\\-]+(?:\\/[A-Za-z0-9_\\-.]+)*\\.(?:" + SRC_REF_EXTENSIONS + "))(?::(\\d+))?(?![A-Za-z0-9_])",
      "g",
    );
  }

  // 编号段：s09_cron_scheduler / 09_cron / v2_hooks → { head, digits, tail }。
  // 目录编号会整批错位（书里写 s09_、快照里是 s12_），识别出"同头同尾、只有数字不同"才算近邻。
  function numberedSegment(segment) {
    var m = /^(.*?)(\d+)_(.+)$/.exec(segment);
    return m ? { head: m[1], digits: m[2], tail: m[3] } : null;
  }

  // 解析链：精确 → 唯一后缀 → 唯一「编号近邻」（s09_cron_scheduler/code.py →
  // s12_cron_scheduler/code.py：逐段相等，或同头同尾、仅数字不同）。
  // 一律要求唯一命中，否则返回 null——宁可不链，不可链错。
  function resolveSourcePath(token, files) {
    var t = String(token || "");
    if (!t || !files || !files.length) return null;
    var paths = [];
    for (var i = 0; i < files.length; i++) {
      var p = typeof files[i] === "string" ? files[i] : files[i] && files[i].path;
      if (p) paths.push(String(p));
    }
    for (var e = 0; e < paths.length; e++) if (paths[e] === t) return paths[e];

    var suffix = [];
    for (var s = 0; s < paths.length; s++) {
      if (paths[s].length > t.length && paths[s].slice(-t.length - 1) === "/" + t) suffix.push(paths[s]);
    }
    if (suffix.length) return suffix.length === 1 ? suffix[0] : null;

    var tSegments = t.split("/");
    var fuzzy = [];
    for (var f = 0; f < paths.length; f++) {
      var segments = paths[f].split("/");
      if (segments.length !== tSegments.length) continue;
      var usedNumbered = false, ok = true;
      for (var j = 0; j < segments.length; j++) {
        if (segments[j] === tSegments[j]) continue;
        var tokenSeg = numberedSegment(tSegments[j]);
        var fileSeg = numberedSegment(segments[j]);
        if (tokenSeg && fileSeg && tokenSeg.head === fileSeg.head && tokenSeg.tail === fileSeg.tail) {
          usedNumbered = true;
          continue;
        }
        ok = false;
        break;
      }
      if (ok && usedNumbered) fuzzy.push(paths[f]);
    }
    return fuzzy.length === 1 ? fuzzy[0] : null;
  }

  // 文本匹配：选中/所在块文字里出现了文件路径或文件名 → 视为要喂的文件。
  // full = 完整路径出现在文字里（确定）；base = 仅文件名命中（可能同名歧义，如每章的 code.py）。
  // files 形如 [{ path }]，由调用方传入（notes.js 传快照文件清单），本函数不做任何 IO。
  function matchFilesByText(text, files) {
    if (!files || !files.length || !text) return { full: [], base: [] };
    var full = [], base = [];
    for (var i = 0; i < files.length; i++) {
      var p = files[i].path;
      var baseName = p.split("/").pop(); // assets/styles.css → styles.css
      if (text.indexOf(p) >= 0) {
        if (full.indexOf(p) < 0) full.push(p);
      } else if (text.indexOf(baseName) >= 0) {
        if (base.indexOf(p) < 0) base.push(p);
      }
    }
    return { full: full, base: base };
  }

  var ShelfReaderCore = {
    DIFF_TOKEN_LIMIT: DIFF_TOKEN_LIMIT,
    tokenize: tokenize,
    mergeAdjacent: mergeAdjacent,
    cleanupDiff: cleanupDiff,
    tokenDiff: tokenDiff,
    markMd: markMd,
    countMarkOps: countMarkOps,
    clipSelection: clipSelection,
    makeSrcRefRe: makeSrcRefRe,
    resolveSourcePath: resolveSourcePath,
    matchFilesByText: matchFilesByText,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = ShelfReaderCore;
  else global.ShelfReaderCore = ShelfReaderCore;
})(typeof window !== "undefined" ? window : globalThis);
