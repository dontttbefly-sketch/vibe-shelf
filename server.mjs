import path from "node:path";
import { fileURLToPath } from "node:url";
import { createShelfServer } from "./lib/app.mjs";
import { createPublicShelfServer } from "./lib/public-server.mjs";
import { createConfiguredModelClient } from "./lib/model-client.mjs";
import { acquireRuntimeLock, canonicalDataDir, findRunningShelf, openBrowser, probeShelf, runtimePort } from "./scripts/local-runtime.mjs";
import { migratePupkit } from "./scripts/migrate-pupkit.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const shouldOpen = process.argv.includes("--open");
const publicMode = process.env.SHELF_MODE === "public";

async function showReady(port, existing = false) {
  // Preserve the original origin, including existing browser-local notes.
  const url = `http://localhost:${port}`;
  console.log(`知识书架${existing ? "已在运行，继续使用" : "已启动"}： ${url}`);
  if (shouldOpen && !(await openBrowser(url))) console.log(`浏览器没有自动打开，请复制上面的地址打开书架。`);
}

async function start() {
  const port = runtimePort(root);
  const dataDir = canonicalDataDir(path.resolve(process.env.SHELF_DATA_DIR || path.join(root, "data")));
  const publicDir = path.resolve(process.env.SHELF_PUBLIC_DIR || path.join(root, "public"));
  const lockDir = publicMode ? canonicalDataDir(path.resolve(process.env.SHELF_PUBLIC_DATA_DIR || path.join(dataDir, "public-service"))) : dataDir;
  const lock = acquireRuntimeLock(lockDir);
  if (!lock) {
    const existingPort = publicMode ? null : await findRunningShelf(dataDir);
    if (existingPort) return showReady(existingPort, true);
    throw new Error("这份书架正在另一个窗口启动或退出。请稍等后重试；若一直没有打开，请查看原来的启动窗口。为保护资料，本次没有启动第二个服务。");
  }
  process.once("exit", () => lock.release());
  let server;
  try {
    // Recognize a previous version still running at the configured address.
    if (!publicMode && port && await probeShelf(port, dataDir)) {
      lock.release();
      return showReady(port, true);
    }
    const modelClient = createConfiguredModelClient({ root });
    server = (publicMode ? createPublicShelfServer : createShelfServer)({ dataDir, publicDir, modelClient });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    // Migration writes the library, so run it under the lock and only after
    // confirming the requested port is available. It completes before ready.
    if (!publicMode && process.argv.includes("--migrate-example")) migratePupkit({ repoDir: root, dataDir, publicDir });
    const actualPort = server.address().port;
    const ready = publicMode
      ? await fetch(`http://127.0.0.1:${actualPort}/api/status`).then(response => response.json()).then(status => status.app === "vibe-shelf" && status.mode === "public").catch(() => false)
      : await probeShelf(actualPort, dataDir);
    if (!ready) throw new Error("服务启动后未能通过就绪检查，请关闭此窗口并重新启动。");
    lock.publish(actualPort);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.once(signal, () => {
        console.log("正在关闭知识书架……");
        server.close(() => process.exit(0));
        server.closeIdleConnections?.();
      });
    }
    if (!modelClient.getStatus().configured) console.log(publicMode ? "模型尚未配置：公共页面可阅读案例，生成需由站点管理员配置模型。" : "模型尚未配置：可以先阅读已有书籍，在书架设置中查看配置说明。");
    if (publicMode) console.log("公众服务模式：GitHub 登录后独立保存资料；当前仍仅监听本机，公网反向代理与 TLS 需另行配置。");
    console.log("使用期间请保留此窗口；按 Control+C 可关闭服务。");
    await showReady(actualPort);
  } catch (error) {
    server?.close();
    lock.release();
    if (error.code === "EADDRINUSE") {
      throw new Error(`端口 ${port} 正被其他程序或另一份书架占用。请关闭相应程序，或在 .env 中将 PORT 改为其他端口后重试。`);
    }
    throw error;
  }
}

start().catch((error) => {
  const known = error.code === "EACCES" || error.code === "EPERM" ? "无法启动：请确认项目资料目录可读写，并允许本地服务使用端口。" : error.message;
  console.error(`知识书架未能启动：${known}`);
  process.exitCode = 1;
});
