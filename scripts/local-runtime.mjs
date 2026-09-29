import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const lockName = ".shelf-runtime.lock";
const infoName = ".shelf-runtime.json";

export function runtimePort(root, environment = process.env) {
  let configured = "";
  try {
    const line = fs.readFileSync(path.join(root, ".env"), "utf8")
      .match(/^\s*PORT\s*=\s*(.*?)\s*$/m)?.[1] || "";
    configured = line.replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const value = String(environment.PORT ?? (configured || "8899"));
  if (!/^\d+$/.test(value) || Number(value) > 65535) {
    throw new Error("端口设置不正确。请将 PORT 设为 1–65535 之间的整数，或删去该设置使用默认端口 8899。");
  }
  return Number(value);
}

export function canonicalDataDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return fs.realpathSync(directory);
}

// flock locks an open file description, including the copy held by Node.
// The helper exits immediately; Node keeps the descriptor until process exit.
// Keep the inode permanently: unlinking a lock file allows two owners at once.
export function acquireRuntimeLock(dataDir) {
  const descriptor = fs.openSync(path.join(dataDir, lockName), fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  let result;
  if (process.platform === "darwin") {
    result = spawnSync("/usr/bin/lockf", ["-s", "-t", "0", "3"], { stdio: ["ignore", "ignore", "pipe", descriptor] });
  } else {
    result = spawnSync("flock", ["-n", "-E", "75", "3"], { stdio: ["ignore", "ignore", "pipe", descriptor] });
  }
  if (result.status !== 0 || result.error) {
    fs.closeSync(descriptor);
    if (result.status === 75) return null;
    throw new Error("无法取得资料目录的运行锁。macOS 需要系统自带的 lockf，Linux 需要 flock；请确认目录可写后再启动。");
  }
  const identity = randomUUID();
  let released = false;
  return {
    publish(port) {
      const temporary = path.join(dataDir, `${infoName}.${identity}.tmp`);
      fs.writeFileSync(temporary, JSON.stringify({ app: "vibe-shelf", dataDir, port, pid: process.pid, identity }), { mode: 0o600 });
      fs.renameSync(temporary, path.join(dataDir, infoName));
    },
    release() {
      if (released) return;
      released = true;
      try {
        if (JSON.parse(fs.readFileSync(path.join(dataDir, infoName), "utf8")).identity === identity) {
          fs.unlinkSync(path.join(dataDir, infoName));
        }
      } catch {}
      fs.closeSync(descriptor);
    },
  };
}

export function probeShelf(port, dataDir, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const request = http.get({ hostname: "127.0.0.1", port, path: "/api/status" }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 16384) { request.destroy(); finish(null); }
      });
      response.on("end", () => {
        try {
          const status = JSON.parse(body);
          finish(response.statusCode === 200 && status.app === "vibe-shelf" && status.dataDir === dataDir ? status : null);
        } catch { finish(null); }
      });
      response.on("error", () => finish(null));
    });
    const timer = setTimeout(() => { request.destroy(); finish(null); }, timeoutMs);
    request.on("error", () => finish(null));
  });
}

export async function findRunningShelf(dataDir, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(dataDir, infoName), "utf8"));
      if (info.app === "vibe-shelf" && info.dataDir === dataDir && Number.isInteger(info.port) && info.port > 0 && info.port <= 65535) {
        if (await probeShelf(info.port, dataDir)) return info.port;
      }
    } catch {}
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return null;
}

export function openBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    const command = platform === "darwin" ? "/usr/bin/open" : "xdg-open";
    const child = spawnImpl(command, [url], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}
