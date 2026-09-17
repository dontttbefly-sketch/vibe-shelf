#!/bin/bash
# 知识书架 · 双击启动
cd "$(dirname "$0")"

NODE="$HOME/.workbuddy/binaries/node/versions/22.22.2-2/bin/node"
[ -x "$NODE" ] || NODE="/usr/local/bin/node"

# 已经在跑就直接打开
if curl -s -o /dev/null --max-time 1 "http://localhost:8899/api/notes?book=pupkit"; then
  open "http://localhost:8899"
  exit 0
fi

( sleep 1.5 && open "http://localhost:8899" ) &
exec "$NODE" server.mjs
