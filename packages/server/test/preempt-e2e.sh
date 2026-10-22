#!/usr/bin/env bash
# 抢占式代答 E2E：hook 挂起等 → 人在这期间答 → hook 用 deny 把答案交回模型
set -u
S=127.0.0.1:9777
W=/tmp/mac-e2e2

reg() {
  printf '%s' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mac_check_in","arguments":{"name":"wb-e2e","agent":"hooktest","description":"抢占式测试","host":"e2e"}}}' > $W/.p.json
  local sid
  sid=$(curl -s -D - -o /dev/null -X POST "http://$S/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}' \
    | grep -i '^mcp-session-id:' | tr -d '\r' | awk '{print $2}')
  curl -s -o /dev/null -X POST "http://$S/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H "mcp-session-id: $sid" -d @$W/.p.json
}

mkdir -p ~/.mac-worker/hooktest
cat > ~/.mac-worker/hooktest/node.json <<EOF
{
  "agent": "hooktest", "name": "wb-e2e", "desc": "抢占式测试", "server": "$S",
  "state": { "updatedAt": "$(date -u +%FT%T.000Z)", "online": true, "working": null, "pending": [], "messages": [] }
}
EOF
cp /d/codes/multi-agent-connect/packages/server/dist/hook-ask.mjs ~/.mac-worker/hooktest/hook-ask.mjs
cd $W
reg
echo "── 1) 起 hook（等 8s，模拟 agent 停在 AskUserQuestion 前）"
( printf '%s' '{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","session_id":"sess-pre","cwd":"/d/codes/x","tool_input":{"questions":[{"header":"上线时间","question":"今晚发还是明早发？","options":[{"label":"今晚 22:00"},{"label":"明早 9:00"}]}]}}' \
  | MAC_NODE=wb-e2e MAC_ASK_WAIT_MS=8000 node ~/.mac-worker/hooktest/hook-ask.mjs ask > $W/.hookout 2>$W/.hookerr ) &
HPID=$!

sleep 2
echo "── 2) 人在控制台代答"
printf '%s' '{"name":"wb-e2e","choice":{"0":["明早 9:00"]},"by":"human-console"}' > $W/.ans.json
curl -s -X POST "http://$S/console/questions/answer" -H 'content-type: application/json' -d @$W/.ans.json | head -c 200; echo

wait $HPID
echo "── 3) hook stdout（会被 CLI 当成 deny 决策）"
cat $W/.hookout; echo
echo "── 4) hook 日志"
tail -3 ~/.mac-worker/hook-ask/hook-ask.log
echo "── 5) 题卡应已回收"
curl -s "http://$S/console/questions"; echo
