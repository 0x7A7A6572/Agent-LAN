#!/usr/bin/env bash
# Agent-LAN 接入体检：一次跑完，缺什么当场告诉你
# 用法: SERVER=<主服务IP:端口> bash probe.sh
SERVER=${SERVER:?用法: SERVER=<主服务IP:端口> bash probe.sh}
pass=0; fail=0
ok() { echo "[通过] $1"; pass=$((pass+1)); }
bad() { echo "[不通过] $1"; fail=$((fail+1)); }

echo "== Agent-LAN 接入体检 =="

# 0) 环境判定：WSL/Git Bash 里跑会有装错 home 的风险，先说清
IS_WSL=""
if [ -n "$WSL_DISTRO_NAME" ]; then
  IS_WSL=1
  echo "[提示] 检测到 WSL 环境（$WSL_DISTRO_NAME）"
fi

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
  echo "结论：全部通过。推荐一键安装到 ~/.mac-worker（跨会话/跨项目通用，自动记忆配置）："
  echo "  SERVER=$SERVER bash probe.sh --install NAME=<节点名>"
  echo "或手动接入："
  echo "  curl -s --noproxy '*' http://$SERVER/worker.sh -o mac_worker.sh"
  echo "  NAME=<节点名> DESC=<一句话能力> SERVER=$SERVER bash mac_worker.sh"
else
  echo "结论：$fail 项不通过，按上面提示处理后重跑本脚本"
fi

