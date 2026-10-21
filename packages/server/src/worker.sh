#!/usr/bin/env bash
# Agent-LAN 官方接入脚本（心跳+领活一体，断线自动重连）
#
# 用法（在能跑 bash 的机器上）:
#   curl -s http://<主服务IP>/worker.sh -o mac_worker.sh
#   NAME=<节点名> DESC=<一句话能力> SERVER=<主服务IP:端口> bash mac_worker.sh
#
# 行为: 常驻轮询不退出。领到任务/留言只打印 JSON 继续轮询；
#       任务执行期间 worker 本体继续跳（心跳+收留言），不再依赖
#       上层 agent「记得重启」——多轮遗忘重启是旧版的核心缺陷。
# 依赖: curl；python/python3 可选（无则用纯 grep 判别）
# 版本由 hub 构建时按脚本内容哈希注入，节点据此自动更新

WORKER_VERSION=__VERSION__

# 安装根 ~/.mac-worker/<agent>/：每 agent 一目录，脚本/配置/身份互不干扰
# AGENT 判定：env AGENT > 从安装路径提取 > 缺省 default；WSL 回退共享 Windows 主目录
MAC_ROOT=""
if [ -d "$HOME/.mac-worker" ]; then
  MAC_ROOT="$HOME/.mac-worker"
elif [ -n "$WSL_DISTRO_NAME" ] && [ -d "/mnt/c/Users" ]; then
  WUSER=$(cmd.exe /c "echo %USERNAME%" 2>/dev/null | tr -d '\r\n' | tr -d '\r')
  for cand in "/mnt/c/Users/$WUSER/.mac-worker" /mnt/c/Users/Public/.mac-worker; do
    if [ -d "$cand" ]; then MAC_ROOT="$cand"; break; fi
  done
