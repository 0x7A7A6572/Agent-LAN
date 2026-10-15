const { spawn } = require("node:child_process");
const fs = require("node:fs");
const LOG = "D:/codes/multi-agent-connect/.research/logs/client-e2e.txt";
const lines = [];
const log = (m) => { lines.push(m); fs.writeFileSync(LOG, lines.join("\n")); };
(async () => {
  const server = spawn("node", ["packages/app/dist/main.js"], {
    cwd: "D:/codes/multi-agent-connect",
    env: { ...process.env, MAC_PORT: "9671", MAC_AGENT_NAME: "hub", MAC_ADAPTER: "custom",
      MAC_ADAPTER_CMD: "node", MAC_ADAPTER_ARGS: ".research/tmp/fake-agent.cjs" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", d => lines.push("[hub] " + d.toString().trim()));
  await new Promise(r => setTimeout(r, 1000));

  const client = spawn("node", ["examples/echo-agent.mjs"], {
    cwd: "D:/codes/multi-agent-connect",
    env: { ...process.env, SERVER_URL: "http://127.0.0.1:9671", AGENT_NAME: "wb-echo" },
    stdio: "ignore"
  });
  await new Promise(r => setTimeout(r, 2000)); // 等注册 + 首次长轮询挂起

  // 发起方：target=wb-echo
  const send = await fetch("http://127.0.0.1:9671/", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { prompt: "hi-from-lan", target: "wb-echo" } })
  }).then(r => r.json());
  log("send: " + JSON.stringify(send.result));
  const id = send.result.task.id;

  let final = null;
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 500));
    const get = await fetch("http://127.0.0.1:9671/", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id } }) }).then(r => r.json());
    final = get.result.task;
    if (["completed", "failed", "canceled"].includes(final.state)) break;
  }
  log("final: " + final.state);

  // SSE 回放验证 message 事件（从任务流订阅已结束，直接看任务对象没有 message 字段——用文件通道之外的验证：
  // 改用重新发起一个任务并同步订阅 SSE）
  const send2 = await fetch("http://127.0.0.1:9671/", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "message/send", params: { prompt: "sse-check", target: "wb-echo" } })
  }).then(r => r.json());
  const id2 = send2.result.task.id;
  const frames = [];
  const controller = new AbortController();
  const sseDone = fetch("http://127.0.0.1:9671/tasks/" + id2 + "/stream", { signal: controller.signal })
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
            if (f.startsWith("data: ")) frames.push(f.slice(6).slice(0, 80));
          }
        }
      } catch {}
    });
  await new Promise(r => setTimeout(r, 3000));
  controller.abort(); await sseDone.catch(() => {});
  log("frames(" + frames.length + "): " + JSON.stringify(frames));

  client.kill(); server.kill(); process.exit(0);
})().catch(e => { log("ERR: " + e.message); process.exit(1); });
