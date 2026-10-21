#!/usr/bin/env bash
# Agent-LAN 门铃（bell）—— 把「有活来了」翻译成「进程退出」，从而唤醒上层会话
#
# 为什么需要它
#   agent 会话是 pull 模型：模型只在宿主交给它一个事件时才会开口。宿主能产生的事件
#   只有三种 —— 用户输入、定时器、后台子进程退出。前两个不由程序控制，所以「有活
#   来了」唯一能对齐的是第三个：让宿主托管的一个子进程退出，宿主随即投递一条任务
#   结束通知，会话获得新 turn。
#   worker.sh 常驻轮询、领到任务只打印 JSON 不退出（这是为了心跳不断、不用反复重启），
#   因此它永远不会触发那个事件。本脚本补上这一环：只盯 node.json，命中即退出。
#
# 边界
#   不碰 hub、不领活、不写 node.json、不参与 worker 自更新（不会被覆盖）。
#   worker 挂了它也不接管，只在 state 长期不更新时叫醒会话去重连。
#
# 用法
#   bash ~/.mac-worker/<agent>/bell.sh          # 后台常驻，命中即退出
#   MAC_DIR=... bash bell.sh                    # 显式指定安装目录
#   BELL_INTERVAL=2 BELL_STALE_SEC=120          # 可选：轮询间隔 / 静默判死阈值
#
# 退出码
#   0 = 有新任务 / 新排队 / 新留言（去读 node.json 拿详情）
#   3 = worker 疑似已死（state.updatedAt 超过阈值没更新），需要重连 worker
#   4 = 缺少 python，无法解析 node.json

set -u

# 与 worker.sh 同目录，因此不用任何参数就能定位安装目录
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="${MAC_DIR:-$SELF_DIR}"
NJ="$DIR/node.json"
INTERVAL="${BELL_INTERVAL:-2}"
STALE_SEC="${BELL_STALE_SEC:-120}"
FLAG="$DIR/.bell.stale.notified"

PY=""
for c in python python3; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo "BELL: 需要 python 或 python3 来解析 node.json（probe.sh 体检里可查）" >&2
  exit 4
fi

# 签名只覆盖「会变且值得叫醒」的部分：working 的 taskId+since、pending 的 id 集合、
# 留言条数与末条时间。刻意不包含 state.updatedAt —— 它每轮轮询都变，会把门铃变成噪音。
sig() {
  "$PY" - "$NJ" <<'PY' 2>/dev/null
import json, sys, hashlib
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    print("NA"); raise SystemExit
st = d.get("state") or {}
w = st.get("working") or {}
pend = [str(x.get("taskId") or "") for x in (st.get("pending") or [])]
msg = [str(m.get("at") or "") for m in (st.get("messages") or [])]
key = "|".join([str(w.get("taskId") or ""), str(w.get("since") or ""),
                ",".join(pend), str(len(msg)), msg[-1] if msg else ""])
print(hashlib.sha1(key.encode()).hexdigest()[:12])
PY
}

# 只输出 ASCII 摘要：Windows 控制台码页会把中文打乱，详情一律回读 node.json
detail() {
  "$PY" - "$NJ" <<'PY' 2>/dev/null
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    print("BELL: node.json unreadable"); raise SystemExit
st = d.get("state") or {}
w = st.get("working") or {}
print("BELL: HIT node=%s working=%s since=%s pending=%d messages=%d"
      % (d.get("name"), w.get("taskId") or "-", w.get("since") or "-",
         len(st.get("pending") or []), len(st.get("messages") or [])))
PY
}

# state.updatedAt 距今秒数；解析失败回 0（视为新鲜），避免误判死
age() {
  "$PY" - "$NJ" <<'PY' 2>/dev/null
import json, sys, datetime
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
    ts = (d.get("state") or {}).get("updatedAt")
    t = datetime.datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    print(int((datetime.datetime.now(datetime.timezone.utc) - t).total_seconds()))
except Exception:
    print(0)
PY
}

BASE="$(sig)"
echo "BELL: armed dir=$DIR baseline=$BASE interval=${INTERVAL}s stale=${STALE_SEC}s"
rm -f "$FLAG" 2>/dev/null

while :; do
  sleep "$INTERVAL"
  NOW="$(sig)"

  if [ -z "$NOW" ] || [ "$NOW" = "NA" ]; then continue; fi

  if [ "$NOW" != "$BASE" ]; then
    detail
    exit 0
  fi

  # 静默守卫：state 长时间不刷新说明 worker 已不在，叫醒会话去重连（只报一次）
  if [ -f "$NJ" ] && [ ! -f "$FLAG" ]; then
    A="$(age)"
    case "$A" in ''|*[!0-9]*) A=0 ;; esac
    if [ "$A" -gt "$STALE_SEC" ]; then
      echo "BELL: STALE state.updatedAt ${A}s 未更新，worker 疑似已死，请重连"
      : > "$FLAG"
      exit 3
    fi
  fi
done
