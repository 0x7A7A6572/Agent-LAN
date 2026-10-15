const { spawn } = require("node:child_process");
const fs = require("node:fs");
const LOG = "D:/codes/multi-agent-connect/.research/logs/online-e2e.txt";
const lines = [];
const log = (m) => { lines.push(m); fs.writeFileSync(LOG, lines.join("\n")); };
let rpcId = 0;
async function mcp(port, method, params) {
  const r = await fetch("http://127.0.0.1:" + port + "/mcp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params })
  }).then(r => r.json());
  if (r.error) throw new Error(method + ": " + r.error.message);
  return r.result;
}
async function agents(port) {
  const r = await mcp(port, "tools/call", { name: "mac_list_agents", arguments: {} });
  return JSON.parse(r.content[0].text).map(p => p.card.name + ":" + (p.online ? "on" : "off")).join(",");
}
(async () => {
  const server = spawn("node", ["packages/app/dist/main.js"], {
    cwd: "D:/codes/multi-agent-connect",
    env: { ...process.env, MAC_PORT: "9731", MAC_AGENT_NAME: "hub", MAC_ADAPTER: "custom",
      MAC_ADAPTER_CMD: "node", MAC_ADAPTER_ARGS: ".research/tmp/fake-agent.cjs" },
    stdio: "ignore"
  });
  await new Promise(r => setTimeout(r, 1000));
  await mcp(9731, "tools/call", { name: "mac_check_in", arguments: { name: "dsh-test", description: "dsh" } });
  log("t=0s: " + await agents(9731));

  // dsh 发起 20s 长轮询，期间不调用其他工具
  const pullPromise = mcp(9731, "tools/call", { name: "mac_pull_task", arguments: { name: "dsh-test", waitMs: 20000 } });
  for (const t of [5, 10, 15, 19]) {
    await new Promise(r => setTimeout(r, t === 5 ? 5000 : 5000));
    log("t=" + t + "s (during pull wait): " + await agents(9731));
  }
  await pullPromise;
  log("t=21s (after pull): " + await agents(9731));
  // 再等 30s 无任何活动 → 应判离线（40s 阈值未到）……实际上 21+30=51s 距最后 touch < 60s 也未到
  // 只验证核心：pull 等待期间不掉线
  server.kill(); process.exit(0);
})().catch(e => { log("ERR: " + e.message); process.exit(1); });
