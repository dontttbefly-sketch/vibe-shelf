# 书页铺成工作台 · 实施与验收

2026-09-29。最新范围是用户已确认的全屏上传与生成旅程；书架和阅读器仅接导航，继续使用既有后端模型配置。

## 已落地

- `home / library / upload / generate` 统一由 `ShelfLanding` 管理。上传为独立 `main`，不再使用上传 dialog、遮罩或关闭叉号；账户管理仍有自己的面板。
- 桌面45/55书页工作台，表单最大560px；390px单列，来源操作在首屏。沿用纸面、墨色、粘土色与宋体标题。
- 入口以首页书页或当前按钮的位置展开纸面；950ms入场、350ms返回、70ms内容次序，只动画transform/opacity。文字独立图层，扉页原旋转保留。减少动态效果为140ms淡入；键盘和刷新不重播完整入场。
- 导航可中断，旧动画不能清理新动画或抢焦点；动画时钟暂停时有到时清理兜底，避免工作台一直透明。返回恢复入口滚动和焦点，刷新与登录往返保存来源页面。
- 访客先进入上传空间，在空间内登录。本机模式明确标示真实模型与本机保存；正式服务继续要求GitHub OAuth。
- 原导入表单、来源预检、阅读目的、生成查询和同项目重试复用。工作台内进入生成状态，阶段仅来自服务端；在生成页完成则自动入架，离开后只通知。

## 真实服务和资料

8911运行方式：

```sh
node scripts/preview-public-product.mjs --live --port 8911
```

私有资料固定保存在 `data/public-service/local-preview-live/`，设有运行锁。默认不带 `--live` 仍为受控测试模式。模型Key仅在后端读取，没有新增模型适配器或公开API。

旧 `shelf-public-product-oyn5DM/data/public-service` 已先确认没有进行中的任务，再备份、迁移和重启核验。旧目录保留；备份为 `data/public-service/local-preview-live-backup-7Vauu0/`。271个原文件逐SHA校验、269个用户文件、三份旁注和源码保持一致，原会话继续有效；三本私有读本HTTP200，用量未因迁移或重启增加。私有详细记录：`data/public-service/local-preview-live/runtime-verification-2026-09-29.json`。

小型真实验收在独立8913账户完成，不占8911用户账户额度：

| 项目 | 输入与交付核验 |
| --- | --- |
| Pocket Queue | README与src/queue.js两份本地源码；5章，代码锚定到真实快照 |
| octocat/Spoon-Knife | 真实GitHub loader，固定commit `d0dd1f61b33d64e29d8bc1372a94ef6a2fee76a9`；README/index.html/styles.css三份文本；HTML/CSS引用命中快照 |

两次成功交付对应成书used=2、reserved=0、模型used=2。固定projectId重复运行只读回、不重复生成。同目录重启前后286个用户文件SHA一致，原会话、三本原书、两本新书和新增旁注恢复，用量不变；验收服务8913已停止，资料保留。细节见 `public-product/workspace-live-evidence.json`。

抽样核心解释与源码一致，但模型文字仍有过度推断，例如将class实现必然暴露内部数组，以及把未提供的图片表现写成事实。已保留原始结果及限制，不把引用正确等同于所有文字都准确，没有为修文额外调用模型。

## 自动与浏览器结果

最终自动回归349/349，0跳过；语法、diff检查通过。输出：`public-product/upload-workspace-test-results.txt`。

使用Ego Lite原TaskSpace6，p3受控测试、p1最终8911真实入口：

- 首页、页尾、书架入口；连续两次指针点击只增加一条历史记录；中途返回清理图层并恢复焦点。
- 页尾返回滚动准确恢复1280.5px；前进后退、刷新不重播全入场；键盘Enter和跳到主内容保留正确页面。
- 本地两份测试文件识别、名称/阅读目的保留；失败刷新后重试同一项目并自动入架。GitHub错误地址保留输入；生成中离开只显示完成通知。
- 未提交本地文件刷新后files=0，明确提示重新选择，名称和core目的仍保留。
- 390×844上传/生成scrollWidth均390；桌面1440×960截图已查看。最终8911内联本机登录不弹账户窗口，三本真实书仍可访问。

机器可读证据：`upload-navigation-browser.json`、`upload-entry-recovery-browser.json`、`upload-live-browser.json`（均在 `public-product/`）。截图在 `public-product/screenshots/upload-workspace-*.png`。

## 尚需真机判断

Ego Lite原生目录接口返回了空FileList；文件流程使用实际测试文件经File/DataTransfer传入，没有冒充操作系统目录选择。原生选择、拖入及真实输入设备待用户验收。

连续采样曾观察到页面visible但WAAPI时钟pending/currentTime=0跨1200ms，截图触发后可推进；已验证兜底和终态，并保存 `upload-motion-trace.json` / `upload-entry-samples.json`。不能据此宣称可靠60fps或视觉流畅度已通过，需用户在前台实际播放判断。

正式域名、实际GitHub OAuth、公网部署与支付继续后置。
