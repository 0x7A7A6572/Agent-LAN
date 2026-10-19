#!/usr/bin/env bash
# Agent-LAN 常驻循环：领活 -> 交执行体 -> 重领，无人值守
#
# 与 worker.sh 的分工：worker.sh 只管注册/心跳/领活，拿到任务就退出并打印 JSON；
# 本脚本接着干——把 JSON 交给 LLM 执行体，再重启 worker.sh 领下一轮。
#
# 一条最容易踩的约束：本脚本只驱动，不代替 LLM 干活。
# 拿到的任务若不交给执行体，会一直停在 working 直到超时，静默卡死。
set -u

MAC_DIR="${MAC_DIR:-$HOME/.mac-worker/dsh}"
NAME="${NAME:-dsh-PC-hake}"
SERVER="${SERVER:-192.168.110.47:9600}"
EXECUTOR="${EXECUTOR:-dsh}"
MAX_ROUNDS="${MAX_ROUNDS:-0}"
LOGDIR="${LOGDIR:-$MAC_DIR/logs}"
WORKER="$MAC_DIR/worker.sh"
PY="${PY:-python}"

mkdir -p "$LOGDIR"
log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOGDIR/loop.log"; }

command -v "$PY" >/dev/null 2>&1 || { log "[x] 需要 python 解析任务 JSON"; exit 1; }
[ -f "$WORKER" ] || { log "[x] 缺 $WORKER，先跑 probe.sh --install AGENT=dsh NAME=$NAME"; exit 1; }

# 执行体：默认走 PowerShell 包装器。Git Bash 直调 dsh.cmd 会栽在
# 「路径含空格 + .cmd 无执行位 + app.asar 非真实目录」三件事上，不要重试那条路。
EXEC_PS1="${EXEC_PS1:-$(dirname "$0")/lan-exec.ps1}"
if [ "$EXECUTOR" = "dsh" ]; then
  [ -f "$EXEC_PS1" ] || { log "[x] 缺执行体包装器 $EXEC_PS1"; exit 1; }
  POWERSHELL="${POWERSHELL:-powershell.exe}"
  command -v "$POWERSHELL" >/dev/null 2>&1 || { log "[x] 缺 powershell"; exit 1; }
fi

# 单实例锁：多个 worker 抢同一身份会让任务反复重投，循环永远拿不到稳定交付。
# 用 mkdir 的原子性做锁，避免并发启动。
LOCK="$MAC_DIR/.loop.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  oldpid=$(cat "$LOCK/pid" 2>/dev/null || echo "?")
  if kill -0 "$oldpid" 2>/dev/null; then
    log "[x] 已有循环在跑（pid=$oldpid），不再启动第二个。先停掉它或删 $LOCK"
    exit 1
  fi
  log "[!] 发现残留锁（pid=$oldpid 已不在），接管"
fi
echo $$ > "$LOCK/pid"
cleanup() {
  rm -rf "$LOCK"
  # 连带收掉本循环拉起的 worker，避免它变成孤儿继续抢任务
  pkill -P $$ 2>/dev/null || true
}
trap cleanup EXIT INT TERM

log "==== 常驻循环启动 name=$NAME server=$SERVER executor=$EXECUTOR pid=$$ ===="

# 启动前清掉同身份的孤儿 worker：它们会与本循环的子 worker 互抢任务
orphans=$(pgrep -f "mac-worker/dsh/worker.sh" 2>/dev/null | grep -v "^$$$" || true)
if [ -n "$orphans" ]; then
  log "[!] 发现同身份孤儿 worker：$orphans，先清掉"
  # shellcheck disable=SC2086
  kill $orphans 2>/dev/null || true
  sleep 1
fi

pick() {  # 从 MCP 信封里取正文
  "$PY" -c "$1" 2>/dev/null
}

