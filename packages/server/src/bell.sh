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
#   worker 挂了它也不接管，只在 state 长期不更新时叫醒会话去排查（worker 还是 hub）
#
# 用法
#   bash ~/.mac-worker/<agent>/bell.sh          # 后台常驻，命中即退出
#   MAC_DIR=... bash bell.sh                    # 显式指定安装目录
#   BELL_INTERVAL=2 BELL_STALE_SEC=120          # 可选：轮询间隔 / 静默判死阈值
#
# 退出码
#   0 = 有新任务 / 新排队 / 新留言（去读 node.json 拿详情）
#   3 = 节点静默（state.updatedAt 超阈值没刷新）。输出会区分两种事故：
#       hub 不可达（去重启 hub）/ hub 正常但 worker 死了（去重连 worker）
#   4 = 缺少 python，无法解析 node.json

set -u

# 与 worker.sh 同目录，因此不用任何参数就能定位安装目录
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="${MAC_DIR:-$SELF_DIR}"
NJ="$DIR/node.json"
SEEN="$DIR/.bell.seen.json"
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

# 判定「有没有新活」，并把当前状态记进 .bell.seen.json。
#
# 关键：不能只比「状态签名有没有变」——那样「任务被清空（上报完成）」也是变化，
# 于是每干完一件活就被自己叫醒一次。这里只认三种**新增**：
#   1) working 换了一个新 taskId（派了新活）
#   2) pending 里出现没见过的 taskId（排队增加）
#   3) 留言条数变多
# 任务完成、pending 减少、留言未增，一律不算新活，只更新 seen 基线。
#
# 输出一行 ASCII（Windows 控制台码页会把中文打乱，详情请回读 node.json）：
#   HIT <reason> node=… working=… pending=N messages=N
#   STALE <age>s … server=<hub地址>
#   NOHIT
decide() {
  "$PY" - "$NJ" "$SEEN" "$STALE_SEC" <<'PY' 2>/dev/null
import json, sys, datetime

nj, seen_p, stale = sys.argv[1], sys.argv[2], int(sys.argv[3])
try:
    cur = json.load(open(nj, encoding="utf-8"))
except Exception:
    print("NOHIT"); raise SystemExit

st = cur.get("state") or {}
w = str((st.get("working") or {}).get("taskId") or "")
pend = [str(x.get("taskId") or "") for x in (st.get("pending") or [])]
msgs = len(st.get("messages") or [])

try:
    seen = json.load(open(seen_p, encoding="utf-8"))
except Exception:
    seen = None

hit, reason = False, ""
if seen is not None:
    if w and w != str(seen.get("working") or ""):
        hit, reason = True, "task"
    elif any(p not in (seen.get("pending") or []) for p in pend):
        hit, reason = True, "queued"
    elif msgs > int(seen.get("msgs") or 0):
        hit, reason = True, "message"

try:
    json.dump({"working": w, "pending": pend, "msgs": msgs},
              open(seen_p, "w", encoding="utf-8"))
except Exception:
    pass

detail = "node=%s working=%s pending=%d messages=%d" % (
    cur.get("name"), w or "-", len(pend), msgs)

if hit:
    print("HIT %s %s" % (reason, detail))
    raise SystemExit

# 静默守卫：state.updatedAt 长时间不刷新 ⇒ 有人死了，但**不一定死在本地**。
# 这一列只在 worker 成功 pull 到 hub 之后才更新，所以 hub 挂掉时它也会冻住。
# 因此只报「静默 + hub 地址」，由 bash 层再探一次 hub，区分两种事故：
#   本地 worker 死了   → 去重连 worker
#   hub 不可达         → 去重启 hub（99% 是这种情况，报「worker 已死」会带偏排查方向）
try:
    t = datetime.datetime.fromisoformat(str(st.get("updatedAt")).replace("Z", "+00:00"))
    age = int((datetime.datetime.now(datetime.timezone.utc) - t).total_seconds())
except Exception:
    age = 0
if age > stale:
    print("STALE %ds %s server=%s" % (age, detail, cur.get("server") or ""))
else:
    print("NOHIT")
PY
}

# 启动即判定一次：如果此刻已经有未处理的活（离线期间攒下的），直接叫醒，不空等

BASE="$(decide)"
echo "BELL: armed dir=$DIR interval=${INTERVAL}s stale=${STALE_SEC}s"
case "$BASE" in
  HIT*) echo "$BASE"; exit 0 ;;   # 启动瞬间就有未处理的活，直接叫醒
esac
rm -f "$FLAG" 2>/dev/null

while :; do
  sleep "$INTERVAL"
  OUT="$(decide)"

  case "$OUT" in
    HIT*)
      echo "BELL: $OUT"
      exit 0
      ;;
    STALE*)
      # 静默守卫：只报一次，避免长时间不在时反复叫醒会话。
      # 先探 hub：连不上就是 hub 挂了，不是 worker 死了——这两种事故的处理动作完全不同。
      if [ ! -f "$FLAG" ]; then
        SRV="${OUT#* server=}"
        [ "$SRV" = "$OUT" ] && SRV=""
        if [ -n "$SRV" ] && ! curl -sf -o /dev/null --max-time 3 --noproxy '*' "http://$SRV/console" 2>/dev/null; then
          echo "BELL: hub 不可达 http://$SRV —— 本地 worker 没错，是主服务挂了，去重启 hub"
        else
          echo "BELL: $OUT —— hub 正常但本地 worker 静默，请重连 worker"
        fi
        : > "$FLAG"
        exit 3
      fi
      ;;
  esac
done
