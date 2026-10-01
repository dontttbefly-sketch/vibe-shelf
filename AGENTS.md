# AGENTS.md — 知识书架（vibe-shelf）Agent 开发指南

> 本文件写给未来在这个项目上工作的 AI Agent 与开发者。它沉淀了整个项目的设计理念、交互规范、视觉体系与踩坑清单。改代码前先读完这一页。

## 项目是什么

**把一个项目的源码变成"可以学习和继续生长的书架"**：首页是项目书架，项目主书是读者进入项目后的主界面；旁注层负责划词解释、追问、全局问答和补充卡；书底探索负责把新方向沉淀为探索小书。

一句话：**项目源码 → 主书 → 旁注/探索 → 可回看的项目知识书架**。

## 架构（根目录就是项目书架主线）

| 位置 | 职责 | 绝不做什么 |
|---|---|---|
| `public/index.html` / `public/shelf.js` / `public/shelf.css` | 项目书架首页：导入本地文件夹、展示项目小书、进入主书 | 不承担项目内页；项目点击后直接进主书 |
| `lib/main-book-generation.mjs` / `lib/prompts.mjs` | 读取项目源码快照，生成项目主书 | 不凭空编造源码里不存在的结论 |
| `lib/book-compiler.mjs` / `build.mjs` | 把书 HTML 编译成可阅读页面，注入 `SHELF_CONTEXT`、阅读器、探索入口和返回书架导航 | 不覆盖书架首页 |
| `public/notes.js` / `public/notes.css` | 唯一阅读器主线：划词旁注、气泡内追问、晋升/恢复、全局问答、插卡动效、源码抽屉（快照文件树 + 行号定位 + `文件:行号` 引用跳转 + 源码划词批注 + 快照漂移提示） | 不修改原书正文 DOM 结构；不污染原书样式 |
| `public/reader-core.js` | 阅读器纯函数区（字词级 diff、文件文本匹配、选区截断）：UMD 双端，浏览器挂 `window.ShelfReaderCore`，Node 单测直接 require；book-compiler 必须在 notes.js **之前**注入 | 不碰 DOM；不加函数以外的东西 |
| `public/explore.js` / `public/explore.css` | 书底探索会话；用户确认后生成探索小书 | 不把普通聊天自动塞进主书 |
| `lib/app.mjs` / `server.mjs` | 本地服务：静态资源、项目 API、notes/explain/followup/search、探索、小书生成、AI 代理 | 不把 API Key 暴露到前端 |
| `lib/project-service.mjs` / `lib/books.mjs` / `lib/explorations.mjs` | 项目、源码快照、书、探索记录的数据服务 | 不破坏已有项目快照的不可变性 |

**旁注层叠加原则**：所有功能都是对原书的"叠加"（浮层、高亮、锚点标记），永远不改变原书正文的结构与样式。这是整个项目能适配任何书的前提。

## 设计理念（改功能前对照检查）

1. **内容优先，工具隐形**：书是主角。旁注层的 UI 默认低存在感（低透明度、hover 才显形），但**关键动作（确认覆盖）要高对比**。隐形 ≠ 难找：hover 反馈要即时。
2. **审核优先于生成**：AI 的修改不直接覆盖用户的输入，但**追问的结果直接写回注释正文并当场标出改动**——删掉的字带中间划线、新增的字带暖色底高亮，用户一眼看到"这段变成了什么"。不做左右对照的 diff 卡，也不要求用户点"确认覆盖"（改坏了就再追问一句改回来，追问记录本身就是回退路径）。
3. **跟随直觉的定位**：所有浮层（划词浮窗、"追问这段"）锚定在**触发它的文字**上，并**跟随滚动实时重算**（活 range + scroll 重算）。鼠标下移就应该点到它。
4. **一次对话只在一个气泡里**：追问不再另开浮层小气泡——独立浮层会让气泡越开越多、上下文散掉。所有追问（末尾补充 / 改选中段）都收束到**当前注释气泡底部的输入框**。
5. **扁平的视觉层级**：禁止框套框。区分区域用**色带、留白、小标题**，不用嵌套边框。改动用字级标记（`del.nb-w-del` 划线 / `ins.nb-w-add` 高亮）就地表达；只有含块级结构的段落（代码块/列表/表格）才退化为整块色带 + 行首 `+`/`−`。
6. **性能红线**：动画只动 `transform` / `opacity` / `clip-path`（合成层属性）；`filter: blur()` 一律不做展开/删除动效；毛玻璃（backdrop-filter）只在浮层显示时启用，隐藏时摘除。
7. **书骨架固定，皮肤逐书设计**：AI 生成的主书骨架（`book-header` / `book-toc` / `book-layout` / `chapter` + `eyebrow`）与 pupkit 类名对齐，保证阅读器适配和读者肌肉记忆；视觉皮肤（配色/字体/装饰母题）由模型从项目领域取意象全新设计——新书新书皮是开书的仪式感。约束：浅色纸面系（旁注叠加层按浅色校准，禁深色主题）；配色字体不得与书架上已有书重合（指纹清单来自各书 `book.json` 的 `styleFingerprint`，由 `extractStyleFingerprint` 从生成的 `<style>` 块提取）。