round=0
while :; do
  round=$((round + 1))
  if [ "$MAX_ROUNDS" != "0" ] && [ "$round" -gt "$MAX_ROUNDS" ]; then
    log "已达 MAX_ROUNDS=$MAX_ROUNDS，退出"; break
  fi

  # 1) worker.sh 常驻领活；拿到任务/留言即退出并把 JSON 打到 stdout
  raw=$(bash "$WORKER" 2>>"$LOGDIR/worker.log")

  if [ -z "$raw" ]; then
    # 撞名是硬错误：换 NAME 才有救，继续循环只会刷屏
    if tail -5 "$LOGDIR/worker.log" 2>/dev/null | grep -q '节点名冲突'; then
      log "[x] 节点名冲突，停止循环（换 NAME 后重跑）"; exit 1
    fi
    log "第 $round 轮：worker 空手退出，3s 后重试"; sleep 3; continue
  fi

  echo "$raw" > "$LOGDIR/round-$round.json"

  # 2) 判别领取到的是任务还是留言
  kind=$(pick '
import sys, json
try:
    d = json.loads(sys.stdin.read())
    t = d.get("result", {}).get("content", [{}])[0].get("text", "")
    j = json.loads(t)
except Exception:
    print("PARSE_FAIL"); sys.exit()
print("TASK" if j.get("task") else ("MSG" if j.get("messages") else "EMPTY"))
' <<< "$raw")

  case "$kind" in
    TASK) ;;
    MSG)
      log "第 $round 轮：收到留言，交给执行体处理"
      ;;
    *)
      sleep 2; continue ;;
  esac

  # 3) 组装交给执行体的正文：原 prompt + 上报义务（避免执行体不知道怎么回执）
  tid=$(pick '
import sys, json
d = json.loads(sys.stdin.read())
j = json.loads(d.get("result", {}).get("content", [{}])[0].get("text", "{}"))
t = j.get("task") or {}
print(t.get("id", ""))
' <<< "$raw")

  body=$(pick '
import sys, json
d = json.loads(sys.stdin.read())
j = json.loads(d.get("result", {}).get("content", [{}])[0].get("text", "{}"))
t = j.get("task")
if t:
    print(t.get("prompt", ""))
else:
    for m in j.get("messages", []):
        print("[留言 from " + str(m.get("from")) + "] " + str(m.get("text")))
' <<< "$raw")

  if [ -z "$body" ]; then
    log "第 $round 轮：正文为空，跳过"; continue
  fi

  wrapper="$LOGDIR/round-$round.prompt.txt"
  {
    printf '%s\n' "$body"
    if [ -n "$tid" ]; then
      printf '\n\n===== 执行须知（由常驻循环附加）=====\n'
      printf '你是 Agent-LAN 节点 %s 上的执行体，上面是平台派给你的任务。\n' "$NAME"
      printf '完成后必须回执，否则任务会一直停在 working：\n'
      printf '  curl -s --noproxy "*" -X POST http://%s/mcp -H "content-type: application/json" \\\n' "$SERVER"
      printf '    -d '"'"'{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mac_report","arguments":{"taskId":"%s","name":"%s","state":"completed","text":"结果说明"}}}'"'"'\n' "$tid" "$NAME"
      printf '开工时可把 state 换成 working，失败用 failed。任务 id = %s\n' "$tid"
    fi
  } > "$wrapper"

  log "第 $round 轮：命中 $kind（task=$tid），交给 $EXECUTOR"
  start=$(date +%s)
  # 交给 PowerShell 包装器：它负责用 dsh.cmd 跑 headless，并透传退出码
  pwsh_path=$(cygpath -w "$wrapper" 2>/dev/null || echo "$wrapper")
  "$POWERSHELL" -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$EXEC_PS1")" -PromptFile "$pwsh_path" \
    >>"$LOGDIR/exec.log" 2>&1
  log "第 $round 轮：执行体退出（code=$?，耗时 $(( $(date +%s) - start ))s），重领下一轮"
done
