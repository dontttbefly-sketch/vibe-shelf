# vibe-shelf

**把 AI 生成的项目，变成一本可以划词提问的「学习书架」。**

English: Turn any AI-built project into a learnable book — a self-contained HTML teaching book with AI-powered margin notes.

你用 AI（WorkBuddy / Claude Code / Cursor…）造了一个项目，但生成的代码你还没真正读懂。vibe-shelf 提供一条完整链路：**让 AI 把项目源码写成一本教学书，再把这本书装进一个带 AI 旁注的阅读器**——选中书里任何一句话，AI 就在旁边给你讲透。

```
你的项目（AI 生成的）
   │  ① 用 prompts/teaching-book.md 里的指令，让 AI 写书
   ▼
一本单文件 HTML 教学书（看到什么 → 代码 → 知识点 → 局限）
   │  ② node build.mjs 装进书架
   ▼
vibe-shelf 阅读器（划词提问 · AI 旁注 · 晋升正文 · 本地保存）
```

## 功能

**书（AI 生成）**
- 每章固定五段：你看到的 → 代码 → 知识点 → **局限** → 小结
- 所有断言实测验证（"出现 0 次""12 处引用"都是现场统计，不是编的）
- 单文件 HTML、零 CDN 依赖、离线可看、配色与被讲项目同源

**书架（本仓库）**
- 选中正文任意文字 → 浮出「补注释」→ AI 生成旁注，思考中有滚动的思考流
- 词/句级落锚：生成的旁注把原文那几个字加虚线下划线，刷新后仍准确定位
- 旁注气泡：毛玻璃、FLIP 飞入飞出、提问→思考丝滑过渡
- **晋升为正文**：好的旁注可以收进书里，变成可收缩的「补充」块
- **在 AI 回复里继续追问**：选中回复文字局部修改，或在末尾追加
- 旁注落盘到本地 `data/<书名>.json`，滑到底自动保存（认可即存）
- 隐性垃圾桶删除晋升块、删除注释二次确认、Markdown 星号容错……

## 快速开始

要求：Node.js 18+，以及任意 **OpenAI 兼容接口**的 API Key（OpenAI / DeepSeek / MiniMax / Kimi / 本地 Ollama 都行）。

```bash
git clone https://github.com/dontttbefly-sketch/vibe-shelf.git
cd vibe-shelf
cp .env.example .env        # 填三项：接口地址 / Key / 模型名
node server.mjs             # 启动，打开 http://localhost:8899
```

仓库已内置一本完整的示例书（PUPKIT 前端代码解剖课，22 章）——打开就能玩，选中任何文字试试「补注释」。

## 让 AI 为**你的项目**写一本

1. 打开 [`prompts/teaching-book.md`](prompts/teaching-book.md)，把开头【】里的三处替换成你的项目路径和偏好；
2. 整段交给你的 AI 编程工具，它会分批写出 20 章左右的教学书（单文件 HTML）；
3. 书写完后装进书架：

```bash
node build.mjs /path/to/书.html --book myproject --title "我的项目 · 代码教学书"
```

`--book myproject` 决定注释存到 `data/myproject.json`——不同项目的书互不干扰。

## 配置（.env）

| 变量 | 说明 |
|---|---|
| `SHELF_API_URL` | 完整的 chat/completions 端点（任何 OpenAI 兼容接口） |
| `SHELF_API_KEY` | 你的 API Key（只存在本地服务端，不进前端） |
| `SHELF_MODEL` | 模型名 |
| `PORT` | 服务端口，默认 8899 |

## 目录结构

```
vibe-shelf/
├── server.mjs          本地服务：发网页 + AI 代理（解释/局部修改）+ 注释存取
├── build.mjs           把写好的书装进书架（参数化构建）
├── public/
│   ├── index.html      书（示例：PUPKIT 前端代码解剖课，22 章）
│   ├── notes.js        旁注层逻辑（选中/气泡/晋升/追问/删除…）
│   └── notes.css       旁注层样式
├── data/               注释数据（<书名>.json，运行时生成）
├── prompts/
│   └── teaching-book.md   ★ 核心：让任何 AI 按同一套教学法写书的指令
└── skills/             WorkBuddy 用户可直接拷入全局技能库的 Skill 版本
```

## 设计原则

1. **书与壳分离**——书是 AI 生成的静态 HTML，壳（旁注层）不知道书里写了什么，只按结构约定落锚；
2. **零依赖**——服务端只用 Node 内置模块，书页不引任何外部资源，clone 下来就一个 `node server.mjs`；
3. **AI 只新增、不改正文**——旁注挂在原文旁边，错了删掉即可，书永远不会被 AI 写坏。

## WorkBuddy 用户

把 `skills/source-code-teaching-book/` 拷到 `~/.workbuddy/skills/`，之后说一句"给 XX 项目写本代码教学书"就会自动走完整流程。

## Roadmap

- [ ] 多本书切换（书架首页）
- [ ] 全文搜索 / 阅读进度记忆
- [ ] 英文界面

## License

[MIT](LICENSE)
