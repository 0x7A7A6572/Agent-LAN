#!/usr/bin/env bash
# Agent-LAN worker 监督：保证节点始终有人在轮询
#
# 为什么不是「按进程名计数后补拉」：worker.sh 领到任务后会以 exit 0 退出，
# 但会留下一个 20s 一跳、最长 2 小时的伴生心跳子进程，它的命令行同样是
# worker.sh —— 按名计数会误判「worker 还在」，实际已无人领活。
# 因此改用前台重启：worker 一退出就立刻拉新的，不猜、不数。
#
# 一条最容易踩的约束：本脚本只保证「有 worker 在轮询」，不代替执行任务。
set -u

MAC_DIR="${MAC_DIR:-$HOME/.mac-worker/dsh}"
WORKER="$MAC_DIR/worker.sh"
LOGDIR="${LOGDIR:-$MAC_DIR/logs}"
PENDING="$LOGDIR/pending"
RESTART_DELAY="${RESTART_DELAY:-3}"
LOCK="$MAC_DIR/.supervisor.lock"

mkdir -p "$LOGDIR" "$PENDING"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOGDIR/supervisor.log"; }

[ -f "$WORKER" ] || { log "[x] 缺 $WORKER"; exit 1; }

# 单实例：两个监督会各拉各的 worker，互相抢任务导致状态抖动
if ! mkdir "$LOCK" 2>/dev/null; then
  oldpid=$(cat "$LOCK/pid" 2>/dev/null || echo "?")
  if kill -0 "$oldpid" 2>/dev/null; then
    log "已有监督在跑（pid=$oldpid），退出"; exit 1
  fi
  log "发现残留锁（pid=$oldpid 已不在），接管"
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT INT TERM

log "==== 监督启动 pid=$$ 前台重启模式 ===="

round=0
while :; do
  round=$((round + 1))
  out=$(bash "$WORKER" 2>>"$LOGDIR/worker.log")
  code=$?

  if [ -n "$out" ]; then
    f="$PENDING/$(date '+%Y%m%d-%H%M%S').json"
    printf '%s' "$out" > "$f"
    log "第 $round 轮：worker 退出，交付内容已存 $f"
  elif tail -20 "$LOGDIR/worker.log" 2>/dev/null | grep -q '节点名冲突'; then
    log "[x] 节点名冲突（exit=$code），停止：换 NAME 后再启动"
    exit 1
  else
    log "第 $round 轮：worker 空手退出（exit=$code），${RESTART_DELAY:-3}s 后重启"
  fi

  sleep "$RESTART_DELAY"
done
