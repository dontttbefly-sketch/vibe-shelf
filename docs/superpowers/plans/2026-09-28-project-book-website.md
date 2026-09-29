# 项目读本网站 Implementation Plan

> **For agentic workers:** 按已获授权的目标执行，任务分工不覆盖既有未提交内容。复用现有测试与隔离预览。

**Goal:** 把上传自己的项目作为官网主路径，接通定制、真实生成、叠书书架与连续阅读。

**Architecture:** 保留原生 JS 和 Node。shelf.js 负责导入及数据；landing 模块负责官网/书架路由；stack 模块负责原位预览；transition 模块负责开书/返回。

**Tech Stack:** HTML/CSS/JavaScript, Node built-in test runner, Ego browser.

---

- [x] 核对 AGENTS、工作区、远程与旧体验文档；保存新设计。
- [x] 阶段一：index.html + landing.css/js 提供官网与案例；统一样式及真实内容绑定。账户/额度入口表达真实运行模式。
- [x] 阶段二：shelf-stack.css/js 在 makeBookCard 之后挂载稳定 hover/focus 预览；只调用 preview GET；三本真实书优先验证。
- [x] 阶段三：project-service/main-book-generation/prompts 增加 readingIntent 枚举；shelf.js 加入提交与草稿恢复。测试枚举拒绝、持久化、提示词、重试。
- [x] 阶段三：生成结果返回 #library 并突出目标；保留后台完成通知和任务恢复；原生目录拖放支持。
- [x] 阶段三：shelf-transition.js / reader-session 对接选中封面的加载承接、书架状态恢复及后台完成提示。
- [x] 公共基础：用户选择 GitHub 登录后生成、访客读案例；会话、租户资料/私有书授权、浏览器命名空间、实际额度记录及账户入口完成。先本地公共验收，正式域名与真实 OAuth 后置。
- [x] 阶段四工程验收：根 Node 回归、语法与 diff 检查；浏览器三本书/长标题/窄屏/键盘/减少动效、生成刷新、失败重试、旁注保存与后台完成提示；第 75 本及陈旧请求用完整挂载回归覆盖。记录 docs/experience/public-product-evidence.md，最新完整计数以 test-results-2026-09-29.txt 为准。
- [x] 读回本轮路径，更新 PROGRESS/BLOCKED 与 .workbuddy/memory/2026-09-28.md；自动验收和用户视觉结论分开。
- [x] 收尾审计修复：预览主书/目录/小书统一开书及返回状态；公共账户个人资料管理入口与隔离导出/恢复。
- [x] 原模型公共链路隔离实测、成品复核与提示词收紧；09-29完整回归329/329，随后窄屏标题CSS以恢复样本与三本真实书浏览器复验。内容质量边界与首次未复现超时原样记录，不能视作全部验收。
- [x] 收尾浏览器功能复测：按用户要求沿用Ego Lite的TaskSpace 6，完成悬停滚动、慢网取消/重开、窄屏操作、个人资料管理/导出/恢复、真实阶段绑定与刷新入架、多书搜索/加载更多；修复窄屏标题溢出并回读。已关闭代理测试页，保留官网并交回控制。
- [ ] 可靠帧率与端到端输入延迟：已记录搜索同步布局样本；浏览器RAF调度异常，不能据此宣称60fps，待真机测量。
- [ ] 用户视觉与真机验收：官网卖点、错位叠书/悬停/开书实际感受、原生目录选择及输入设备；不以自动检查代替。
