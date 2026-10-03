#!/bin/bash
# 把当前工作区的代码发布到 VPS：打包 → 上传成一个新版本 → 切换 current → 重启服务。
# 用法：SHELF_DEPLOY_SSH=root@你的服务器 SHELF_DEPLOY_PORT=22 deploy/push.sh
set -euo pipefail
cd "$(dirname "$0")/.."
host="${SHELF_DEPLOY_SSH:?请设置 SHELF_DEPLOY_SSH，例如 root@203.0.113.7}"
port="${SHELF_DEPLOY_PORT:-22}"
release=$(date -u +%Y%m%d-%H%M%S)

# Tracked and new files that still exist, minus what the server never reads.
# Example books are gitignored locally but guests read them, so they ship too.
list=$({ git ls-files -co --exclude-standard; find public/projects -type f; } \
  | grep -vE '^(data|docs|test|deploy|\.github|\.workbuddy|\.claude)/' \
  | sort -u | while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done)
echo "打包 $(printf '%s\n' "$list" | wc -l | tr -d ' ') 个文件 → $host 版本 $release"

printf '%s\n' "$list" \
  | COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -czf - -T - \
  | ssh -p "$port" "$host" "set -e
      dir=/opt/vibe-shelf/releases/$release
      mkdir -p \$dir
      tar --no-same-owner -xzf - -C \$dir
      ln -sfn \$dir /opt/vibe-shelf/current.new
      mv -T /opt/vibe-shelf/current.new /opt/vibe-shelf/current
      systemctl restart vibe-shelf
      ls -1dt /opt/vibe-shelf/releases/* | tail -n +4 | xargs -r rm -rf
      sleep 2
      systemctl is-active vibe-shelf"
echo "已发布 $release"