## 视觉体系（配色只从这里取）

| 语义 | 色值 | 用途 |
|---|---|---|
| 主色（粘土） | `--clay #ce7b51` / 深粘土 `#993c1d` / 淡粘土底 `#fdf6f1`（hover `#fbeade`） | 主按钮、强调、diff 操作条 |
| 纸面 | `--paper #fffdf7` / `--paper-strong` / 页面底 `#f5f1ea` | 各层背景 |
| 墨色 | `--ink #151b1e` / `--muted` / `--faint` | 文字层级（faint 最浅） |
| 新增 | 字级高亮 `rgba(206,123,81,.16)`（`ins.nb-w-add`），整块色带 `rgba(206,123,81,.11)` + 左色条 | 追问新增内容、勾选 hover |
| 删除 | 字级中间划线 `rgba(178,59,46,.55)`，整块色带 `rgba(178,59,46,.05)` + 行首 `−` | 追问删去内容、危险操作 |
| 雾灰绿 | `--mist #e8f0ed` | 中性区隔（注意：低饱和下偏冷，慎当大面积底色） |

**宿主样式隔离**：diff 卡/气泡内渲染 markdown 时，原书的样式（代码块紫蓝左条、行内 code 蓝紫底字）会**渗入**——必须在容器内显式覆盖（背景、边框、`color` 三个都要，只改背景会漏字色）。

## 核心交互链路（改动前先理解全链路）

```
划词（正文） → "＋补注释"浮窗（跟随选段，页面滚动跟随） → Enter/点击 → 提问框
  → 文件勾选（data-file 祖先 + 选中文本匹配文件名；默认只勾确定的——祖先 + 完整路径命中 + 唯一 basename 命中，同名歧义的只列出不敢默认勾，平铺无框）
  → 回车/点"解释"（"解释"渐变成 ↵，方框字号颜色不变）
  → 思考态（文字滚动 + 点点点，立即开始、匀速节奏）
  → 结果（旧态模糊上移淡出 → 新内容 clip-path 连续扫开）
  → 滑到底 = 认可（只标记）；关闭气泡时一次性保存

气泡内划词 → "追问这段" chip（末字下方、chip 中心对齐末字） → 气泡底部追问输入框（不再另开浮层）
      标签行 = "追问选中的这段" + 选中内容身份牌（.nb-inline-sel：前三个字 + 省略号，暖底胶囊）
      身份牌让用户一眼确认"我选中的是这段"；不足三个字不加省略号；补充模式（＋号）无选区时身份牌隐藏
  → 发送 → 思考态（Claude 式扫光：一行短语被光带扫过 + 尾部脉冲点，短语轮换；身份牌保留）
  → 改动直接写回注释正文：
      字级标记就地生效——删掉的字带中间划线（del.nb-w-del）、新增的字带暖色底（ins.nb-w-add）
      含块级结构的段落（代码块/列表/表格）退化为整块色带 + 行首 +/−
      不复述说明书（旧版 change-summary 文案已删）；"哪次追问改的"由问句痕承担
  → 写回后追问框原地重开为 free 态（不带指令标签，只亮输入框，不抢焦点）——可反复迭代
  → 每次追问留一道问句痕（.nb-trail-item：↳ 你问：…，faint 小字一行一条）
      心智模型：正文 = 对话的最新一稿；问句列表 = 对话记录 = 版本历史（s.__versions，内存态随气泡会话消失）
      提问与改写不区分：读者在提问时，prompt 让模型把解答自然并入旁注、不要为回答写长（buildFollowupPrompt mode="free"）

源码抽屉里划选代码 → 同一个"＋补注释"浮窗 → 提问框（自动勾选该文件）
  → 批注锚定 快照文件 + 行号区间（note.source = {path, startLine, endLine}，不进 anchorMap、不标正文）
  → 抽屉行号变粘土色 + 淡暖底（.nb-src-noted），点击行 = 回看/追问；重新打开抽屉或刷新后按文件恢复
```

