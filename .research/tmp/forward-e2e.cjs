const { spawn } = require("node:child_process");
const fs = require("node:fs");
const LOG = "D:/codes/multi-agent-connect/.research/logs/forward-e2e.txt";
const lines = [];
const log = (m) => { lines.push(m); fs.writeFileSync(LOG, lines.join("\n")); };
(async () => {
  const mk = (port, name) => spawn("node", ["packages/app/dist/main.js"], {
    cwd: "D:/codes/multi-agent-connect",
    env: { ...process.env, MAC_PORT: String(port), MAC_AGENT_NAME: name, MAC_ADAPTER: "custom",
      MAC_ADAPTER_CMD: "node", MAC_ADAPTER_ARGS: ".research/tmp/fake-agent.cjs" },
    stdio: "ignore"
  });
  const nodeA = mk(9641, "node-A");
  const nodeB = mk(9642, "node-B");
  await new Promise(r => setTimeout(r, 1200));

  // B 向 A 心跳注册（模拟跨机器）
  const CARD_B = { name: "node-B", description: "远端", url: "http://192.168.1.2:9642",
    version: "0.0.1", capabilities: { streaming: true, adapters: ["custom"] } };
  await fetch("http://127.0.0.1:9641/", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "presence/heartbeat", params: { card: CARD_B } }) });

  // A 收到 target=node-B 的任务 → 应代理给 B
  const send = await fetch("http://127.0.0.1:9641/", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "message/send", params: { prompt: "cross-node-hello", target: "node-B" } })
  }).then(r => r.json());
  log("send result: " + JSON.stringify(send.result));
  const id = send.result.task.id;

  // 订阅 A 的任务 SSE，收转发回来的事件
  const frames = [];
  const controller = new AbortController();
  const sseDone = fetch("http://127.0.0.1:9641/tasks/" + id + "/stream", { signal: controller.signal })
    .then(async res => {
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value);
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const f = buf.slice(0, idx); buf = buf.slice(idx + 2);
            if (f.startsWith("data: ")) frames.push(f.slice(6).slice(0, 90));
          }
        }
      } catch {}
    });

  // 等终态
  let final = null;
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 500));
    const get = await fetch("http://127.0.0.1:9641/", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tasks/get", params: { id } }) }).then(r => r.json());
    final = get.result.task;
    if (["completed", "failed", "canceled"].includes(final.state)) break;
  }
  log("final: " + final.state);
  await new Promise(r => setTimeout(r, 500));
  controller.abort();
  await sseDone.catch(() => {});
  log("sse frames(" + frames.length + "): " + JSON.stringify(frames));
  nodeA.kill(); nodeB.kill(); process.exit(0);
})().catch(e => { log("ERR: " + e.message); process.exit(1); });
