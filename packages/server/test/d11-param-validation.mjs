// D11 回归探针：mac_order_get 参数名写错时静默取到 undefined，报「工单不存在: undefined」。
//
// 三条验收（工单原文）：
//   ① mac_order_get({"orderId":"x"}) 返回参数错误（或明确提示「未知字段 orderId，应为 id」），
//      不再返回「工单不存在: undefined」
//   ② mac_order_get({"id":"不存在的单"}) 仍返回「工单不存在: <该 id>」
//   ③ mac_upload_file({"dataBase64":"..."}) 不再静默传空内容，而是报未知字段
//
// 补充断言（同属「错名字段一律静默忽略」这一族缺陷）：
//   ④ 必填缺失 / 空串 → -32602，且错误信息里不出现 undefined 字面量
//   ⑤ 只有大小写笔误（taskID）也要给出正确名提示
//   ⑥ 校验不能误伤合法入参：mac_order_attach 的 by 是合法字段
//
// 隔离原则：整套跑在 mkdtemp 的 cwd + 随机端口上，不碰正式库。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../dist/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mac-d11-"));

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

/** 原始调用：arguments 可以是任意值，用于验"非对象"分支 */
async function rpcCall(name, argsRaw) {
  const res = await fetch(base + "/mcp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: argsRaw } }),
  });
  const r = await res.json();
  const text = r.result?.content?.[0]?.text;
  let data; try { data = text ? JSON.parse(text) : undefined } catch { data = text }
  return { error: r.error, data, raw: r };
}
const tool = (name, args) => rpcCall(name, args);

const results = [];
async function check(id, title, fn) {
  try { await fn(); results.push({ id, title, ok: true }); }
  catch (e) { results.push({ id, title, ok: false, msg: e?.message ?? String(e) }); }
}
/** 断言它是参数错误，且文案里同时点到错名与正名 */
// ⚠️ 断言消息是**提前求值**的：JSON.stringify(undefined) 返回 undefined，直接 .slice 会抛
// TypeError，且报错位置会伪装成"被测代码坏了"。所以统一走 safe()。
const safe = (v) => { try { const s = JSON.stringify(v); return s === undefined ? String(v) : s.slice(0, 200); } catch { return String(v); } };
function assertParamError(r, ...musts) {
  assert.ok(r.error, "应返回 error，实际拿到 result：" + safe(r.data));
  assert.equal(r.error.code, -32602, "错误码应为 -32602（Invalid params），实际 " + r.error.code);
  for (const m of musts) assert.ok(r.error.message.includes(m), "错误信息应含「" + m + "」，实际：" + r.error.message);
}

// ── ① AC1：错名字段 ────────────────────────────────────────────────────────────
await check("A1", "mac_order_get({orderId}) 报参数错误并指向 id", async () => {
  const r = await tool("mac_order_get", { orderId: "x" });
  assertParamError(r, "未知参数", "orderId", "应为 id");
  assert.ok(!r.error.message.includes("工单不存在"), "不得再走「工单不存在」分支");
  assert.ok(!/\bundefined\b/.test(r.error.message), "错误信息不得出现 undefined 字面量");
});

// ── ② AC2：真不存在的单，行为不变 ──────────────────────────────────────────────
await check("A2", "mac_order_get({id:不存在}) 仍返回「工单不存在: <该 id>」", async () => {
  const r = await tool("mac_order_get", { id: "no-such-order" });
  assert.ok(!r.error, "不应是 JSON-RPC 错误（保持原语义：业务层回 error 字段）");
  assert.equal(r.data?.error, "工单不存在: no-such-order");
});

// ── ③ AC3：dataBase64 → 不再静默传空 ───────────────────────────────────────────
await check("A3", "mac_upload_file({dataBase64}) 报未知字段并指向 contentBase64", async () => {
  const r = await tool("mac_upload_file", { dataBase64: "aGk=" });
  assertParamError(r, "未知参数", "dataBase64", "应为 contentBase64");
});

// ── ④ 必填缺失 / 空串 ──────────────────────────────────────────────────────────
await check("A4", "mac_get_task({}) 报缺少必填参数 taskId", async () => {
  const r = await tool("mac_get_task", {});
  assertParamError(r, "缺少必填参数", "taskId");
  assert.ok(!/\bundefined\b/.test(r.error.message));
});
await check("A5", "mac_order_get({id:\"\"}) 空串等同缺失", async () => {
  const r = await tool("mac_order_get", { id: "" });
  assertParamError(r, "缺少必填参数", "id");
});
await check("A6", "mac_report 不带 taskId 不再把 undefined 拼成任务号", async () => {
  const r = await tool("mac_report", { state: "completed", name: "wb-x" });
  assertParamError(r, "缺少必填参数", "taskId");
  assert.ok(!/\bundefined\b/.test(r.error.message));
});

