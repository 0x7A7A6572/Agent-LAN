const { spawn } = require("node:child_process");
const fs = require("node:fs");
(async () => {
  const child = spawn("node", ["packages/app/dist/main.js"], {
    cwd: "D:/codes/multi-agent-connect",
    env: { ...process.env, MAC_PORT: "9652", MAC_AGENT_NAME: "tui-node", MAC_ADAPTER: "custom",
      MAC_ADAPTER_CMD: "node", MAC_ADAPTER_ARGS: ".research/tmp/fake-agent.cjs" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let out = "";
  child.stdout.on("data", d => out += d.toString());
  await new Promise(r => setTimeout(r, 3500));
  // 模拟一个远端节点注册
  await fetch("http://127.0.0.1:9652/", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "presence/heartbeat", params: { card:
      { name: "remote-1", description: "远端", url: "http://192.168.1.2:9600", version: "0.0.1",
        capabilities: { streaming: true, adapters: ["claude"] } } } }) });
  await new Promise(r => setTimeout(r, 7000));
  fs.writeFileSync("D:/codes/multi-agent-connect/.research/logs/tui-capture.txt", out);
  child.kill(); process.exit(0);
})();
