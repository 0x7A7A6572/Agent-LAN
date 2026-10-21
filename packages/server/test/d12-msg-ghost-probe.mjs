// 第三处「先落库后校验」的路径核查：handleMessageSend（mac_send_task / mac_send_message 带 target）。
// dispatchOrder 与 reworkOrder 已被 D12 补丁修好，但 handleMessageSend 在 tasks.set 之后才校验 target，
// 校验失败（未知节点 / 门禁拒绝）时同样会把任务留在 .taskstore.json 里 —— 这是补丁没有覆盖的第三处。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createServer } from "../dist/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mac-d12-msg-"));

const stub = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => { res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "{}" } }] })); });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
process.env.MAC_PM_CONFIG = path.join(tmp, ".pm-config.json");
fs.writeFileSync(process.env.MAC_PM_CONFIG, JSON.stringify({
  enabled: false, provider: "openai", baseUrl: "http://127.0.0.1:" + stub.address().port,
  apiKey: "test", model: "test", temperature: 0.2, debounceMs: 3000, tickMs: 0,
  maxActionsPerDecision: 10, tokenBudget: 6000, timeoutMs: 15000,
}));

const server = createServer({
  card: { name: "hub-test", description: "t", url: "http://127.0.0.1:0", version: "0.0.0", capabilities: { streaming: false, adapters: ["mcp"] } },
  adapter: { async *invoke() {} }, port: 0, selfRegister: false,
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
function countByMarker(marker) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(tmp, ".taskstore.json"), "utf8"));
    return (Array.isArray(s) ? s : []).filter((t) => String(t.prompt ?? "").includes(marker)).length;
  } catch { return 0; }
}

const out = [];
const rec = (n, ok, d) => { out.push({ n, ok, d }); console.log((ok ? "[PASS] " : "[FAIL] ") + n + " :: " + d); };

// 场景 1：target 写成一个从未注册过的节点名
const M1 = "GHOST-PROBE-UNKNOWN-TARGET-" + Date.now();
const r1 = await tool("mac_send_task", { prompt: M1, target: "wb-does-not-exist" });
await sleep(600);
rec("未知 target 报错", !!r1.error, "error.code=" + r1.error?.code + " msg=" + String(r1.error?.message).slice(0, 40));
// 观测点（不是结论）：handleMessageSend 在 tasks.set 之后没有立即 saveTasks，
// 所以此刻盘上是干净的 —— 这是「懒写」造成的假象，不能据此判「没有幽灵任务」。
rec("观测1：失败当时盘上无残留（懒写假象，勿当结论）", countByMarker(M1) === 0,
  "taskstore 命中=" + countByMarker(M1) + " 条");

// 场景 2：pm 模式下由非 PM 节点向已注册节点派裸任务
await tool("mac_check_in", { name: "wb-inbound", host: "h", agent: "workbuddy" });
const modeRes = await fetch("http://127.0.0.1:" + port + "/console/pm/mode", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "pm" }),
});
const j = await modeRes.json();
assert.equal(j.ok, true, "切 pm 失败: " + JSON.stringify(j));

const M2 = "GHOST-PROBE-GATE-DENIED-" + Date.now();
const r2 = await tool("mac_send_task", { prompt: M2, target: "wb-inbound", by: "wb-other" });
await sleep(600);
rec("pm 模式下裸任务被门禁拒", !!r2.error, "error.code=" + r2.error?.code + " msg=" + String(r2.error?.message).slice(0, 50));
rec("观测2：门禁拒绝当时盘上无残留（同为懒写假象）", countByMarker(M2) === 0,
  "taskstore 命中=" + countByMarker(M2) + " 条");

// 关键补充：handleMessageSend 的 tasks.set 之后**没有立即 saveTasks**，
// 幽灵任务此刻只在内存里；只要下一笔任何会落盘的操作（dispatchOrder 就会 saveTasks），
// 它就被一起写进 .taskstore.json，重启后复活。下面用一次正常建单派发把盘刷出来。
await fetch("http://127.0.0.1:" + port + "/console/pm/mode", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "human" }),
});
await tool("mac_order_create", { title: "冲刷落盘", description: "只为触发 saveTasks", assignee: "wb-inbound", by: "human-console" });
await sleep(700);
rec("结论1：未知 target 的幽灵任务确实存在（冲刷后写盘）", countByMarker(M1) === 1,
  "冲刷后 .taskstore.json M1 命中=" + countByMarker(M1) + " 条" + (countByMarker(M1) > 0 ? " ← 重启会复活" : ""));
rec("结论2：门禁拒绝的裸任务同样存在（冲刷后写盘）", countByMarker(M2) === 1,
  "M2 命中=" + countByMarker(M2) + " 条" + (countByMarker(M2) > 0 ? " ← 重启会复活" : ""));

// 场景 3（正对照）：human 模式下同样调用应成功入队
await fetch("http://127.0.0.1:" + port + "/console/pm/mode", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "human" }),
});
const M3 = "GHOST-PROBE-OK-" + Date.now();
const r3 = await tool("mac_send_task", { prompt: M3, target: "wb-inbound", by: "wb-other" });
await sleep(600);
await tool("mac_order_create", { title: "再冲刷一次", description: "为 M3 触发落盘", assignee: "wb-inbound", by: "human-console" });
await sleep(700);
rec("正对照：放行时任务正常落库", r3.error === undefined && countByMarker(M3) === 1,
  "error=" + JSON.stringify(r3.error) + " 冲刷后 taskstore 命中=" + countByMarker(M3));

server.close(); stub.close();
const pass = out.filter((x) => x.ok).length;
console.log("---- handleMessageSend 幽灵任务核查: " + pass + "/" + out.length + " 项断言通过（结论1/2 通过 = 第三处仍有幽灵任务）");
fs.writeFileSync(path.join(tmp, "result.json"), JSON.stringify(out, null, 2));
