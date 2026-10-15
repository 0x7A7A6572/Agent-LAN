const { spawn } = require("node:child_process");
const fs = require("node:fs");
const LOG = "D:/codes/multi-agent-connect/.research/logs/file-e2e.txt";
const lines = [];
const log = (m) => { lines.push(m); fs.writeFileSync(LOG, lines.join("\n")); };
(async () => {
  const child = spawn("node", ["packages/app/dist/main.js"], {
    cwd: "D:/codes/multi-agent-connect",
    env: { ...process.env, MAC_PORT: "9661", MAC_AGENT_NAME: "file-node", MAC_ADAPTER: "custom",
      MAC_ADAPTER_CMD: "node", MAC_ADAPTER_ARGS: ".research/tmp/fake-agent.cjs",
      MAC_FILES_DIR: ".research/tmp/mac-files" },
    stdio: "ignore"
  });
  await new Promise(r => setTimeout(r, 1000));
  const payload = "artifact-content-" + "x".repeat(5000);
  const put = await fetch("http://127.0.0.1:9661/files/report.txt", {
    method: "PUT", body: payload
  }).then(r => r.json());
  log("upload: " + JSON.stringify(put));
  const back = await fetch(put.uri).then(r => r.text());
  log("roundtrip match: " + (back === payload));
  log("uri: " + put.uri);
  child.kill(); process.exit(0);
})().catch(e => { log("ERR: " + e.message); process.exit(1); });