fi
AGENT=${AGENT:-}
if [ -z "$AGENT" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  case "${BASH_SOURCE[0]}" in
    */.mac-worker/*/worker.sh)
      AGENT=$(basename "$(dirname "${BASH_SOURCE[0]}")")
      ;;
  esac
fi
AGENT=${AGENT:-default}
MAC_DIR="$MAC_ROOT/$AGENT"
if [ -n "$MAC_ROOT" ] && [ -f "$MAC_DIR/node.json" ]; then
  # 自校：安装目录名 vs node.json 记录的 agent 不一致 = 目录被手动挪过/复制错位
  if grep -q '"agent"' "$MAC_DIR/node.json" 2>/dev/null; then
    JA=$(grep -o '"agent": *"[^"]*"' "$MAC_DIR/node.json" | cut -d'"' -f4)
    [ -n "$JA" ] && [ "$JA" != "$AGENT" ] && log "[!] 警告：目录名 $AGENT 与 node.json 记录的 agent「$JA」不一致，建议重新 probe.sh --install 归位"
  fi
  # node.json 持久身份：同 agent 任何会话裸启动不丢
    eval "$(sed -n 's/.*"\(name\|desc\|server\|agent\|role\)": *"\([^"]*\)".*/J_\1='"'"'\2'"'"'/p' "$MAC_DIR/node.json" 2>/dev/null)" 2>/dev/null
fi

NAME=${NAME:-${J_name:-worker-$(hostname)}}
DESC=${DESC:-${J_desc:-general worker}}
SERVER=${SERVER:-${J_server:-}}
# 角色由控制台设定后写回 node.json，节点启动时据此知道自己岗位
ROLE=${ROLE:-${J_role:-}}
if [ -z "$SERVER" ]; then
  echo "[x] 缺少 SERVER。首次安装：SERVER=<主服务IP:端口> bash probe.sh --install AGENT=<agent名> NAME=<节点名>" >&2
  echo "    或手动：SERVER=<主服务IP:端口> AGENT=<agent名> NAME=<节点名> bash worker.sh" >&2
  exit 1
fi
# 身份+配置持久化：首次成功连接后写 node.json
save_env() {
  [ -n "$MAC_ROOT" ] || return 0
  mkdir -p "$MAC_DIR"
  # role 由控制台写入、state/session 由 worker 维护：
  # 重写身份时不能冲掉这些块，否则每次注册丢一次
  local keep_role="" keep_state="" keep_session=""
  if [ -f "$MAC_DIR/node.json" ]; then
    keep_role=$(grep -o '"role": *"[^"]*"' "$MAC_DIR/node.json" 2>/dev/null | cut -d'"' -f4)
    keep_state=$(sed -n '/^  "state": {/,/^  }/p' "$MAC_DIR/node.json" 2>/dev/null)
    keep_session=$(sed -n '/^  "session": {/,/^  }/p' "$MAC_DIR/node.json" 2>/dev/null)
  fi
  # 先拼主体，再按需追加各块：heredoc 条件插入易吃引号，改用拼接
  local body
  body=$(printf '{\n  "agent": "%s",\n  "name": "%s",\n  "desc": "%s",\n  "server": "%s"' \
    "$AGENT" "$NAME" "$DESC" "$SERVER")
  if [ -n "$keep_role" ]; then
    body="$body,"$'\n'"  \"role\": \"$keep_role\""
  fi
  if [ -n "$keep_session" ]; then
    body="$body,"$'\n'"$keep_session"
  fi
  if [ -n "$keep_state" ]; then
    body="$body,"$'\n'"$keep_state"
  fi
  printf '%s\n}\n' "$body" > "$MAC_DIR/node.json"
}
# 会话持有标记：MAC_SESSION_ID 由上层会话启动时注入（install.md 约定）
save_session() {
  [ -n "$MAC_ROOT" ] || return 0
  [ -n "$MAC_SESSION_ID" ] || return 0
  python - "$MAC_DIR/node.json" "$MAC_SESSION_ID" <<'PYEOF' 2>/dev/null
import json, sys, datetime
p, sid = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(p, encoding="utf-8"))
except Exception:
    sys.exit(1)
d["session"] = {"id": sid, "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds")}
json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
  # python 失败时 sed 兜底：顶层闭合行前插 session 块（平铺身份时可用）
  if [ $? -ne 0 ] && ! grep -q '"session"' "$MAC_DIR/node.json" 2>/dev/null; then
    sed -i 's/^}$/  ,"session": {"id": "'"$MAC_SESSION_ID"'", "startedAt": "'"$(date -u +%FT%T.%3NZ)"'"}/}' "$MAC_DIR/node.json" 2>/dev/null
  fi
  return 0
}
# state 块落盘：working/pending 来自 hub pull 应答，messages 本地累积。
# 原子写：先 tmp 再 mv，读方永远看到完整 JSON。
# 中文经 stdin/argv 都会被 Windows python 按本地码页搞乱，
# 三段 JSON 一律走临时文件传字节，python 用 UTF-8 显式读回
save_state() {
  # $1=working JSON(null/对象) $2=pending JSON(数组) $3=messages JSON(数组)
  [ -n "$MAC_ROOT" ] || return 0
  local tmp="$MAC_DIR/node.json.tmp"
  local iw ip im
  iw="$MAC_DIR/.st.work" ip="$MAC_DIR/.st.pend" im="$MAC_DIR/.st.msg"
  printf '%s' "$1" > "$iw"; printf '%s' "$2" > "$ip"; printf '%s' "$3" > "$im"
  rm -f "$tmp"
  python - "$MAC_DIR/node.json" "$iw" "$ip" "$im" "$tmp" <<'PYEOF' 2>/dev/null
import json, sys, datetime, os
p, iw, ip, im, tmp = sys.argv[1:6]
def loadf(fp):
    try:
        with open(fp, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None
try:
    d = loadf(p) or {}
except Exception:
    d = {}
msgs = d.get("state", {}).get("messages", [])
new_msgs = loadf(im) or []
# 按 (at,text) 去重合并：会话可能已把旧留言标 consumed，不能丢标记
merged = {(m.get("at"), m.get("text")): m for m in msgs}
for m in new_msgs:
    merged[(m.get("at"), m.get("text"))] = m
out_msgs = list(merged.values())[-20:]
pend = loadf(ip) or []
work = loadf(iw)
d["state"] = {
    "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds"),
    "online": True,
    "working": work,
    "pending": [{"taskId": x.get("id"), "summary": (x.get("prompt") or "")[:200], "createdAt": x.get("createdAt")} for x in pend],
    "messages": out_msgs,
}
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(d, f, ensure_ascii=False, indent=2)
for f in (iw, ip, im):
    try: os.remove(f)
    except Exception: pass
PYEOF
  [ -f "$tmp" ] && mv -f "$tmp" "$MAC_DIR/node.json"
  return 0
}
WAIT_MS=${WAIT_MS:-6000}
MAX=${MAX:-100000}
# python 探测一次定终身：state 落盘与 KIND 判别共用
PY=$(command -v python || command -v python3 || true)

