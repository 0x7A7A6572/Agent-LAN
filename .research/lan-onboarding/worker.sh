#!/usr/bin/env bash
# Agent-LAN 官方接入脚本（心跳+领活一体，断线自动重连）
#
# 用法（在能跑 bash 的机器上）:
#   curl -s http://<主服务IP>/worker.sh -o mac_worker.sh
#   NAME=<节点名> DESC=<一句话能力> SERVER=<主服务IP:端口> bash mac_worker.sh
#
# 行为: 拿到任务或留言后输出完整 JSON 交上层 agent 处理后退出；
#       退出时留一个伴生后台心跳（每 20s check_in，最长 2h）保持节点在线
#       直到上层 agent 调 mac_report；空转/断线则常驻循环，无限重试。
# 依赖: curl；python/python3 可选（无则用纯 grep 判别）
# 版本由 hub 构建时按脚本内容哈希注入，节点据此自动更新

WORKER_VERSION=d3e774da

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
    eval "$(sed -n 's/.*"\(name\|desc\|server\|agent\)": *"\([^"]*\)".*/J_\1='"'"'\2'"'"'/p' "$MAC_DIR/node.json" 2>/dev/null)" 2>/dev/null
fi

NAME=${NAME:-${J_name:-worker-$(hostname)}}
DESC=${DESC:-${J_desc:-general worker}}
SERVER=${SERVER:-${J_server:-}}
if [ -z "$SERVER" ]; then
  echo "[x] 缺少 SERVER。首次安装：SERVER=<主服务IP:端口> bash probe.sh --install AGENT=<agent名> NAME=<节点名>" >&2
  echo "    或手动：SERVER=<主服务IP:端口> AGENT=<agent名> NAME=<节点名> bash worker.sh" >&2
  exit 1
fi
# 身份+配置持久化：首次成功连接后写 node.json
save_env() {
  [ -n "$MAC_ROOT" ] || return 0
  mkdir -p "$MAC_DIR"
  cat > "$MAC_DIR/node.json" <<EOF
{
  "agent": "$AGENT",
  "name": "$NAME",
  "desc": "$DESC",
  "server": "$SERVER"
}
EOF
}
WAIT_MS=${WAIT_MS:-6000}
MAX=${MAX:-100000}

FAIL=0
UNREACH=0
OK=0

log() { echo "[$(date '+%H:%M:%S')] $*" >&2; }

# 更新结果上报 hub：best-effort，失败不拖垮本地流程
report_update() {
  curl -s --max-time 5 -X POST "http://$SERVER/worker/update-report" \
    -H 'content-type: application/json' \
    -d "{\"name\":\"$NAME\",\"level\":\"$1\",\"message\":\"$2\"}" >/dev/null 2>&1 || true
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
  HB=$(mcp_call mac_check_in "{\"name\":\"$NAME\",\"agent\":\"$AGENT\",\"description\":\"$DESC\",\"host\":\"$(hostname)\"}")
  if echo "$HB" | grep -q '节点名 .* 已被主机'; then
    log "[x] 节点名冲突：$(echo "$HB" | grep -o '节点名 [^"]*')"
    log "[x] 请停掉本脚本，换一个 NAME 重新启动（同机多实例 NAME 必须各不相同）"
    exit 1
  fi
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
  # 首次成功连接：记忆节点身份与配置，此后同 agent 任何会话免参数启动
  if [ -n "$MAC_ROOT" ] && [ ! -f "$MAC_DIR/node.json" ]; then
    save_env
    log "[✓] 节点身份已记忆到 $MAC_DIR/node.json，下次直接 bash $0 启动"
  fi

  # ---------- 1.5) 版本检查：hub 版本不同则自更新并重启 ----------
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
    # 执行期心跳：伴生后台进程续命，脚本本体照常退出交付任务
    # 有界 20s×360=2h，与服务端 busy 豁免上限一致，防伴生进程堆积
    (
      for i in $(seq 1 360); do
        sleep 20
        mcp_call mac_check_in "{\"name\":\"$NAME\",\"agent\":\"$AGENT\",\"description\":\"$DESC\",\"host\":\"$(hostname)\"}" >/dev/null 2>&1 || true
      done
    ) >/dev/null 2>&1 &
    exit 0
  fi
done
log "达到轮数上限，退出"
