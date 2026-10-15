const { spawn } = require("node:child_process");
const fs = require("node:fs");
const LOG = "D:/codes/multi-agent-connect/.research/logs/presence-e2e.txt";
const lines = [];
const log = (m) => { lines.push(m); fs.writeFileSync(LOG, lines.join("\n")); };
(async () => {
  const nodeA = spawn("node", ["packages/app/dist/main.js"], {
    cwd: "D:/codes/multi-agent-connect",
    env: { ...process.env, MAC_PORT: "9643", MAC_AGENT_NAME: "node-A", MAC_ADAPTER: "custom",
      MAC_ADAPTER_CMD: "node", MAC_ADAPTER_ARGS: ".research/tmp/fake-agent.cjs" },
    stdio: "ignore"
  });
  await new Promise(r => setTimeout(r, 800));
  const CARD_B = { name: "node-B", description: "另一台机器", url: "http://192.168.1.2:9642",
    version: "0.0.1", capabilities: { streaming: true, adapters: ["claude"] } };
  // B 只发 2 次心跳就停
  for (let i = 0; i < 2; i++) {
    await fetch("http://127.0.0.1:9643/", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "presence/heartbeat", params: { card: CARD_B } }) });
    await new Promise(r => setTimeout(r, 1000));
  }
  log("B heartbeat sent x2, now stopped");
  const controller = new AbortController();
  const frames = [];
  fetch("http://127.0.0.1:9643/console/presence/stream", { signal: controller.signal })
    .then(async res => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value);
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
            if (frame.startsWith("data: ")) {
              const d = JSON.parse(frame.slice(6));
              frames.push(d.presences.map(p => p.card.name + ":" + (p.online ? "on" : "off")).join(","));
            }
          }
        }
      } catch {}
    });
  await new Promise(r => setTimeout(r, 20000));
  log("frames(" + frames.length + "): " + JSON.stringify(frames));
  controller.abort(); nodeA.kill(); process.exit(0);
})().catch(e => { log("ERR: " + e.message); process.exit(1); });