// ── ⑤ 只有大小写不同也要能认出 ─────────────────────────────────────────────────
await check("A7", "mac_get_task({taskID}) 提示应为 taskId", async () => {
  const r = await tool("mac_get_task", { taskID: "x" });
  assertParamError(r, "未知参数", "taskID", "应为 taskId");
});

// ── ⑥ 校验不得误伤合法入参 ─────────────────────────────────────────────────────
await check("A8", "mac_upload_file 正常入参仍可上传", async () => {
  const r = await tool("mac_upload_file", { name: "d11-probe.txt", contentBase64: Buffer.from("d11 ok").toString("base64") });
  assert.ok(!r.error, "正常入参不该被校验拦下：" + JSON.stringify(r.error));
  assert.ok(String(r.data?.uri ?? "").includes("d11-probe.txt"), "应返回带文件名的 uri，实际：" + JSON.stringify(r.data));
});
await check("A9", "mac_order_attach 的 by 是合法字段（D11 顺带补的 schema 缺口）", async () => {
  const created = await tool("mac_order_create", { title: "D11 探针单", by: "wb-d11" });
  assert.ok(!created.error, "建单失败：" + JSON.stringify(created.error));
  const id = created.data?.id;
  assert.ok(id, "未拿到工单 id：" + JSON.stringify(created.data));
  const r = await tool("mac_order_attach", { id, name: "d11-attach.txt", contentBase64: Buffer.from("x").toString("base64"), by: "wb-d11" });
  assert.ok(!r.error, "带 by 的合法挂附件被拦下了：" + JSON.stringify(r.error));
  const got = await tool("mac_order_get", { id });
  assert.equal(got.data?.order?.attachments?.length, 1, "应挂上 1 个附件");
});
await check("A10", "mac_check_in 的 state/workingOn 等可选字段不被误判", async () => {
  const r = await tool("mac_check_in", { name: "wb-d11", agent: "probe", description: "d11", host: "h", state: "working", workingOn: "跑探针", abilities: ["a"] });
  assert.ok(!r.error, "合法注册被拦下：" + JSON.stringify(r.error));
  assert.equal(r.data?.ok, true);
});

// ── ⑦ 边界：非对象 arguments、未知工具 ─────────────────────────────────────────
await check("A11", "arguments 传字符串（非对象）→ -32602", async () => {
  const r = await rpcCall("mac_order_get", "orderId=x");
  assertParamError(r, "arguments 必须是对象");
});
await check("A12", "arguments 传 null 视为未提供（口径：null 等价于省略），仍 -32602", async () => {
  // 刻意保留宽松：`msg.params?.arguments ?? {}` 把 null 和「没传」归为同一件事，
  // 这与 JSON-RPC「arguments 可省」一致，比报「必须是对象」对客户端更友好。
  // 关键是它**不会**掉进业务层拼出 "工单不存在: undefined"。
  const r = await rpcCall("mac_order_get", null);
  assertParamError(r, "缺少必填参数", "id");
});
await check("A13", "未知工具仍报错（现状 -32602，非本次改动范围）", async () => {
  const r = await tool("mac_nope", {});
  assert.equal(r.error?.code, -32602, "实际：" + JSON.stringify(r.error));
  assert.ok(r.error.message.includes("未知工具"), "实际：" + r.error.message);
});

// ── ⑧ 全局：所有错误文案都不许出现 undefined ──────────────────────────────────
await check("A14", "全部错误文案不含 undefined 字面量", async () => {
  const probes = [
    ["mac_order_get", { orderId: "x" }], ["mac_upload_file", { dataBase64: "x" }],
    ["mac_get_task", {}], ["mac_report", { state: "working" }],
    ["mac_download_file", {}], ["mac_order_attach", { id: "ord-x" }],
    ["mac_order_update", { status: "done" }], ["mac_order_cancel", {}],
    ["mac_rework", { id: "ord-x" }], ["mac_send_message", { to: "nobody" }],
  ];
  const bad = [];
  for (const [n, a] of probes) {
    const r = await tool(n, a);
    const m = r.error?.message ?? JSON.stringify(r.data ?? "");
    if (/\bundefined\b/.test(m)) bad.push(n + " -> " + m);
  }
  assert.deepEqual(bad, [], "以下文案含 undefined：" + bad.join(" | "));
});

// ── 收尾 ───────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log((r.ok ? "PASS" : "FAIL") + "  " + r.id + "  " + r.title + (r.ok ? "" : "\n        " + r.msg));
}
console.log("\n" + (results.length - failed.length) + "/" + results.length + " 通过");
server.close();
await sleep(50);
process.exit(failed.length ? 1 : 0);