# 一键安装模式：probe.sh --install AGENT=xxx NAME=yyy [DESC=zzz]
# 每 agent 一目录：~/.mac-worker/<agent>/worker.sh + node.json（身份持久化）
if [ "$1" = "--install" ]; then
  INSTALL_AGENT="default"
  INSTALL_NAME=""
  INSTALL_DESC="general worker"
  for kv in ${@:2}; do
    case "$kv" in
      AGENT=*) INSTALL_AGENT="${kv#AGENT=}" ;;
      NAME=*) INSTALL_NAME="${kv#NAME=}" ;;
      DESC=*) INSTALL_DESC="${kv#DESC=}" ;;
    esac
  done
  [ -n "$INSTALL_NAME" ] || { echo "[x] 缺少 NAME=节点名"; exit 1; }

  # 安装根解析：与 worker.sh 回退口径对齐——WSL 里优先落到 Windows 用户目录，
  # 保证 MCP 注册（可能带 host）与 worker 注册（同盘落盘）归到同一台主机
  INSTALL_ROOT="$HOME/.mac-worker"
  if [ -n "$IS_WSL" ] && [ -d "/mnt/c/Users" ]; then
    WUSER=$(cmd.exe /c "echo %USERNAME%" 2>/dev/null | tr -d '\r\n' | tr -d '\r')
    if [ -n "$WUSER" ] && [ -d "/mnt/c/Users/$WUSER" ]; then
      echo "[提示] WSL 环境：安装到 Windows 用户目录 /mnt/c/Users/$WUSER/.mac-worker（与 worker.sh 回退口径一致）"
      INSTALL_ROOT="/mnt/c/Users/$WUSER/.mac-worker"
    else
      echo "[x] WSL 里取不到 Windows 用户名（cmd.exe 不可用）。两种选择："
      echo "    1) 在 Windows 侧 PowerShell/Git Bash 里跑本安装命令（推荐）"
      echo "    2) 确认要装进 WSL home（$HOME/.mac-worker）的话，加 FORCE_WSL_INSTALL=1 重跑"
      echo "    注意：装进 WSL home 会导致注册 host 口径与 Windows 侧不一致，同名会判撞名"
      exit 1
    fi
  fi
  if [ -n "$IS_WSL" ] && [ "$FORCE_WSL_INSTALL" != "1" ] && [ ! -d "/mnt/c/Users" ]; then
    echo "[x] WSL 环境但 /mnt/c 不可达，拒绝盲装。确认要装 WSL home 用 FORCE_WSL_INSTALL=1"
    exit 1
  fi
  INSTALL_DIR="$INSTALL_ROOT/$INSTALL_AGENT"
  # 一致性校验：目录已有身份且 agent 类型不符 → 拒绝安装，防装错目录
  if [ -f "$INSTALL_DIR/node.json" ]; then
    EXIST_AGENT=$(grep -o '"agent": *"[^"]*"' "$INSTALL_DIR/node.json" 2>/dev/null | cut -d'"' -f4)
    if [ -n "$EXIST_AGENT" ] && [ "$EXIST_AGENT" != "$INSTALL_AGENT" ]; then
      echo "[x] 目录 $INSTALL_DIR 已属于 agent「$EXIST_AGENT」，与本次 --install AGENT=$INSTALL_AGENT 不符"
      echo "    请换正确的 AGENT= 参数，或用其他目录名"
      exit 1
    fi
  fi
  mkdir -p "$INSTALL_DIR" || { echo "[x] 无法创建 $INSTALL_DIR"; exit 1; }
  curl -s --noproxy '*' "http://$SERVER/worker.sh" -o "$INSTALL_DIR/worker.sh" || { echo "[x] 下载失败"; exit 1; }
  chmod +x "$INSTALL_DIR/worker.sh" 2>/dev/null
  # 门铃：会话侧唤醒用。hub 还没提供 /bell.sh 时静默跳过，不阻断安装
  # （-f 很关键：没有它 curl 会把 404 的 HTML 当成脚本落到磁盘上）
  if curl -sf --noproxy '*' "http://$SERVER/bell.sh" -o "$INSTALL_DIR/bell.sh" 2>/dev/null; then
    chmod +x "$INSTALL_DIR/bell.sh" 2>/dev/null
    HAS_BELL=1
  else
    rm -f "$INSTALL_DIR/bell.sh"
    HAS_BELL=0
  fi
  # 提问 hook：把 agent 的 AskUserQuestion 上报到控制台，人可在控制台代答。
  # 可选能力：hub 没提供 /hook-ask.mjs、或本机没有 node，就静默跳过，不阻断安装。
  HAS_HOOK=0
  if command -v node >/dev/null 2>&1 && curl -sf --noproxy '*' "http://$SERVER/hook-ask.mjs" -o "$INSTALL_DIR/hook-ask.mjs" 2>/dev/null; then
    chmod +x "$INSTALL_DIR/hook-ask.mjs" 2>/dev/null
    # MAC_FORCE_AGENT 钉死安装目录：本机已有别的 agent 活着时，不许把 hook 装到别人目录
    HOOK_OUT=$(MAC_FORCE_AGENT="$INSTALL_AGENT" node "$INSTALL_DIR/hook-ask.mjs" install 2>&1)
    HOOK_RC=$?
    echo "$HOOK_OUT" | sed 's/^/    /'
    [ "$HOOK_RC" -eq 0 ] && HAS_HOOK=1
  else
    rm -f "$INSTALL_DIR/hook-ask.mjs"
  fi
  if [ ! -f "$INSTALL_DIR/node.json" ]; then
    cat > "$INSTALL_DIR/node.json" <<EOF
{
  "agent": "$INSTALL_AGENT",
  "name": "$INSTALL_NAME",
  "desc": "$INSTALL_DESC",
  "server": "$SERVER"
}
EOF
  fi
  # 自动接入：把规范写进上层 agent「每次新会话都会读」的文件。
  # 只写 node.json 的话，新会话不知道有这回事，还是得人工喂一遍提示词。
  # 模板必须用引号 heredoc（'HINTEOF'）：非引号 heredoc 会把正文里的反引号与
  # $() 当命令执行，既误起 worker，又会把正文换成垃圾。
  write_agent_hint() {
    local file="$1" kind="$2" hintfile
    hintfile="$INSTALL_DIR/.hint.$$"
    cat > "$hintfile" <<'HINTEOF'
<!-- AGENT-LAN:BEGIN 由安装脚本自动生成，请勿手改这一段 -->
## 局域网 Agent-LAN 接入（每次新会话先做这一步）

本机已安装常驻 worker，身份节点名 __NAME__，主服务 __SERVER__。

- 重连：bash __DIR__/worker.sh —— 不用任何参数，它自己从 node.json 读回身份。
  会话任务被关、机器重启后都靠这一条恢复；必须在当前会话里起，同身份只起一个。
- 接活：起 bash __DIR__/worker.sh。它**常驻轮询不退出**（心跳不断、领到任务只打印 JSON），
  领到活后先调 mac_report(taskId, state="working", name="__NAME__") 报开工，
  干完报 completed、失败报 failed。
- 唤醒（关键，漏了节点会「在线但不动」）：worker 不会让会话自己醒过来，必须再起
  bash __DIR__/bell.sh。它只读 node.json，一有新任务/新留言就退出，靠「进程退出」
  触发会话唤醒；**每次处理完要重新起一遍**。worker 挂了它也会叫你去重连。
- 人工接管（用户直接在对话里让你干活，不是派发的任务）：**开工就报**
  mac_check_in(state="working", workingOn="人工接管：<一句话在做什么>")，
  否则控制台节点卡一直显示「空闲」，人不知道你在忙什么。
  working 默认 15 分钟到期自动回空闲，长任务中途续报一次即可；
  这一轮真正收工（给出最终答复）时显式报 state="idle"。
  **不要每轮 working/idle 来回切**——用户连续追问时那样会刷屏抖动，
  连续干同一件事就保持 working。
- 需要人工确认：直接用 AskUserQuestion 提问即可。装了提问 hook 时，问题与选项会同步到
  控制台的节点卡（「看题」入口），人一眼能看出你在等什么。
  注意控制台**只做提示、不代答**：决策请在节点侧完成，别指望人在控制台点一下就把你放行。
  纯文本上报可用 mac_report(state="input-required", text=等谁确认什么)。
- 规范全文：curl -s http://__SERVER__/mcp/install.md ，或调工具 mac_get_guide。
- 上报必须带 name="__NAME__"，否则状态不写回工单，等于白干。
- 常驻 worker 已在后台时不要重复起多个，否则互相抢任务导致状态抖动。

<!-- AGENT-LAN:END -->
HINTEOF
    sed -i "s|__NAME__|$INSTALL_NAME|g; s|__SERVER__|$SERVER|g; s|__DIR__|$INSTALL_DIR|g" "$hintfile"
    local dir; dir=$(dirname "$file")
    mkdir -p "$dir" 2>/dev/null
    # 幂等：已有标记块则整段替换，没有则追加。正文走文件读取，避开 awk -v 的转义处理
    if [ -f "$file" ] && grep -q 'AGENT-LAN:BEGIN' "$file" 2>/dev/null; then
      awk -v hf="$hintfile" '
        /AGENT-LAN:BEGIN/ { while ((getline l < hf) > 0) print l; close(hf); skip=1; next }
        /AGENT-LAN:END/ { skip=0; next }
        skip != 1 { print }
      ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
    else
      [ -s "$file" ] && printf '\n\n' >> "$file"
      cat "$hintfile" >> "$file"
    fi
    rm -f "$hintfile"
    echo "[OK] 已写入 $kind 自动读取文件：$file"
  }
  case "$INSTALL_AGENT" in
    dsh)  write_agent_hint "${DSH_HOME:-$HOME/.dsh}/AGENTS.md" "dsh" ;;
    workbuddy|codebuddy) write_agent_hint "$HOME/.workbuddy/AGENTS.md" "workbuddy" ;;
    *)    write_agent_hint "$HOME/.mac-worker/$INSTALL_AGENT/AGENT.md" "$INSTALL_AGENT" ;;
  esac

  echo "[✓] 已安装到 $INSTALL_DIR"
  echo "启动：bash $INSTALL_DIR/worker.sh（配置已记忆，免参数）"
  if [ "${HAS_BELL:-0}" = "1" ]; then
    echo "唤起：bash $INSTALL_DIR/bell.sh（处理完一次后要重新起）"
  else
    echo "[!] hub 未提供 /bell.sh，本次没装门铃；升级 hub 后重跑 --install 即可补上"
  fi
  if [ "${HAS_HOOK:-0}" = "1" ]; then
    echo "提问提示：已装 hook（AskUserQuestion 会同步到控制台「看题」入口，只提示不作答）；重启会话后生效"
  else
    echo "[!] 未装提问 hook（缺 node 或 hub 无 /hook-ask.mjs），控制台看不到你在等什么；不影响接活与上报"
  fi
  echo "临时换名调试：NAME=xxx bash $INSTALL_DIR/worker.sh"
  exit 0
fi
