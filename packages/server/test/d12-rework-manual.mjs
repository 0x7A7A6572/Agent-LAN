// 补验 dev 要求「人工过一遍」的返工路径（它列的 A5/A7）：pm 模式下 mac_rework 的豁免与回滚。
// 与 dispatch-ghost.test.mjs 同一套装置（假模型端点切 pm + 独立临时目录），只补这两条。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createServer } from "../dist/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FLUSH_MS = 450;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mac-d12-rw-"));

const stub = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => { res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "{}" } }] })); });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubUrl = "http://127.0.0.1:" + stub.address().port;

process.env.MAC_PM_CONFIG = path.join(tmp, ".pm-config.json");
fs.writeFileSync(process.env.MAC_PM_CONFIG, JSON.stringify({
  enabled: false, provider: "openai", baseUrl: stubUrl, apiKey: "test", model: "test",
  temperature: 0.2, debounceMs: 3000, tickMs: 0, maxActionsPerDecision: 10,
  tokenBudget: 6000, timeoutMs: 15000,
}));

const server = createServer({
  card: { name: "hub-test", description: "t", url: "http://127.0.0.1:0", version: "0.0.0", capabilities: { streaming: false, adapters: ["mcp"] } },
  adapter: { async *invoke() {} },
  port: 0, selfRegister: false,
  filesDir: path.join(tmp, ".mac-files"), ordersPath: path.join(tmp, ".orders.json"),
  rolesPath: path.join(tmp, ".roles.json"), nodesPath: path.join(tmp, ".nodes.json"),
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

async function tool(name, args) {
  const res = await fetch("http://127.0.0.1:" + port + "/mcp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const r = await res.json();
  const text = r.result?.content?.[0]?.text;
  return { error: r.error, data: text ? JSON.parse(text) : undefined };
}
async function setMode(mode) {
  const res = await fetch("http://127.0.0.1:" + port + "/console/pm/mode", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }),
  });
  const j = await res.json();
  assert.equal(j.ok, true, "切模式失败: " + JSON.stringify(j));
}
function storeCount(orderId) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(tmp, ".taskstore.json"), "utf8"));
    return (Array.isArray(s) ? s : []).filter((t) => String(t.prompt ?? "").includes("[工单 " + orderId + "]")).length;
  } catch { return 0; }
}

const out = [];
function rec(name, ok, detail) { out.push({ name, ok, detail }); console.log((ok ? "[PASS] " : "[FAIL] ") + name + " :: " + detail); }

// 两个节点在册：dev 是工单处理人（参与者），other 不是
await tool("mac_check_in", { name: "wb-dev", host: "h", agent: "workbuddy" });
await tool("mac_check_in", { name: "wb-other", host: "h", agent: "workbuddy" });

// A5：pm 模式下，工单当前 assignee 发起的返工应当豁免门禁、且真的入队
await setMode("human");
const ord = await tool("mac_order_create", { title: "返工豁免", description: "pm 模式下由 assignee 返工", assignee: "wb-dev", by: "human-console" });
assert.ok(ord.data?.id, "建单失败");
await sleep(FLUSH_MS);
await setMode("pm");

const rw = await tool("mac_rework", { id: ord.data.id, note: "第一轮返工：pm 模式下应由参与者豁免", by: "wb-dev" });
await sleep(FLUSH_MS);
rec("A5 pm 模式下 assignee 返工被豁免", rw.error === undefined && !!rw.data?.taskId,
  "error=" + JSON.stringify(rw.error) + " taskId=" + rw.data?.taskId);
rec("A5b 返工任务确实落库（且不重复）", storeCount(ord.data.id) === 2,
  "该单任务数=" + storeCount(ord.data.id) + "（期望 2：首派 1 + 返工 1）");

// A7：pm 模式下，非参与者发起返工应被拒，且不得留下幽灵任务
const before = storeCount(ord.data.id);
const bad = await tool("mac_rework", { id: ord.data.id, note: "越权返工", by: "wb-other" });
await sleep(FLUSH_MS);
const after = storeCount(ord.data.id);
rec("A7 非参与者返工被拒", !!bad.error, "error.code=" + bad.error?.code + " msg=" + String(bad.error?.message).slice(0, 60));
rec("A7b 被拒后任务数不变（无幽灵任务）", after === before, "before=" + before + " after=" + after);

// A8（额外）：pm 模式下，非参与者派发同一张单（mac_order_dispatch）也应被拒且不留任务
const before2 = storeCount(ord.data.id);
const bad2 = await tool("mac_order_dispatch", { id: ord.data.id, assignee: "wb-other", by: "wb-other" });
await sleep(FLUSH_MS);
rec("A8 跨工单派发被拒且无幽灵任务", !!bad2.error && storeCount(ord.data.id) === before2,
  "error.code=" + bad2.error?.code + " 任务数 " + before2 + " -> " + storeCount(ord.data.id));

server.close(); stub.close();
const pass = out.filter((x) => x.ok).length;
console.log("---- 返工路径补验: " + pass + "/" + out.length + " 通过");
fs.writeFileSync(path.join(tmp, "result.json"), JSON.stringify(out, null, 2));
process.exit(pass === out.length ? 0 : 1);
