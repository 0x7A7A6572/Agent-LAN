#!/usr/bin/env bash
# multi-agent-connect 官方接入脚本（心跳+领活一体，断线自动重连）
#
# 用法（在能跑 bash 的机器上）:
#   curl -s http://<主服务IP>/worker.sh -o mac_worker.sh
#   NAME=<节点名> DESC=<一句话能力> SERVER=<主服务IP:端口> bash mac_worker.sh
#
# 行为: 拿到任务或留言后退出并输出完整 JSON，交上层 agent 处理；
#       空转/断线则常驻循环，无限重试。
# 依赖: curl；python/python3 可选（无则用纯 grep 判别）

NAME=${NAME:-worker-$(hostname)}
DESC=${DESC:-general worker}
SERVER=${SERVER:?缺少 SERVER 环境变量，如 192.168.110.47:9600}
WAIT_MS=${WAIT_MS:-6000}
MAX=${MAX:-100000}

FAIL=0
UNREACH=0
OK=0

log() { echo "[$(date '+%H:%M:%S')] $*" >&2; }

# MCP 工具调用: 先 initialize 拿会话，再 tools/call
mcp_call() {
  local tool="$1" args="$2"
  local sid
  sid=$(curl -s --no-keepalive --max-time 10 -D - -o /dev/null -X POST "http://$SERVER/mcp" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mac-worker","version":"0.0.1"}}}' \
    | grep -i '^mcp-session-id:' | tr -d '\r' | awk '{print $2}')
  curl -s --no-keepalive --max-time 30 -X POST "http://$SERVER/mcp" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    ${sid:+-H "mcp-session-id: $sid"} \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}"
}

for i in $(seq 1 $MAX); do
  # ---------- 1) 注册/心跳（每次循环续命，40s 无活动判离线） ----------
  HB=$(mcp_call mac_check_in "{\"name\":\"$NAME\",\"description\":\"$DESC\"}")
  if ! echo "$HB" | grep -q 'ok\\\?": *true'; then
    UNREACH=$((UNREACH+1))
    if [ $((UNREACH % 10)) -eq 1 ]; then
      log "[!] 主服务不可达（累计 ${UNREACH} 次），等待恢复…"
    fi
    sleep 5
    continue
  fi
  if [ "$UNREACH" -gt 0 ]; then
    log "[✓] 主服务已恢复（期间不可达 ${UNREACH} 次）"
    UNREACH=0
  fi

  # ---------- 2) 领活（必须带 name，长轮询挂起期间服务端保活） ----------
  OUT=$(mcp_call mac_pull_task "{\"name\":\"$NAME\",\"waitMs\":$WAIT_MS}")
  if [ -z "$OUT" ] || echo "$OUT" | grep -q 'upstream connect failed\|502'; then
    FAIL=$((FAIL+1))
    if [ $((FAIL % 10)) -eq 1 ]; then
      log "[!] 领活失败（累计 ${FAIL} 次），重试…"
    fi
    sleep 3
    continue
  fi
  FAIL=0
  OK=$((OK+1))

  # 判别领到的是任务/留言/空：优先 python，无 python 用 grep 兜底
  PY=$(command -v python || command -v python3 || true)
  if [ -n "$PY" ]; then
    KIND=$(echo "$OUT" | "$PY" -c "
import sys,json
try:
    d=json.loads(sys.stdin.read())
    t=d.get('result',{}).get('content',[{}])[0].get('text','')
    j=json.loads(t)
except Exception:
    print('PARSE_FAIL'); sys.exit()
if j.get('task'): print('TASK')
elif j.get('messages'): print('MSG')
else: print('EMPTY')
" 2>/dev/null)
  else
    if echo "$OUT" | grep -Eq '\\?"task"\\?: {'; then
      KIND=TASK
    elif echo "$OUT" | grep -Eq '\\?"messages"\\?: ['; then
      KIND=MSG
    else
      KIND=EMPTY
    fi
  fi

  if [ "$KIND" = "EMPTY" ]; then
    if [ $((OK % 20)) -eq 0 ]; then
      log "[✓] 心跳正常，已轮询 ${OK} 次"
    fi
  elif [ "$KIND" = "TASK" ] || [ "$KIND" = "MSG" ]; then
    log "===== 命中 $KIND（上报结果时务必带 name=$NAME，完成后才能解除执行中状态） ====="
    echo "$OUT"
    exit 0
  fi
done
log "达到轮数上限，退出"
