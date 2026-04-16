#!/bin/bash
cd "$(dirname "$0")" || exit 1
mkdir -p logs
# 先杀掉旧进程
if [ -f bridge.pid ]; then
  kill $(cat bridge.pid) 2>/dev/null
  sleep 1
fi
# 启动新进程（完全 detach）
nohup node bridge.mjs > logs/out.log 2> logs/err.log &
echo $! > bridge.pid
disown
sleep 2
ps -p $(cat bridge.pid) -o pid=,comm=,args=
