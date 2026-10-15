const { spawn } = require("node:child_process");
const fs = require("node:fs");
const LOG = "D:/codes/multi-agent-connect/.research/logs/mailbox-e2e.txt";
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
async function rpc(port, method, params) {
  return fetch("http://127.0.0.1:" + port + "/", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "raw-" + (++rpcId), method, params })
  }).then(r => r.json());
}
(async () => {
  const server = spawn("node", ["packages/app/dist/main.js"], {
    cwd: "D:/codes/multi-agent-connect",
    env: { ...process.env, MAC_PORT: "9691", MAC_AGENT_NAME: "hub", MAC_ADAPTER: "custom",
      MAC_ADAPTER_CMD: "node", MAC_ADAPTER_ARGS: ".research/tmp/fake-agent.cjs" },
    stdio: "ignore"
  });
  await new Promise(r => setTimeout(r, 1000));

  await call(9691, "tools/call", { name: "mac_check_in", arguments: { name: "agent-A", description: "test" } });

  // agent-A 挂起 pull（15s）
  const pullPromise = call(9691, "tools/call", { name: "mac_pull_task", arguments: { name: "agent-A", waitMs: 15000 } });
  await new Promise(r => setTimeout(r, 500));

  // 人从控制台留言（走 raw RPC，等价网页 console 的行为）
  const mail = await rpc(9691, "mailbox/send", { to: "agent-A", text: "老板：优先用方案B", from: "human-console" });
  log("console mail: " + JSON.stringify(mail.result));

  // 再来一条 agent 之间的留言
  await call(9691, "tools/call", { name: "mac_send_message", arguments: { to: "agent-A", text: "我这边文件已上传，注意查收", from: "agent-B" } });

  // pull 返回：应同时带上两条留言 + 空任务
  const pulled = await pullPromise;
  const data = JSON.parse(pulled.content[0].text);
  log("pull task: " + JSON.stringify(data.task));
  log("pull messages: " + JSON.stringify(data.messages, null, 1));

  // 第二次 pull：信箱应已清空
  const again = await call(9691, "tools/call", { name: "mac_pull_task", arguments: { name: "agent-A", waitMs: 2000 } });
  log("second pull: " + JSON.stringify(JSON.parse(again.content[0].text)));

  server.kill(); process.exit(0);
})().catch(e => { log("ERR: " + e.message); process.exit(1); });
