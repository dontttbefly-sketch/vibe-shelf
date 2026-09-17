# 校验脚本

生成教学书后**必须**跑完 1~3；第 4 项是最终交付；第 5 项用于写作阶段验证断言；第 6 项用于做接口审计（同时产出附录全表）；第 7 项在批量追加章节后必跑。

---

## 1 · HTML 标签配对校验

放在书所在目录运行。输出"标签错误: 无"才算通过。

```python
from html.parser import HTMLParser

path = "index.html"
src = open(path, encoding="utf-8").read()
print(f"文件大小: {len(src.encode('utf-8'))/1024:.1f} KB, 字符数: {len(src)}")

VOID = {"meta","link","br","hr","img","input","source","area","base","col","embed","param","track","wbr"}

class P(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.stack = []; self.errs = []; self.counts = {}
    def handle_starttag(self, tag, attrs):
        self.counts[tag] = self.counts.get(tag, 0) + 1
        if tag not in VOID:
            self.stack.append((tag, self.getpos()))
    def handle_endtag(self, tag):
        if tag in VOID: return
        if not self.stack:
            self.errs.append(f"多余的结束标签 </{tag}> @ {self.getpos()}"); return
        if self.stack[-1][0] == tag:
            self.stack.pop()
        else:
            names = [t for t, _ in self.stack]
            if tag in names:
                while self.stack and self.stack[-1][0] != tag:
                    t, p = self.stack.pop(); self.errs.append(f"未闭合 <{t}> @ {p}")
                if self.stack: self.stack.pop()
            else:
                self.errs.append(f"孤立的 </{tag}> @ {self.getpos()}")

p = P(); p.feed(src)
for t, pos in p.stack: p.errs.append(f"未闭合 <{t}> @ {pos}")
print("标签错误:", p.errs if p.errs else "无")

key = ["section","pre","code","table","script","style","h2","h3","div","span","a","button"]
print("关键标签计数:", {k: p.counts.get(k, 0) for k in key})
```

---

## 2 · 高亮逻辑验证（必跑）

**不要只喂几个手写样本——直接对成品文件的全部代码块跑一遍**，这样能一次性覆盖所有真实边界（中文、模板字符串、转义实体、嵌套引号）。

```js
import fs from "fs";
const src = fs.readFileSync("index.html", "utf8");

// 模拟浏览器的 textContent：剥标签 + 还原实体
const decode = (s) => s.replace(/<[^>]*>/g, "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&rarr;/g, "→").replace(/&amp;/g, "&");

const blocks = [...src.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)];
let bad = 0, spans = 0;
blocks.forEach((m) => {
  let text = decode(m[1]).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  text = text.replace(
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|&lt;!--[\s\S]*?--&gt;)|("[^"\n]*"|'[^'\n]*')/g,
    (match, comment, string) =>
      string ? '<span class="c-st">' + string + "</span>" : '<span class="c-cm">' + match + "</span>"
  );
  const open = (text.match(/<span class="c-(st|cm)">/g) || []).length;
  const close = (text.match(/<\/span>/g) || []).length;
  spans += open;
  if (open !== close) {
    bad++;
    console.log("❌ 第 " + src.slice(0, m.index).split("\n").length + " 行：开 " + open + " 闭 " + close);
  }
});
console.log("代码块 " + blocks.length + " 个 / 高亮 span " + spans + " 个 / 失衡 " + bad + " 个 " + (bad === 0 ? "✅" : "❌"));
```

同时检查**代码块内的 HTML 转义**：`<pre><code>` 里只要有一个未转义的 `<`，浏览器就会把它当标签解析、内容直接消失。

```js
let badBlocks = 0;
[...src.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].forEach((m) => {
  if (/<(?=[a-zA-Z\/])/.test(m[1])) { badBlocks++; console.log("⚠️ 未转义 < ：" + m[1].slice(0, 80)); }
});
console.log("含未转义 < 的代码块：" + badBlocks);
```

---

## 3 · 截图抽查

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --virtual-time-budget=2500 --window-size=1300,1450 \
  --screenshot=/tmp/book_top.png "file:///绝对路径/index.html"
```

**⚠️ 不要用 `file://…index.html#ch21` 去截中间章节 —— headless 下会输出纯空白页**（锚点跳转在截图时刻不可靠；调 `scroll-behavior` 也救不回来）。可靠做法是生成"只显示目标章节"的临时副本：

```bash
node -e '
const fs=require("fs");
const id=process.argv[1];
const src=fs.readFileSync("/绝对路径/index.html","utf8");
const css="<style>.chapter:not(#"+id+"){display:none!important}.book-toc{display:none!important}#progress{display:none!important}</style>";
fs.writeFileSync("/tmp/only-"+id+".html", src.replace("</head>", css+"</head>"));
' ch21
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --virtual-time-budget=1800 \
  --window-size=1300,1450 --screenshot=/tmp/only-ch21.png "file:///tmp/only-ch21.html"
```

长章节（如 69 行的属性全表）用长窗口一次截完再裁切，比多次调锚点省事：

```bash
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --virtual-time-budget=2500 \
  --window-size=1300,5200 --screenshot=/tmp/long.png "file:///tmp/only-appB.html"
sips --cropToHeightWidth 1700 1300 --cropOffset 2500 0 /tmp/long.png --out /tmp/crop.png
```