### 隐形快捷键（无 UI 提示，纯快捷操作）

| 操作 | 效果 |
|---|---|
| 划词后按 `Enter` | 直接唤出聊天框（正文=补注释提问框；气泡内=追问输入框） |
| 提问框/追问框内 `Enter` | 发送（勾选文件后焦点不在输入框也生效） |
| 双击标题栏空白 | 放大/缩小气泡 |
| `Esc` | 逐层退出：追问框 → 放大态 → 关闭气泡 |

### 放大与关闭

- 放大按钮、铅笔（SVG，右上擦头左下笔尖）、关闭 ×：三个按钮同语言——透明底 + `--faint`，hover 才上色；标题与按钮 `user-select: none`（双击不选中）
- 放大 = 宽度过渡到 `calc(50vw - 40px)`（右缘锚定）。**CSS 不能在 `auto` 与数值之间过渡**——定位属性参与动画时必须两侧都是数值

## 官网入口契约（主按钮 → 翻开这本书 → 书桌上的对开书）

- **主按钮** `.landing-primary`：空心粘土边框（1.5px `--clay`）、透明底、深粘土字。hover = 淡粘土底从左向右扫过（`::before` scaleX，像划词高亮）+ 箭头右上滑出、左下滑回 + 右侧英雄书微微抬起（`.landing-hero:has(.landing-primary:hover)`，入场序列完成后才联动）；按下缩到 `.975`；提交按钮"生成项目书"用同一套空心粘土样式（用户 10/1 要求改空心），在输入框下独占一行，hover 时箭头向右滑出再滑回
- **转场「翻开这本书」**（public/upload-motion.js）：**一个物体从头到尾**——真实右页（`.upload-recto`）整段都垫在英雄书封面克隆底下，两者用同一组 `translate/rotate/scale` 关键帧从英雄书的位置飞到书桌中央；封面沿书脊 `rotateY(0→-180°)`，左页（书写页 `.upload-verso`）`rotateY(180°→0)`，两者同一时钟、`backface-visibility: hidden`，在侧立的那一刻交接（封面背面就是书写页）。动效只认 verso/recto 这两个角色类，不认页面内容；窄屏两页上下叠放时，上面的书写页单独飞、下面的页随书桌淡入。书桌 `.upload-desk-surface` 在旧页拷贝上淡入，旧页退后到 `.97`。页面与英雄书同比例（0.756），所以飞行是等比缩放，不拉伸文字。**红线：任何一帧都不许出现整屏白纸，新页面内容一露出来就是真的**（用户 9/29 两次否决过"先空白后浮现""第一帧整屏白纸"；9/30 否决过"窗口裁开全屏页面"那版——擦除感、衔接不丝滑）
- **返回 = 倒放**：先完成视图切换与滚动恢复，**再**测量落点——扉页合回、封面落下，然后整本书飞回静止的英雄书（真书与旁注在落地前隐藏，结束时还原）；英雄书不可见就缩成小书收进原按钮并淡出；都不在就淡出
- **书不完整可见时**（页尾 CTA、书架页"新建项目书"、窄屏）：一本小书从按钮处（顶栏按钮则在顶栏下沿）140ms 淡入，再飞向书页、翻开
- **工作台**（用户 10/1：「填写放左侧吧，符合直觉；右侧是实时进度」）：书桌 + 一本摊开的书。**左页 = 书写页**：唯一 h1（文案随 access / idle / pending / generating / ready / failed 切换）+ **一个磨砂玻璃输入框**（项目是框顶的附件：本地文件夹标签 / GitHub 地址行；下面写侧重点；底栏"选文件夹 / GitHub"）+ 空心生成按钮；提交后输入框锁定成"这次要了什么"的记录。**右页 = 这本书的扉页 + 目录**：书名 + 侧重点实时排成副标题（空时"先看清全貌。"），下面一块玻璃目录 01 放进项目 / 02 写下侧重点 / 03 写成主书，每行只在真的发生后才打勾并写上真实内容；生成中第 03 行展开成四段细条进度（当前段脉动，不估百分比）。生成进度在表单之外，shelf.js 用 `part()`、generation-feedback 用 `workspace` 去找。≤860px 两页上下叠放，书写页在上
- **毛玻璃**：只给输入框和目录卡（半透明白 + `backdrop-filter: blur(20px)` + 亮边），它们背后各有一团柔光（左页粘土色、右页雾绿），书桌本身是暖光渐变；翻页过程中 `body[data-workspace-motion]` 摘掉 blur（3D 翻转里的 backdrop-filter 不可靠，背后是平滑渐变所以切换看不出来）
- **侧重点**（`readingFocus`，≤500 字）：导入接口规范化后写进 project.json / 书的 book.json / 项目摘要；主书 prompt 按行 `>` 引用原话，默认的"快速理解"目的让位；同一导入标识换了侧重点返回 409；不填就是原来的全貌读法
- **逐帧验收**：派发 `detail: 1` 的 click，同步段内临时拦住兜底定时器，随后 `document.getAnimations()` 全部 pause 并设 `currentTime` 截图

