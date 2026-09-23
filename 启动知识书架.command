#!/bin/bash
# 知识书架 · 双击启动
cd "$(dirname "$0")"

NODE="$HOME/.workbuddy/binaries/node/versions/22.22.2-2/bin/node"
[ -x "$NODE" ] || NODE="/usr/local/bin/node"

# 首次升级时，把内置 PUPKIT 示例迁进新的项目书架；重复运行是安全的。
"$NODE" scripts/migrate-pupkit.mjs || exit $?

# 已经在跑就直接打开
if curl -s -o /dev/null --max-time 1 "http://localhost:8899/api/projects"; then
  open "http://localhost:8899"
  exit 0
fi

( sleep 1.5 && open "http://localhost:8899" ) &
exec "$NODE" server.mjs