FAIL=0
UNREACH=0
OK=0

log() { echo "[$(date '+%H:%M:%S')] $*" >&2; }

# 更新结果上报 hub：best-effort，失败不拖垮本地流程
report_update() {
  # [D8] Windows curl 的 -d 非 ASCII 按 ANSI 码页重编码，载荷必须走文件。
  # 固定名就地覆盖：report_update 串行低频调用，无并发覆盖风险
  local pf; pf="${MAC_DIR:-$HOME/.mac-worker/${AGENT:-default}}/.payload.ru.json"
  printf '%s' "{\"name\":\"$NAME\",\"level\":\"$1\",\"message\":\"$2\"}" > "$pf"
  curl -s --max-time 5 -X POST "http://$SERVER/worker/update-report" \
    -H 'content-type: application/json' \
    -d "@$pf" >/dev/null 2>&1 || true
}

# 自更新：hub 版本与本地不一致时拉新脚本，校验后原子替换并 exec 重启
# 仅对落盘运行的脚本生效；curl|bash 直跑无可替换文件，跳过并提示
self_update() {
  local ver="$1"
  [ -f "$NEWF" ] && rm -f "$NEWF"
  if ! curl -s --max-time 15 "http://$SERVER/worker.sh" -o "$NEWF" || [ ! -s "$NEWF" ]; then
    log "[!] 自更新下载失败，沿用当前版本继续"
    report_update error "下载失败，沿用版本 $ver"
    return 0
  fi
  grep -q 'WORKER_VERSION=' "$NEWF" && grep -q 'mac_check_in' "$NEWF" || {
    log "[!] 自更新内容校验不过（非 worker 脚本），放弃"; rm -f "$NEWF"
    report_update error "内容校验不过，放弃更新"
    return 0
  }
  local nv
  nv=$(grep -m1 'WORKER_VERSION=' "$NEWF" | sed 's/.*=//;s/"//g')
  [ "$nv" = "$ver" ] && { rm -f "$NEWF"; return 0; }
  if [ ! -w "$(dirname "$SELF")" ] || [ ! -w "$SELF" ]; then
    log "[!] 脚本文件不可写，跳过自更新（版本 $ver -> $nv）"; rm -f "$NEWF"
    report_update error "脚本不可写，卡在版本 $ver（目标 $nv）"
    return 0
  fi
  mv "$SELF" "$BAKF" && mv "$NEWF" "$SELF" || { log "[!] 替换失败，放弃自更新"; rm -f "$NEWF"
    report_update error "替换失败，放弃更新"; return 0; }
  chmod --reference="$BAKF" "$SELF" 2>/dev/null || chmod +x "$SELF" 2>/dev/null
  log "[↑] 已更新到版本 $nv，重启脚本（旧版存于 $BAKF）"
  report_update info "已更新 $ver -> $nv，重启脚本"
  exec bash "$SELF"
}