截图后重点看四样：**表格有没有被挤成竖排（一行一个字 = 列宽策略坏了）、代码块文字有没有错乱、目录"待写"标记是否已清、顶部计数（"共 N 章"）是否与目录一致**。

---

## 4 · 交给用户预览

用 `present_files` 传 HTML 绝对路径 —— 它会自动打开实时预览面板。这条比截图更有用，最终一定要做。

---

## 5 · 写作阶段的断言验证

书里每一句"N 次""0 次""只在这里用了一次"都必须实测。常用命令：

```bash
# 某属性总共出现几次
grep -oh "aria-expanded" *.html assets/*.js | wc -l

# 每个文件各出现几次
grep -c "aria-expanded" index.html shop.html assets/app.js

# 列出所有 data-* 属性名（去重）
grep -oh "data-[a-z-]*" *.html assets/*.js | sort -u

# 某选择器在 CSS / JS 里各自的出现位置（用于判断是否违反"两种钩子"规范）
grep -n "\.reveal" assets/styles.css assets/app.js

# 定位 CSS 关键锚点，避免通读大文件
grep -n "^:root\|^\.class-name\|--var-name" assets/styles.css
```

**注意 zsh 下 `grep` 无匹配时返回码为 1**，用 `;` 而非 `&&` 串联，否则后续命令不执行。

---

## 6 · 接口审计（"谁生产 / 谁消费"）

这类结论最有说服力，但**脚本自己最容易错**。三个必须处理的细节都在下面这段里：

```js
import fs from "fs";
const read = (f) => fs.readFileSync("项目根/" + f, "utf8");
const html = [read("index.html"), read("shop.html")].join("\n");
const js = read("assets/app.js");
const css = read("assets/styles.css");

// 把 JS 按字符串类型切片：反引号=模板(生产) 单双引号=选择器(读取) 其余=代码
function segment(src) {
  const out = { code: "", tpl: "", str: "" };
  let i = 0, state = "code";
  while (i < src.length) {
    const ch = src[i];
    if (state === "code") {
      if (ch === "`") { state = "tpl"; out.code += " "; }
      else if (ch === '"' || ch === "'") { state = "str"; out.code += " "; }
      else if (ch === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
      else if (ch === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
      else out.code += ch;
    } else if (state === "tpl") {
      if (ch === "\\") { out.tpl += src[i + 1] || ""; i += 2; continue; }
      if (ch === "`") { state = "code"; out.tpl += " "; } else out.tpl += ch;
    } else {
      if (ch === "\\") { out.str += src[i + 1] || ""; i += 2; continue; }
      if (ch === '"' || ch === "'") { state = "code"; out.str += " "; } else out.str += ch;
    }
    i++;
  }
  return out;
}
const seg = segment(js);
const count = (s, re) => (s.match(re) || []).length;
const camel = (n) => n.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const B = "(?![a-z0-9-])";   // ← 关键：属性名边界

const names = new Set();
for (const m of (html + js).matchAll(/data-[a-z][a-z-]*/g)) names.add(m[0]);

const rows = [];
for (const n of [...names].sort()) {
  const c = camel(n);
  const hProd  = count(html, new RegExp(n + B, "g"));
  const jProd  = count(seg.tpl, new RegExp(n + B, "g"))              // 模板串里生成 HTML
               + count(js, new RegExp('setAttribute\\("' + n + '"', "g")); // ← 回到原始文本
  const readSel = count(seg.str, new RegExp(n + B, "g"));            // 引号内的选择器
  const readDs  = count(seg.code + seg.tpl, new RegExp("dataset\\." + c + "\\b(?!\\s*=)", "g")); // ← code + tpl 两份
  const cRead   = count(css, new RegExp("\\[" + n + B, "g"));        // CSS 属性选择器
  rows.push({ n, c, hProd, jProd, reads: readSel + readDs + cRead });
}
rows.forEach(r => console.log([r.n, "HTML=" + r.hProd, "JS写=" + r.jProd, "读取=" + r.reads].join("\t")));
console.log("\n属性名 " + rows.length + " 个，只生产不消费 " + rows.filter(r => r.reads === 0).length + " 个");
fs.writeFileSync("/tmp/table.tsv", rows.map(r => [r.n, r.c, r.hProd, r.jProd, r.reads].join("\t")).join("\n"));
```

**输出直接拿去生成附录全表**（见 SKILL.md 阶段 2）。用 2~3 个已知样本手工核对，再相信全量数字——本脚本的第一版就漏了属性名边界（`data-play` 被 `data-play-product` 蹭出 8 个假读取点），差点把结论写反。

---

## 7 · 拼接脚本的幂等性检查（批量追加章节后必跑）

```bash
B="index.html"
echo "重复 id 检查（应全部为 1）："
for id in preface ch4 ch20 ch21 appA appB appC appD; do
  printf "  %-8s %s\n" "$id" "$(grep -c "id=\"$id\"" "$B")"
done
echo "section 总数：$(grep -c '<section class="chapter"' "$B")"
echo "正文顺序："
grep -o '<!-- =* [^=]* =* -->' "$B" | nl
```

`id="ch21"` 计数为 2 就说明拼接脚本被执行了两次（锚点 `</section>\n</main>` 在合并后依然存在，所以"锚点唯一"的断言挡不住）。补救见 SKILL.md 阶段 5 的整段重建法。
