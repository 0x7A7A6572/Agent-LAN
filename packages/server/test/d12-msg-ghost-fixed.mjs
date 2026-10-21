// D12-b 回归探针：handleMessageSend 的「先落库后校验」修好没有。
//
// 与 defect 版 d12-msg-ghost-probe.mjs 的区别（那份是修复前的缺陷存在性证明，保留不动）：
//   - 缺陷版断言「冲刷后盘上有 1 条幽灵」；
//   - 本版断言「冲刷后 0 条」。
// 关键点：失败当时盘上干净**不能**说明没幽灵（saveTasks 是 300ms 防抖，且本路径原本压根没调它）。
// 必须用一笔正常建单把盘刷出来再数——saveTasks 写的是 [...tasks.values()]，所以
// 「冲刷后 0 条」同时证明了内存里也没有残留，这才是治本。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createServer } from "../dist/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mac-d12b-"));

// pm 切换会跑 pmProbe 真调模型：给一个进程内假 /chat/completions，避免依赖本机凭据
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
const base = "http://127.0.0.1:" + port;

async function tool(name, args) {
  const res = await fetch(base + "/mcp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const r = await res.json();
  const text = r.result?.content?.[0]?.text;
  let data; try { data = text ? JSON.parse(text) : undefined } catch { data = text }
  return { error: r.error, data };
}
function countByMarker(marker) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(tmp, ".taskstore.json"), "utf8"));
    return (Array.isArray(s) ? s : []).filter((t) => String(t.prompt ?? "").includes(marker)).length;
  } catch { return 0; }
}
function inQueue(marker) {
  try {
    const q = JSON.parse(fs.readFileSync(path.join(tmp, ".tasks.json"), "utf8"));
    const flat = Array.isArray(q) ? q : Object.values(q).flat();
    return (Array.isArray(flat) ? flat : []).filter((t) => String(t?.prompt ?? "").includes(marker)).length;
  } catch { return 0; }
}
const setMode = async (mode) => (await (await fetch(base + "/console/pm/mode", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }),
})).json());

// 冲刷用的 sink 节点：只收工单、从不 pull，避免 FIFO 抢走正对照任务
await tool("mac_check_in", { name: "wb-sink", host: "h", agent: "workbuddy" });

const out = [];
const rec = (n, ok, d) => { out.push({ n, ok, d }); console.log((ok ? "[PASS] " : "[FAIL] ") + n + " :: " + d); };

// ── 场景 1：target 是未注册节点 ────────────────────────────────────────
const M1 = "D12B-UNKNOWN-TARGET-" + Date.now();
const r1 = await tool("mac_send_task", { prompt: M1, target: "wb-does-not-exist" });
await sleep(500);
rec("A1 未知 target 仍报 -32602（不是被静默吞掉）", r1.error?.code === -32602,
  "error.code=" + r1.error?.code + " msg=" + String(r1.error?.message).slice(0, 40));
rec("A2 失败当刻盘上 0 条（懒写期，仅作观测）", countByMarker(M1) === 0, "命中=" + countByMarker(M1));

// 冲刷：任何一笔会 saveTasks 的动作都会把内存里所有 task 写出去
await tool("mac_order_create", { title: "冲刷A", description: "触发 saveTasks", assignee: "wb-sink", by: "human-console" });
await sleep(800);
rec("A3 冲刷后未知 target 依然 0 条残留（内存也无幽灵）", countByMarker(M1) === 0,
  "冲刷后 .taskstore.json 命中=" + countByMarker(M1) + " 条" + (countByMarker(M1) === 0 ? " ✓ 治本" : " ← 仍有幽灵，重启会复活"));

// ── 场景 2：pm 模式下非 PM 节点派裸任务，被门禁拒 ──────────────────────
await tool("mac_check_in", { name: "wb-inbound", host: "h", agent: "workbuddy" });
const jm = await setMode("pm");
assert.equal(jm.ok, true, "切 pm 失败: " + JSON.stringify(jm));
const M2 = "D12B-GATE-DENIED-" + Date.now();
const r2 = await tool("mac_send_task", { prompt: M2, target: "wb-inbound", from: "wb-other" });
await sleep(500);
rec("A4 门禁拒绝仍报 -32603（错误码没被外层拍平成 -32000）", r2.error?.code === -32603,
  "error.code=" + r2.error?.code + " msg=" + String(r2.error?.message).slice(0, 50));
await setMode("human");
await tool("mac_order_create", { title: "冲刷B", description: "触发 saveTasks", assignee: "wb-sink", by: "human-console" });
await sleep(800);
rec("A5 冲刷后门禁拒绝路径 0 条残留", countByMarker(M2) === 0, "命中=" + countByMarker(M2) + " 条");

// ── 场景 3：正对照，放行时仍要正常入队 + 落库 + 能被 pull 到 ───────────
const M3 = "D12B-OK-" + Date.now();
const r3 = await tool("mac_send_task", { prompt: M3, target: "wb-inbound", from: "wb-other" });
await sleep(400);
// deps.sendTask 返回的是扁平结构 {taskId, state}，不是 {task:{id}}（踩过一次，别猜字段）
rec("A6 正对照无 error 且拿到 taskId", r3.error === undefined && !!r3.data?.taskId,
  "taskId=" + (r3.data?.taskId ?? "null") + " state=" + r3.data?.state);
rec("A7 正对照进入待领队列", inQueue(M3) >= 1, ".tasks.json 入队命中=" + inQueue(M3));
const pulled = await tool("mac_pull_task", { name: "wb-inbound", waitMs: 1500 });
rec("A8 正对照能被目标节点 pull 到", String(pulled.data?.task?.prompt ?? "").includes(M3),
  "pull 到的 prompt 前缀=" + String(pulled.data?.task?.prompt ?? "(空)").slice(0, 30));
await tool("mac_order_create", { title: "冲刷C", description: "触发 saveTasks", assignee: "wb-sink", by: "human-console" });
await sleep(800);
rec("A9 正对照正常落库 1 条", countByMarker(M3) === 1, "命中=" + countByMarker(M3) + " 条");

server.close(); stub.close();
const pass = out.filter((x) => x.ok).length;
console.log("---- D12-b handleMessageSend 回归: " + pass + "/" + out.length + " 项断言通过");
fs.writeFileSync(path.join(tmp, "result.json"), JSON.stringify(out, null, 2));
if (pass !== out.length) process.exitCode = 1;