# MCP 工具调用: 先 initialize 拿会话，再 tools/call
mcp_call() {
  local tool="$1" args="$2"
  local sid pf
  # [D8] -d 内联非 ASCII 会被 mingw64/curl 按 ANSI 代码页重编码，
  # 中文到 hub 全变 U+FFFD，载荷必须走文件。
  # 文件名用固定名（不按 BASHPID）：命令替换会 fork 新子进程、
  # BASHPID 每次都变，「每进程一个」实际每轮一个新文件，一天堆上万个
  # （实测 1757 个）。主循环与 save_state 都是串行调用，固定名互不覆盖；
  # 就地覆盖不删除，规避 safe-delete 对高频 rm 的审批拦截
  pf="${MAC_DIR:-$HOME/.mac-worker/${AGENT:-default}}/.payload.json"
  printf '%s' "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}" > "$pf"
  sid=$(curl -s --no-keepalive --max-time 10 -D - -o /dev/null -X POST "http://$SERVER/mcp" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mac-worker","version":"0.0.1"}}}' \
    | grep -i '^mcp-session-id:' | tr -d '\r' | awk '{print $2}')
  curl -s --no-keepalive --max-time 30 -X POST "http://$SERVER/mcp" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    ${sid:+-H "mcp-session-id: $sid"} \
    -d "@$pf"
}

for i in $(seq 1 $MAX); do
  # ---------- 1) 注册/心跳（每次循环续命，40s 无活动判离线） ----------
  HB=$(mcp_call mac_check_in "{\"name\":\"$NAME\",\"agent\":\"$AGENT\",\"description\":\"$DESC\",\"host\":\"$(hostname)\"}")
  # 应答是 JSON-in-JSON：剥掉字段名的转义反斜杠，后续 grep 一律用普通模式
  HB=$(echo "$HB" | sed 's/\\"/"/g')
  if echo "$HB" | grep -q '节点名 .* 已被主机'; then
    log "[x] 节点名冲突：$(echo "$HB" | grep -o '节点名 [^"]*')"
    log "[x] 请停掉本脚本，换一个 NAME 重新启动（同机多实例 NAME 必须各不相同）"
    exit 1
  fi
  if ! echo "$HB" | grep -q 'ok": *true'; then
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
  # 首次成功连接：记忆节点身份与配置，此后同 agent 任何会话免参数启动
  if [ -n "$MAC_ROOT" ] && [ ! -f "$MAC_DIR/node.json" ]; then
    save_env
    log "[✓] 节点身份已记忆到 $MAC_DIR/node.json，下次直接 bash $0 启动"
  fi
  # 会话持有标记：仅在未记录时写入一次，避免每轮覆盖 startedAt
  if [ -n "$MAC_SESSION_ID" ] && ! grep -q '"session"' "$MAC_DIR/node.json" 2>/dev/null; then
    save_session
    log "[✓] 会话持有已记录到 node.json（$MAC_SESSION_ID）"
  fi

  # ---------- 1.5) 版本检查：hub 版本不同则自更新并重启 ----------
  # HB 已剥转义，直接匹配普通 JSON 字段
  HV=$(echo "$HB" | grep -o '"workerVersion":"[^"]*"' | cut -d'"' -f4)
  if [ -n "$HV" ] && [ "$HV" != "$WORKER_VERSION" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    log "[↑] 发现新版本 $HV（当前 $WORKER_VERSION），开始自更新"
    report_update info "发现新版本 $HV（当前 $WORKER_VERSION），开始自更新"
    self_update "$HV"
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

  # state 落盘与判别共用一个提取：双层 json.loads 解 JSON-in-JSON。
  # Windows python 默认按本地码页读管道，中文必须显式切 UTF-8，
  # 否则 json.loads 直接抛错（Kind 判别退 PARSE_FAIL、state 不落盘）
  if [ -n "$PY" ]; then
    KIND=$(echo "$OUT" | "$PY" -c "
import sys,json
try:
    sys.stdin.reconfigure(encoding='utf-8')
    d=json.loads(sys.stdin.read())
    t=d.get('result',{}).get('content',[{}])[0].get('text','')
    j=json.loads(t)
except Exception:
    print('PARSE_FAIL'); sys.exit()
if j.get('task'): print('TASK')
elif j.get('messages'): print('MSG')
else: print('EMPTY')
" 2>/dev/null)
    STATE_W=$(echo "$OUT" | "$PY" -c "
import sys,json
try:
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    d=json.loads(sys.stdin.read())
    t=d.get('result',{}).get('content',[{}])[0].get('text','')
    j=json.loads(t)
    print(json.dumps(j.get('working'), ensure_ascii=False))
except Exception:
    print('null')
" 2>/dev/null)
    STATE_P=$(echo "$OUT" | "$PY" -c "
import sys,json
try:
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    d=json.loads(sys.stdin.read())
    t=d.get('result',{}).get('content',[{}])[0].get('text','')
    j=json.loads(t)
    print(json.dumps(j.get('pending',[]), ensure_ascii=False))
except Exception:
    print('[]')
" 2>/dev/null)
    STATE_M=$(echo "$OUT" | "$PY" -c "
import sys,json
try:
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    d=json.loads(sys.stdin.read())
    t=d.get('result',{}).get('content',[{}])[0].get('text','')
    j=json.loads(t)
    print(json.dumps(j.get('messages',[]), ensure_ascii=False))
except Exception:
    print('[]')
" 2>/dev/null)
    save_state "$STATE_W" "$STATE_P" "$STATE_M"
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
  else
    # 任务/留言都只打印不退出：留言是插播，任务靠 hub 端「忙时不派新活」
    # 保证执行中不被覆盖，worker 一直在场领活与续命
    log "===== 命中 $KIND（上报结果时务必带 name=$NAME） ====="
    echo "$OUT"
  fi
done
log "达到轮数上限，退出"
