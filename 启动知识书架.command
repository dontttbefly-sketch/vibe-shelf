#!/bin/bash
# 知识书架 · 双击启动
cd "$(dirname "$0")" || exit 1

# Finder does not load shell profiles. Try PATH, standard installs and managed
# runtimes, validating the version instead of pinning a tool's private version.
SHELF_NODE=""
for candidate in "$(command -v node 2>/dev/null)" \
  /opt/homebrew/bin/node /usr/local/bin/node \
  "$HOME"/.nvm/versions/node/*/bin/node \
  "$HOME"/.workbuddy/binaries/node/versions/*/bin/node \
  "$HOME"/.codex/binaries/node/versions/*/bin/node; do
  if [ -x "$candidate" ] && "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1; then
    SHELF_NODE="$candidate"
    break
  fi
done

if [ -z "$SHELF_NODE" ]; then
  echo "知识书架需要 Node.js 18 或更新版本。"
  echo "请到 https://nodejs.org 安装当前 LTS 版本，再双击本文件。"
  [ -t 0 ] && read -r -p "按回车关闭此窗口……"
  exit 1
fi

echo "正在打开知识书架……"
"$SHELF_NODE" server.mjs --open --migrate-example
SHELF_EXIT=$?
if [ "$SHELF_EXIT" -ne 0 ] && [ -t 0 ]; then
  read -r -p "请按上面的说明处理后重试。按回车关闭此窗口……"
fi
exit "$SHELF_EXIT"
