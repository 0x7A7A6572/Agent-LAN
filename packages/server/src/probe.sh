#!/usr/bin/env bash
# multi-agent-connect 接入体检：一次跑完，缺什么当场告诉你
# 用法: SERVER=<主服务IP:端口> bash probe.sh
SERVER=${SERVER:?用法: SERVER=<主服务IP:端口> bash probe.sh}
pass=0; fail=0
ok() { echo "[通过] $1"; pass=$((pass+1)); }
bad() { echo "[不通过] $1"; fail=$((fail+1)); }

echo "== multi-agent-connect 接入体检 =="

# 1) bash 本身（能跑这个脚本就说明有）
ok "bash 可用（$(bash --version | head -1 | cut -d ' ' -f1-3)）"

# 2) curl：下载与通信都靠它
if command -v curl >/dev/null 2>&1; then
  ok "curl 可用（$(curl --version | head -1 | cut -d ' ' -f1-2)）"
else
  bad "curl 未安装。Windows 10+ 自带 curl.exe；Git Bash/WSL 内置；或用 PowerShell 下载脚本：Invoke-WebRequest -Uri http://$SERVER/worker.sh -OutFile mac_worker.sh"
fi

# 3) 当前目录写权限：脚本和下载文件都落这里
if touch .mac_write_test 2>/dev/null; then
  rm -f .mac_write_test
  ok "当前目录可写"
else
  bad "当前目录不可写。换到有写权限的目录再跑（如 cd ~ 或项目目录）"
fi

# 4) python：可选，缺失自动降级，只报不拦
PY=$(command -v python || command -v python3 || true)
if [ -n "$PY" ]; then
  ok "python 可用（$PY）"
else
  echo "[提示] 无 python —— 不影响接入，脚本会用内置方式判别任务"
fi

# 5) 网络连通：真实发一次 MCP 握手
CODE=$(curl -s --noproxy '*' --max-time 8 -o /dev/null -w '%{http_code}' \
  -X POST "http://$SERVER/mcp" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":0,"method":"ping"}' 2>/dev/null)
if [ "$CODE" = "200" ]; then
  ok "主服务可达（http://$SERVER/mcp 握手 200）"
else
  bad "主服务不可达（HTTP $CODE）。排查：IP:端口是否对、hub 是否启动、防火墙是否放行 $SERVER"
fi

echo ""
if [ $fail -eq 0 ]; then
  echo "结论：全部通过，可以直接接入："
  echo "  curl -s --noproxy '*' http://$SERVER/worker.sh -o mac_worker.sh"
  echo "  NAME=<节点名> DESC=<一句话能力> SERVER=$SERVER bash mac_worker.sh"
else
  echo "结论：$fail 项不通过，按上面提示处理后重跑本脚本"
fi
