import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquireRuntimeLock } from "./local-runtime.mjs";

const usage = "用法：node scripts/preview-public-product.mjs [--port 8911] [--performance | --live [--migrate-from <旧 public-service 目录>]]";

export function parsePreviewArgs(args) {
  const options = { live: false, performance: false, migrateFrom: null, port: null };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error(usage);
    seen.add(arg);
    if (arg === "--live") options.live = true;
    else if (arg === "--performance") options.performance = true;
    else if (arg === "--migrate-from" && args[i + 1] && !args[i + 1].startsWith("--")) options.migrateFrom = path.resolve(args[++i]);
    else if (arg === "--port" && /^\d+$/.test(args[i + 1] || "")) options.port = Number(args[++i]);
    else throw new Error(usage);
  }
  if ((options.live && options.performance) || (options.migrateFrom && !options.live)) throw new Error(usage);
  options.port ??= options.performance ? 0 : 8911;
  if (options.port < 0 || options.port > 65535) throw new Error("验收端口必须介于 0 和 65535；0 仅供隔离 smoke 自动分配。");
  return options;
}

function regularDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("资料目录必须是真实目录，不能是符号链接。");
  return fs.realpathSync(directory);
}

// The migration manifest contains hashes and lengths, never file contents,
// cookies, OAuth tokens or model configuration.
export function snapshotPublicPreview(sourceRoot) {
  const root = regularDirectory(sourceRoot), files = {};
  const inspect = (directory, relative) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const key = path.posix.join(relative, entry.name), file = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error("迁移资料包含链接或特殊文件，已停止迁移。");
      if (entry.isDirectory()) {
        if (/^\.restore-/.test(entry.name)) throw new Error("旧资料有未完成的恢复事务，请先完成恢复再迁移。");
        inspect(file, key);
      } else {
        const bytes = fs.readFileSync(file);
        files[key] = { bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
        if (/\/(?:generation|usage)\.json$/.test(key) || /\/explorations\/[^/]+\.json$/.test(key)) {
          let record;
          try { record = JSON.parse(bytes); } catch { throw new Error("生成或用量记录无法读取，已停止迁移。"); }
          if (record.status === "generating" || record.generations?.some(item => item.status === "reserved") || record.messages?.some(item => item.status === "pending")) {
            throw new Error("旧资料仍有生成或探索任务进行中，请等待完成后再迁移。");
          }
        }
      }
    }
  };
  for (const area of ["auth", "users"]) {
    regularDirectory(path.join(root, area));
    inspect(path.join(root, area), area);
  }
  if (!fs.existsSync(path.join(root, "users", "github-900001")) || fs.existsSync(path.join(root, "users", "github-900002"))) {
    throw new Error("请选择普通本机体验账户的 public-service 目录；性能样本不能迁入真实资料。");
  }
  return { root, files };
}

function sameSnapshot(a, b) { return JSON.stringify(a.files) === JSON.stringify(b.files); }

export function migratePublicPreview(sourceRoot, targetRoot) {
  const source = snapshotPublicPreview(sourceRoot);
  const target = path.resolve(targetRoot);
  if (target === source.root || target.startsWith(source.root + path.sep) || source.root.startsWith(target + path.sep)) throw new Error("迁移的新旧资料目录必须互相独立。");
  if (fs.existsSync(target) && (!fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink() || fs.readdirSync(target).length)) {
    throw new Error("迁移目标已有资料；为避免覆盖，本次没有迁移。");
  }
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const backup = fs.mkdtempSync(path.join(parent, path.basename(target) + "-backup-"));
  const staged = fs.mkdtempSync(path.join(parent, "." + path.basename(target) + "-migrate-"));
  for (const directory of [backup, staged]) fs.chmodSync(directory, 0o700);
  try {
    for (const area of ["auth", "users"]) {
      fs.cpSync(path.join(source.root, area), path.join(backup, area), { recursive: true, errorOnExist: true, force: false });
      fs.cpSync(path.join(backup, area), path.join(staged, area), { recursive: true, errorOnExist: true, force: false });
    }
    if (![snapshotPublicPreview(source.root), snapshotPublicPreview(backup), snapshotPublicPreview(staged)].every(copy => sameSnapshot(source, copy))) {
      throw new Error("迁移期间旧资料发生变化或副本校验不一致；目标未写入，请暂停旧服务后重试。");
    }
    fs.writeFileSync(path.join(backup, "migration-manifest.json"), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), source: source.root, target, files: source.files }, null, 2), { mode: 0o600 });
    if (fs.existsSync(target)) fs.rmdirSync(target); // Only an empty target is removable.
    fs.renameSync(staged, target); // Publish the verified auth + users snapshot together.
    return { backup, source: source.root, fileCount: Object.keys(source.files).length };
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true }); // Only this invocation's private staging directory.
    throw new Error(`${error.message} 迁移备份保留在 ${backup}`);
  }
}

export function prepareLivePreview({ repo, environment = process.env, migrateFrom = null }) {
  const requested = path.resolve(environment.SHELF_PUBLIC_DATA_DIR || path.join(repo, "data", "public-service", "local-preview-live"));
  const parent = path.dirname(requested);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = path.join(fs.realpathSync(parent), path.basename(requested));
  const publicDir = fs.realpathSync(path.join(repo, "public"));
  if (root === publicDir || root.startsWith(publicDir + path.sep)) throw new Error("本机真实资料目录不能位于 public 目录内。");
  if (fs.existsSync(root)) regularDirectory(root);
  // A stable sibling lock allows the first verified migration to publish its
  // entire directory atomically. Its inode is retained across every restart.
  const lockDir = root + ".runtime";
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  regularDirectory(lockDir);
  fs.chmodSync(lockDir, 0o700);
  const lock = acquireRuntimeLock(lockDir);
  if (!lock) throw new Error("这份本机真实书架已在运行；为保护资料，本次没有启动第二个服务。");
  let dataLock;
  try {
    const migration = migrateFrom ? migratePublicPreview(migrateFrom, root) : null;
    const fresh = !fs.existsSync(root) || fs.readdirSync(root).length === 0;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.chmodSync(root, 0o700);
    // Also use the production data lock, so a normal public server explicitly
    // pointed at this same directory cannot open it alongside the preview.
    dataLock = acquireRuntimeLock(root);
    if (!dataLock) throw new Error("这份本机真实书架已在运行；为保护资料，本次没有启动第二个服务。");
    return { root, fresh, migration, lock: { publish: port => dataLock.publish(port), release() { dataLock.release(); lock.release(); } } };
  } catch (error) { dataLock?.release(); lock.release(); throw error; }
}
