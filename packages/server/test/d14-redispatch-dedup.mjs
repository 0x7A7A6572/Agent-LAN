// D14 回归探针：同一工单连续重派会产生 N 个重复任务、全部入队同一节点。
//
// 三条验收（工单原文）：
//   ① 同单连派 3 次，taskstore 里该单「未终态」任务 = 1
//   ② 换 assignee 重派后，旧节点 mac_pull_task 拿不到旧副本
//   ③ 节点只收到 1 次
//
// 关键判据都读盘：saveTasks 是 300ms 防抖，所以要等 >500ms 再数；
// 只测内存态或"当时写没写"会得出错误结论。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../dist/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mac-d14-"));

process.env.MAC_PM_CONFIG = path.join(tmp, ".pm-config.json");
fs.writeFileSync(process.env.MAC_PM_CONFIG, JSON.stringify({
  enabled: false, provider: "openai", baseUrl: "http://127.0.0.1:1", apiKey: "test",
  model: "test", temperature: 0.2, debounceMs: 3000, tickMs: 0,
  maxActionsPerDecision: 10, tokenBudget: 6000, timeoutMs: 15000,
}));

const server = createServer({
  card: { name: "hub-test", description: "t", url: "http://127.0.0.1:0", version: "0.0.0", capabilities: { streaming: false, adapters: ["mcp"] } },
  adapter: { async *invoke() {} }, port: 0, selfRegister: false,
  filesDir: path.join(tmp, ".mac-files"), ordersPath: path.join(tmp, ".orders.json"),
  rolesPath: path.join(tmp, ".roles.json"), nodesPath: path.join(tmp, ".nodes.json"),
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;

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

const TERMINAL = new Set(["completed", "failed", "canceled"]);
/** 读盘统计某工单的任务：全部 / 未终态 */
function tasksOf(orderId) {
  const marker = "[工单 " + orderId + "]";
  try {
    const all = (JSON.parse(fs.readFileSync(path.join(tmp, ".taskstore.json"), "utf8")) || [])
      .filter((t) => String(t.prompt ?? "").includes(marker));
    return { total: all.length, live: all.filter((t) => !TERMINAL.has(t.state)).length,
      states: all.map((t) => t.state).join(",") };
  } catch { return { total: 0, live: 0, states: "" } }
}
/** 读盘统计某节点待领队列里该工单的任务数（.tasks.json 是 Record<节点名, Task[]>，必须按名取） */
function queueOf(name, orderId) {
  const marker = "[工单 " + orderId + "]";
  try {
    const q = JSON.parse(fs.readFileSync(path.join(tmp, ".tasks.json"), "utf8"));
    const arr = Array.isArray(q) ? q : (q?.[name] ?? []);
    return (Array.isArray(arr) ? arr : []).filter(
      (t) => String(t?.prompt ?? "").includes(marker),
    ).length;
  } catch { return 0 }
}
/** 全队列里该工单的任务数（用于交叉核对：清空后应为 1 份=新节点那份） */
function queueOfAny(orderId) {
  const marker = "[工单 " + orderId + "]";
  try {
    const q = JSON.parse(fs.readFileSync(path.join(tmp, ".tasks.json"), "utf8"));
    const arr = Array.isArray(q) ? q : Object.values(q).flat();
    return (Array.isArray(arr) ? arr : []).filter(
      (t) => String(t?.prompt ?? "").includes(marker),
    ).length;
  } catch { return 0 }
}
const orderStatus = async (id) => (await tool("mac_order_get", { id }))?.data?.order?.status;

const out = [];
const rec = (n, ok, d) => { out.push({ n, ok, d }); console.log((ok ? "[PASS] " : "[FAIL] ") + n + " :: " + d); };

await tool("mac_check_in", { name: "wb-a", host: "h", agent: "workbuddy" });
await tool("mac_check_in", { name: "wb-b", host: "h", agent: "workbuddy" });

// ── 建单（建单即派发，wb-a 拿到第 1 份）────────────────────────────────
const created = await tool("mac_order_create", {
  title: "D14 连派去重", description: "探针用单", assignee: "wb-a", by: "human-console",
});
const oid = created.data?.id ?? created.data?.order?.id;
assert.ok(oid, "建单失败: " + JSON.stringify(created).slice(0, 200));
await sleep(700);
const s0 = tasksOf(oid);
rec("B1 建单即派发后：未终态任务 = 1", s0.live === 1, `total=${s0.total} live=${s0.live} states=${s0.states}`);
rec("B1b 首派任务在 wb-a 队列里", queueOf("wb-a", oid) === 1, "wb-a 队列命中=" + queueOf("wb-a", oid));

// ── 连派 3 次（同一 assignee）──────────────────────────────────────────
for (let i = 1; i <= 3; i++) {
  const r = await tool("mac_order_dispatch", { id: oid, assignee: "wb-a", by: "human-console" });
  if (r.error) console.log("    第 " + i + " 次重派 error=" + JSON.stringify(r.error).slice(0, 120));
  await sleep(350);
}
await sleep(700);
const s1 = tasksOf(oid);
rec("B2 ★验收①：同单连派 3 次后，未终态任务 = 1", s1.live === 1,
  `total=${s1.total} live=${s1.live} states=${s1.states}`);
rec("B3 历史副本被作废（不是删除，state=canceled）", s1.total === 4 && s1.states.split(",").filter((x) => x === "canceled").length === 3,
  `total=${s1.total} states=${s1.states}`);
rec("B4 ★验收③前半：wb-a 队列里只有 1 份", queueOf("wb-a", oid) === 1, "队列命中=" + queueOf("wb-a", oid));
rec("B5 作废旧副本没有把工单改成 canceled", (await orderStatus(oid)) === "developing",
  "orderStatus=" + (await orderStatus(oid)));

// ── 换 assignee 重派：旧节点不能还拿到副本 ─────────────────────────────
const rd = await tool("mac_order_dispatch", { id: oid, assignee: "wb-b", by: "human-console" });
if (rd.error) console.log("    换人重派 error=" + JSON.stringify(rd.error).slice(0, 120));
await sleep(800);
const s2 = tasksOf(oid);
rec("B6 换人重派后：未终态任务仍 = 1", s2.live === 1, `total=${s2.total} live=${s2.live} states=${s2.states}`);
rec("B7 wb-a 队列已清空（旧副本不再送达）", queueOf("wb-a", oid) === 0,
  "wb-a 队列命中=" + queueOf("wb-a", oid) + " | 全队列该单合计=" + queueOfAny(oid) + "（应为 1 = 新节点那份）");
rec("B8 wb-b 队列里有且仅有 1 份", queueOf("wb-b", oid) === 1, "wb-b 队列命中=" + queueOf("wb-b", oid));

// ── 真的 pull：旧节点拉不到、新节点只收到 1 次 ─────────────────────────
const pullA = await tool("mac_pull_task", { name: "wb-a", waitMs: 1200 });
const gotA = String(pullA.data?.task?.prompt ?? "");
rec("B9 ★验收②：旧节点 mac_pull_task 拿不到旧副本", !gotA.includes(oid),
  "wb-a pull 到=" + (gotA ? gotA.slice(0, 40) : "(空)"));
const pullB1 = await tool("mac_pull_task", { name: "wb-b", waitMs: 1200 });
rec("B10 新节点能领到该单任务", String(pullB1.data?.task?.prompt ?? "").includes(oid),
  "wb-b pull 到=" + String(pullB1.data?.task?.prompt ?? "(空)").slice(0, 40));
const pullB2 = await tool("mac_pull_task", { name: "wb-b", waitMs: 1200 });
rec("B11 ★验收③：新节点再拉一次为空（只收到 1 次）",
  !String(pullB2.data?.task?.prompt ?? "").includes(oid),
  "第二次 pull=" + String(pullB2.data?.task?.prompt ?? "(空)").slice(0, 40));

server.close();
const pass = out.filter((x) => x.ok).length;
console.log("---- D14 连派去重: " + pass + "/" + out.length + " 项断言通过");
fs.writeFileSync(path.join(tmp, "result.json"), JSON.stringify(out, null, 2));
if (pass !== out.length) process.exitCode = 1;
