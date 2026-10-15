const { spawn } = require("node:child_process");
const fs = require("node:fs");
const LOG = "D:/codes/multi-agent-connect/.research/logs/mcp-e2e.txt";
const lines = [];
const log = (m) => { lines.push(m); fs.writeFileSync(LOG, lines.join("\n")); };

let rpcId = 0;
async function call(port, method, params) {
  const r = await fetch("http://127.0.0.1:" + port + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params })
  }).then(r => r.json());
  if (r.error) throw new Error(method + ": " + r.error.message);
  return r.result;
}

(async () => {
  const server = spawn("node", ["packages/app/dist/main.js"], {
    cwd: "D:/codes/multi-agent-connect",
    env: { ...process.env, MAC_PORT: "9681", MAC_AGENT_NAME: "hub", MAC_ADAPTER: "custom",
      MAC_ADAPTER_CMD: "node", MAC_ADAPTER_ARGS: ".research/tmp/fake-agent.cjs" },
    stdio: "ignore"
  });
  await new Promise(r => setTimeout(r, 1000));

  // 1. initialize + tools/list
  const init = await call(9681, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  log("initialize: " + init.serverInfo.name);
  const tools = await call(9681, "tools/list", {});
  log("tools: " + tools.tools.map(t => t.name).join(","));

  // 2. 模拟远端 agent A：mac_check_in
  const ci = await call(9681, "tools/call", { name: "mac_check_in", arguments: { name: "agent-A", description: "测试节点", abilities: ["echo"] } });
  log("check_in: " + ci.content[0].text.slice(0, 80));

  // 3. agent-A 长轮询领任务（后台挂起）
  const pullPromise = call(9681, "tools/call", { name: "mac_pull_task", arguments: { name: "agent-A", waitMs: 15000 } });

  // 4. 派任务 target=agent-A
  const send = await call(9681, "tools/call", { name: "mac_send_task", arguments: { prompt: "mcp-hello", target: "agent-A" } });
  log("send: " + JSON.stringify(send.content[0].text).slice(0, 120));
  const taskId = JSON.parse(send.content[0].text).taskId;

  // 5. agent-A 领到任务并上报结果（带文件）
  const pulled = await pullPromise;
  const task = JSON.parse(pulled.content[0].text).task;
  log("pulled: " + (task ? task.prompt : "null"));

  const report = await call(9681, "tools/call", { name: "mac_report", arguments: {
    taskId, state: "completed", text: "done via mcp",
    files: [{ name: "out.txt", contentBase64: Buffer.from("mcp-file-content").toString("base64") }]
  } });
  const fileUri = JSON.parse(report.content[0].text).files[0];
  log("report files: " + fileUri);

  // 6. 发起方查任务
  const get = await call(9681, "tools/call", { name: "mac_get_task", arguments: { taskId } });
  const t = JSON.parse(get.content[0].text);
  log("get_task: " + t.state + " artifacts=" + JSON.stringify(t.artifacts));

  // 7. 文件回读
  const dl = await call(9681, "tools/call", { name: "mac_download_file", arguments: { storedName: fileUri.split("/").pop() } });
  log("download: " + Buffer.from(JSON.parse(dl.content[0].text).contentBase64, "base64").toString());

  // 8. list_agents
  const la = await call(9681, "tools/call", { name: "mac_list_agents", arguments: {} });
  log("agents: " + JSON.parse(la.content[0].text).map(p => p.card.name + ":" + (p.online ? "on" : "off")).join(","));

  server.kill(); process.exit(0);
})().catch(e => { log("ERR: " + e.message); process.exit(1); });