## 源码联动契约（生成期）

一句话：**行号的唯一可信来源是快照，不是模型的自述**。模型负责指认（写路径、摘代码），服务端负责锚定（内容确定性匹配），阅读器负责兜底（解析唯一才链）。

- **正文引用**：prompt 只要求模型写完整相对路径（给出文件清单、明确不用写行号——dump 不带行号，模型数不出来）。阅读器 linkify 走 reader-core.js 的 `makeSrcRefRe()` + `resolveSourcePath()`（精确 → 唯一后缀 → 唯一"编号近邻"：`s09_cron_scheduler/code.py` → `s12_cron_scheduler/code.py`，同头同尾、只有数字不同），**一律唯一命中才链**；无行号时路径必须含 `/`（裸 `code.py` 歧义太大，不链）。解析不出的引用保持纯文本（只链不改）；hover 预览头显示"书中写作 X"，让读者看见书里写的和解析到的不一致。
- **代码块锚定**：编译期（book-compiler → lib/source-link.mjs）把 `<pre><code>` 内容对快照做逐行窗口匹配（`MIN_RUN=5` 连续行），命中才注入 `data-file`/`data-line`（行号 = 命中文件行 − 块内偏移）。歧义（样板代码在多个章节逐字重复）先按"代码文件 > 中文文档 > 无语言 > 英文 > 其他语言"定序，再按块前最近的引用消歧，消不掉就放弃——跳错行比不跳更伤信任。
- **存量书复活**：`node scripts/relink-main-book.mjs <projectId> [--dry-run]` 按当前规则重新编译发布主书（不动 source.html、不调模型）。
- **生成选材顺序**（lib/main-book-generation.mjs `promptPriority`）：根 README → 清单文件 → 代码 → 文档 → 语言变体（`.ja.md`、`docs/ja/` 这类）；预算不够时先砍语言变体。预算由 `SHELF_PROMPT_BUDGET_BYTES` 覆盖（默认 2.5MB ≈ 1M 上下文）。

## 部署与运行模式

- **本地完整版**：`node server.mjs`（.env 填 OpenAI 兼容接口）→ 项目导入（本地文件夹 / GitHub 公开仓库 `POST /api/projects/import-github`，lib/github-import.mjs 拉文本文件、共用 IMPORT_LIMITS）、主书生成、旁注、探索和小书生成；配 `GITHUB_TOKEN` 可提高 API 限额
- **静态演示版**（GitHub Pages）：阅读、划词、本地批注（localStorage）全部可用；AI 接口自动降级——toast 提示"clone 本地运行"。降级标记 `STATIC_MODE`，入口：启动 fetch 失败、explain/followup 拦截、persist/delete 落 localStorage
- **Pages 部署**：`.github/workflows/pages.yml`，push main 先跑 `npm test`，通过后部署 `public/` 到 Pages（https://dontttbefly-sketch.github.io/vibe-shelf/）。首页按 `*.github.io` 识别静态演示：landing.js 不问账户接口、上传页照常可试但提交被拦下并提示本地运行，案例区读 `public/static-demo.json`（只收随站点发布的 PUPKIT；主书改了要从本地 `/api/examples/pupkit/preview` 重新生成），shelf.js 不轮询书架接口。站内链接必须相对或经 `safePath` 落在站点基路径 `/vibe-shelf/` 下
- **单独编译一本书**：`node build.mjs <书.html> --book <名字> --out public/books/<名字>/index.html`

