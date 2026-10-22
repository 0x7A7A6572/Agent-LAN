#!/usr/bin/env bash
# 提问链路 E2E：注册节点 -> hook 上报提问 -> 控制台读取 -> 答复 -> 校验留言
set -u
S=127.0.0.1:9777
cd "$(dirname "$0")"

mcpcall() {
  local tool="$1" args="$2" pf="/tmp/mac-e2e/.p.json"
  printf '%s' "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}" > "$pf"
  local sid
  sid=$(curl -s -D - -o /dev/null -X POST "http://$S/mcp" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}' \
    | grep -i '^mcp-session-id:' | tr -d '\r' | awk '{print $2}')
  curl -s -X POST "http://$S/mcp" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' ${sid:+-H "mcp-session-id: $sid"} -d "@$pf"
}

echo "── 1) 注册节点 wb-e2e"
mcpcall mac_check_in '{"name":"wb-e2e","agent":"workbuddy","description":"e2e 节点","host":"e2e-host"}' | head -c 400; echo

echo "── 2) 上报提问（模拟 PreToolUse hook）"
printf '%s' '{"name":"wb-e2e","kind":"ask","title":"demo-app · 修登录页","questions":[{"header":"部署环境","question":"发布到哪套环境？","options":[{"label":"预发","description":"先冒烟"},{"label":"生产","description":"灰度10%"},{"label":"只出包"}]}]}' > /tmp/mac-e2e/.ask.json
curl -s -X POST "http://$S/worker/ask" -H 'content-type: application/json' -d @/tmp/mac-e2e/.ask.json; echo

echo "── 3) 控制台读题卡"
curl -s "http://$S/console/questions"; echo

echo "── 4) 控制台答复"
printf '%s' '{"name":"wb-e2e","choice":{"0":["预发"]},"other":"发完通知我","by":"human-console"}' > /tmp/mac-e2e/.ans.json
curl -s -X POST "http://$S/console/questions/answer" -H 'content-type: application/json' -d @/tmp/mac-e2e/.ans.json | head -c 600; echo

echo "── 5) 节点领活应带回答复留言"
mcpcall mac_pull_task '{"name":"wb-e2e","waitMs":1000}' | head -c 900; echo

echo "── 6) PostToolUse 清题"
curl -s -X POST "http://$S/worker/ask" -H 'content-type: application/json' -d '{"name":"wb-e2e","clear":true}'; echo
curl -s "http://$S/console/questions"; echo
