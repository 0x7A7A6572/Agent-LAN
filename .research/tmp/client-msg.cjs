const { spawn } = require("node:child_process");
const fs = require("node:fs");
const LOG = "D:/codes/multi-agent-connect/.research/logs/client-msg.txt";
const lines = [];
const log = (m) => { lines.push(m); fs.writeFileSync(LOG, lines.join("\n")); };
(async () => {
  const server = spawn("node", ["packages/app/dist/main.js"], {
    cwd: "D:/codes/multi-agent-connect",
    env: { ...process.env, MAC_PORT: "9672", MAC_AGENT_NAME: "hub", MAC_ADAPTER: "custom",
      MAC_ADAPTER_CMD: "node", MAC_ADAPTER_ARGS: ".research/tmp/fake-agent.cjs" },
    stdio: "ignore"
  });
  await new Promise(r => setTimeout(r, 1000));
  const client = spawn("node", ["examples/echo-agent.mjs"], {
    cwd: "D:/codes/multi-agent-connect",
    env: { ...process.env, SERVER_URL: "http://127.0.0.1:9672", AGENT_NAME: "wb-echo" },
    stdio: "ignore"
  });
  await new Promise(r => setTimeout(r, 2000));

  // 先订阅后发任务
  const send = await fetch("http://127.0.0.1:9672/", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { prompt: "order-matters", target: "wb-echo" } })
  }).then(r => r.json());
  const id = send.result.task.id;

  const frames = [];
  const controller = new AbortController();
  const sseDone = fetch("http://127.0.0.1:9672/tasks/" + id + "/stream", { signal: controller.signal })
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
            if (f.startsWith("data: ")) frames.push(f.slice(6).slice(0, 70));
          }
        }
      } catch {}
    });
  // 注意：send 先于订阅，echo 执行可能更快。若丢 message，就再用第二个任务验证（订阅先行）
  const send2 = await fetch("http://127.0.0.1:9672/", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "message/send", params: { prompt: "second", target: "wb-echo" } })
  }).then(r => r.json());
  await new Promise(r => setTimeout(r, 4000));
  controller.abort(); await sseDone.catch(() => {});
  log("frames(" + frames.length + "):\n" + frames.join("\n"));
  client.kill(); server.kill(); process.exit(0);
})().catch(e => { log("ERR: " + e.message); process.exit(1); });