## Agent 开发流程（每次改动的标准动作）

1. **改动前**：读完本文件对应章节；`git fetch` 看远程（用户会网页端改仓库）
2. **改 JS 后**：`node -c public/notes.js` 语法检查必过
3. **改 diff/解析算法**：先用 node 单测核心函数（拆出来跑用例），再进浏览器
4. **改 build.mjs**：重新 build 并 `grep` 验证产物（如 data-file 属性数量）
5. **验证方式**：服务跑起来后用 curl 验 API（含防穿越/非法路径），视觉由用户真机验收——**不要凭想象报告"已完成"**，只报告实测过的部分
6. **记忆**：每轮改动写进 `.workbuddy/memory/当日.md`（含用户原话、根因、教训）

## 踩坑清单（每条都真实踩过）

- **CSS `auto ↔ 数值` 不可过渡**：宽度动画两端必须都是数值（`392px ↔ calc(50vw - 40px)`），`left: auto` 起步会跳变
- **inline transition 会挡 CSS transition**：入场动画用 inline transition 后必须清理（setTimeout 清空），否则后续属性过渡全失效
- **setInterval 首跳延迟**：周期动画用 setInterval 会有"开头静止期"（用户感知"开头慢后面快"）→ 用 setTimeout 链、启动即执行第一次
- **抽函数前核对全局依赖赋值时序**：曾因 `subchip = chip` 赋值晚于 `positionSubchip()`（内部判 `if (!subchip) return`）导致 chip 永远没定位
- **删变量前 grep 全部引用**：曾删 `askRollerStop` 声明漏了 closeAskPop 里的引用，严格模式一调用就 ReferenceError
- **clearDiff 类清理函数先读后清**：revertDiff 曾先 clearDiff 再读 `__diffInstruction`，回填永远是空
- **saveNote 有副作用**（`resultState = null`）：不能在结果态展示中途调用——"滑到底"只做标记，关闭气泡时统一保存
- **diff 内嵌 markdown 渲染**：宿主书样式（pre 左条、code 底色**和字色**）会渗入，容器内显式中性化要背景/边框/color 三个都覆盖
- **`hidden` 属性会被 `display` 覆盖**：给元素设了 `display: flex/inline-flex` 后，`hidden` 属性失效（UA 的 `[hidden]{display:none}` 被作者样式压掉）→ 必须补一条 `[hidden] { display: none; }`，否则"该藏的东西还显着"
- **标签行改成 flex 后文本节点会错位**：原来 `label.textContent = ...` 一把梭，加了身份牌后必须拆成 `.nb-inline-label-text` + `.nb-inline-sel` 两个子元素分别写，否则 `textContent` 会把身份牌一起抹掉
- **字级 diff 会碎**：纯 LCS 会把「很危险」切成 `删:很危 / 增:存在注入风 / 留:险`——必须做**语义清理**：夹在增删之间的一两个相同字并入增删块（`cleanupDiff`），否则读起来像乱码
- **`mask-image` 会裁掉首字**：给扫光容器做左右双向渐隐时，左侧 `transparent 0` 会把文字第一个字也吃掉 → 只遮右缘溢出（`#000 0, #000 86%, transparent 100%`）
- **光带透明度要克制**：扫光带叠加在文字上，中心透明度 >.2 就会"糊住字"，观感变成加载遮罩而非思考提示
- **代码块不能被行级 diff 切碎**：diff 粒度用"块"（代码块整体、段落按空行），切行会碎
- **transform 会盖 inline 定位**：浮层跟随用 left/top 数值重算（positionAskPop/positionSubchip），不要用 transform 定位
- **managed node 路径以当轮 binary_context 为准**（版本目录会变，如 22.22.2-3）
- **gh api 偶发 EOF**（代理抖动）：脚本内带重试
- **cleanupDiff 的顺序归一化必须放在合并循环之前**：LCS 回溯天然产出 add 在前，先归一化成"先删后增"再跑 del/add/same 模式匹配，否则后缀/前缀共字合并永远匹配不上（曾是「很危险→存在注入风险」碎块残留的根因）
- **书皮窄屏 MQ 转 column 后若保留 `align-items: flex-start`**：.book-main 变内容自适应宽，宽表格/长代码行的 min-content 直接撑出视口 → 阅读器层在移动端 MQ 里钉 `width:100%` + 表格 `display:block; overflow-x:auto`，不动书 DOM
- **编辑含 `\uXXXX` 转义序列的旧代码别用 Edit 工具硬贴**：JSON 参数会把 `\u0002` 解析成真实控制字符，永远匹配不上——按行号用脚本替换
- **主书 token 契约**：生成书 `<style>` 的 `:root` 必须含 `--paper/--ink/--code-bg/--code-ink/--line`（夜间模式靠重映射它们），`lintSkinTokens` 只警告不失败，缺了会进 generation 状态的 `skinWarnings`
- **别让模型报行号**：dump 给模型的文件不带行号，它数不出来——实测一本 21 个代码块的书 0 个行号引用（索性全不写），旧 prompt 的"标注文件:行号"契约等于没写。行号必须由服务端按内容锚定
- **编号近邻正则会漏 `s` 前缀**：`s09_cron_scheduler` 这类目录是"字母+数字+下划线"，`/^(\d+)_/` 永远匹配不上，编号纠偏整条失效——`numberedSegment` 用 `/^(.*?)(\d+)_(.+)$/` 取"同头同尾"
- **引用正则要防截断**：没有尾部 lookahead `(?![A-Za-z0-9_])` 时 `app.tsx` 会被匹配成 `app.ts`，漏出的 `x` 被当成正文（扩展名交替顺序救不了，必须回溯 + 边界）
- **同特异性下写在后面的 `:hover` 会盖住 `:active`**：媒体查询不加特异性，曾导致桌面端按下反馈完全看不到——按下态必须写在 hover 规则之后
- **克隆节点里插 `<style>` 不会被作用域化**：往旧页拷贝里塞 `*{animation:none!important}` 会冻结全页动画 → 冻结规则写进 CSS、挂在拷贝根类上（`.upload-motion-copy *`）；WAAPI 不受 `animation:none` 影响
- **隐藏元素的 `getBoundingClientRect()` 全是 0**：曾让返回动画缩向左上角 (0,0)——落点必须在视图切换 + 滚动恢复之后再量
- **正立的 clip-path 窗口盖不住斜着的封面**：窗口起点要用斜封面的内接正立矩形，否则第一帧四角就漏出新页面；叠在书上的元素（旁注卡）要单独成层，否则会被窗口切掉
- **Ego 里别全局替换 `window.setTimeout`**：Ego 注入页面的脚本也用它，替换后 evaluate 会永远挂起；只在派发点击的同步段里临时拦截，`finally` 立刻还原
- **翻页的 perspective 要按页宽取远**：`perspective(3×页宽)` 时翻到 60° 的自由边放大 1.4 倍，整页冲出屏幕上下沿，像镜头扑过来；取 8×页宽，自由边最多放大约 1/7，仍有纵深
- **两面同轴翻页**：封面 `rotateY(0→-180°)` 与扉页 `rotateY(180°→0)` 必须同一时钟、同一缓动、都 `backface-visibility: hidden`，才会在侧立那一刻无缝交接；飞行用同一组关键帧同时驱动真实书页与封面克隆，两者的 transform-origin 都落在右页中心
- **`ego-browser nodejs -e` 的脚本里出现 `<` 会无输出挂住**：含比较运算的脚本一律走 heredoc（`ego-browser nodejs <<'EOF'`）；后台运行时 stdout 到进程结束才落盘，看不到中途进度
- **Ego 在 `chrome://` 新标签页上发 `Emulation.*` 会挂住**：先 `goto` 到站点再设视口
- **只改 hash 的 `goto` 不会重新加载**：`/` → `/#upload` 是同文档导航，刚改的 CSS 不生效——验收前先 `page.reload()`
- **`@container` 里的规则同样要排在同特异性的基础规则之后**：容器查询不加特异性，写在前面就被盖掉（手机上生成按钮不换行的根因）
- **vm 里造出来的数组过不了 `deepStrictEqual`**：原型来自另一个 realm，比较前先 `JSON.parse(JSON.stringify(...))`

## 设计原则三句话（写代码犹豫时看这里）

1. **阅读器不打扰书，AI 不越过用户**——所有 AI 输出必须经人工审核落地
2. **能隐形就隐形，该确认就醒目**——浏览时工具退后，决策时对比前置
3. **每 60fps 都是欠的债**——只动合成层属性，滚动重算用活引用不重建 DOM
