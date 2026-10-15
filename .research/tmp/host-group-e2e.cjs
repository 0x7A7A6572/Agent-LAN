const { spawn } = require("node:child_process");
const fs = require("node:fs");
const LOG = "D:/codes/multi-agent-connect/.research/logs/host-group-e2e.txt";
const lines = [];
const log = (m) => { lines.push(m); fs.writeFileSync(LOG, lines.join("\n")); };
let rpcId = 0;
async function call(port, method, params) {
  const r = await fetch("http://127.0.0.1:" + port + "/mcp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params })
  }).then(r => r.json());
  if (r.error) throw new Error(method + ": " + r.error.message);
  return r.result;
}
(async () => {
  const server = spawn("node", ["packages/app/dist/main.js"], {
    cwd: "D:/codes/multi-agent-connect",
    env: { ...process.env, MAC_PORT: "9711", MAC_AGENT_NAME: "hub", MAC_ADAPTER: "custom",
      MAC_ADAPTER_CMD: "node", MAC_ADAPTER_ARGS: ".research/tmp/fake-agent.cjs" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let tui = "";
  server.stdout.on("data", d => tui += d.toString());
  await new Promise(r => setTimeout(r, 1000));

  // 同一台机（PC-zhangsan）两个 agent + 另一台机（PC-lisi）一个
  await call(9711, "tools/call", { name: "mac_check_in", arguments: { name: "wb-work", description: "workbuddy 办公助手", host: "PC-zhangsan" } });
  await call(9711, "tools/call", { name: "mac_check_in", arguments: { name: "dsh-work", description: "dsh 工作台", host: "PC-zhangsan" } });
  await call(9711, "tools/call", { name: "mac_check_in", arguments: { name: "wb-lisi", description: "workbuddy", host: "PC-lisi" } });
  await new Promise(r => setTimeout(r, 4500)); // 等 TUI 至少重绘一次

  fs.writeFileSync("D:/codes/multi-agent-connect/.research/logs/host-group-tui.txt", tui);
  server.kill(); process.exit(0);
})().catch(e => { log("ERR: " + e.message); process.exit(1); });
