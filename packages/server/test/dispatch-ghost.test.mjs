// D12「幽灵任务」回归测试
//
// 背景：dispatchOrder 原来是「先 tasks.set + saveTasks 落库，再 enqueueFor 入队」。
// enqueueFor 内部被 Supervisor 门禁 throw 时没有任何回滚，于是任务既不在待领队列、
// 也没投递给任何节点，只在 .taskstore.json 里留下一条永远没人领、重启还会复活的
// 「幽灵任务」。本文件把这条链路钉死。
//
// 运行（仓库根目录）：
//   pnpm -r build            # 测试跑的是 dist 产物，必须先构建
//   pnpm --filter @mac/server test
// 或直接：
//   cd packages/server && node --test test/dispatch-ghost.test.mjs
//
// 为什么不等 tsc watch：读 dist/*.js 而不是 src/*.ts，是为了不在测试里引入
// 额外的 TS 运行时依赖（本仓库此前零测试文件，不为此新增 devDependency）。

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createServer } from "../dist/index.js";
import { evaluateDispatch, isReworkPrompt } from "../dist/gate.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** saveTasks/saveQueues 是 300ms 防抖落盘，读盘前必须等过这个窗口 */
const FLUSH_MS = 450;

let tmp;
let server;
let stub;
let port;

async function rpc(method, params) {
  const res = await fetch("http://127.0.0.1:" + port + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  return res.json();
}

/** 调一个 MCP 工具，返回 { error, data }；data 已 JSON 解析 */
async function tool(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text;
  return { error: r.error, data: text ? JSON.parse(text) : undefined };
}

/** 切派发权：provider 配成 workbuddy 时 pmProbe 直接放行，不需要真模型 */
async function setGateMode(mode) {
  const res = await fetch("http://127.0.0.1:" + port + "/console/pm/mode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode })
  });
  const j = await res.json();
  assert.equal(j.ok, true, "切换派发权失败: " + JSON.stringify(j));
  assert.equal(j.mode, mode);
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

/** 落盘的任务库里，挂在某张工单下的任务数（幽灵任务就是这么数出来的） */
function taskCountForOrder(orderId) {
  const store = readJson(path.join(tmp, ".taskstore.json"));
  if (!Array.isArray(store)) return 0;
  return store.filter(t => String(t.prompt ?? "").includes("[工单 " + orderId + "]")).length;
}

/** 待领队列里挂在某张工单下的任务数 */
function queuedCountForOrder(orderId) {
  const q = readJson(path.join(tmp, ".tasks.json"));
  if (!q || typeof q !== "object") return 0;
  let n = 0;
  for (const list of Object.values(q)) {
    if (!Array.isArray(list)) continue;
    n += list.filter(t => String(t.prompt ?? "").includes("[工单 " + orderId + "]")).length;
  }
  return n;
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mac-d12-"));

  // ⚠️ 本机修正（验收方 wb-dev-pc-win11）：
  // 原版这里配 provider="workbuddy" 并假设「pmProbe 直接放行，不需要真模型」——不成立。
  // POST /console/pm/mode 切到 pm 之前会跑 pmProbe()，workbuddy 分支会**真的**去调一次模型，
  // 本机无模型凭据时返回 HTTP 400「model [test] service info not found」，于是 A1/A3/A4 全挂在
  // 「切换派发权失败」上（不是被测代码错，是测试装置错）。
  // 改为把 provider 指向本进程内的假 /chat/completions 端点：静态校验过、探测拿 200、零外部依赖。
  stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "{}" } }] }));
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const stubUrl = "http://127.0.0.1:" + stub.address().port;

  // pmPaths 在 createServer 里读一次，必须在建服务前指到临时目录
  process.env.MAC_PM_CONFIG = path.join(tmp, ".pm-config.json");
  fs.writeFileSync(process.env.MAC_PM_CONFIG, JSON.stringify({
    enabled: false, provider: "openai", baseUrl: stubUrl, apiKey: "test", model: "test",
    temperature: 0.2, debounceMs: 3000, tickMs: 0, maxActionsPerDecision: 10,
    tokenBudget: 6000, timeoutMs: 15000
  }));

  server = createServer({
    card: {
      name: "hub-test", description: "测试用主服务", url: "http://127.0.0.1:0",
      version: "0.0.1", capabilities: { streaming: false, adapters: ["mcp"] }
    },
    adapter: { async *invoke() { /* 测试不驱动真实 agent */ } },
    port: 0,
    selfRegister: false,
    filesDir: path.join(tmp, ".mac-files"),
    ordersPath: path.join(tmp, ".orders.json"),
    rolesPath: path.join(tmp, ".roles.json"),
    nodesPath: path.join(tmp, ".nodes.json")
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  port = server.address().port;

  // 目标节点必须在册，否则 redispatchOrder 会先因「目标不在线」短路，走不到门禁
  const reg = await tool("mac_check_in", { name: "wb-target", host: "test-host", agent: "workbuddy" });
  assert.equal(reg.error, undefined, "目标节点注册失败: " + JSON.stringify(reg.error));
});

after(() => {
  server?.close();
  stub?.close();
});

describe("D12 门禁语义（纯函数）", () => {
  test("rework 标记只认 [返工] 字面量，且预检与入队共用同一判据", () => {
    assert.equal(isReworkPrompt("[工单 x] y\n\n[返工] 原因"), true);
    assert.equal(isReworkPrompt("[工单 x] y"), false);
  });

  test("human-console 与 PM 本人在任何模式下都放行", () => {
    for (const mode of ["human", "pm"]) {
      assert.equal(evaluateDispatch(mode, "hub-pm", { actor: "human-console", target: "wb-1" }).allow, true);
      assert.equal(evaluateDispatch(mode, "hub-pm", { actor: "hub-pm", target: "wb-1" }).allow, true);
    }
  });

  test("human 模式下任意节点放行", () => {
    assert.equal(evaluateDispatch("human", "hub-pm", { actor: "wb-1", target: "wb-2" }).allow, true);
  });

  test("pm 模式下跨工单派发被拒，同工单返工豁免", () => {
    const denied = evaluateDispatch("pm", "hub-pm", { actor: "wb-1", target: "wb-2", orderId: "ord-1" });
    assert.equal(denied.allow, false);
    assert.match(denied.reason, /Supervisor/);
    assert.match(denied.reason, /wb-1/); // 原因里要点名发起方，便于追溯

    const rework = evaluateDispatch("pm", "hub-pm", { actor: "wb-1", target: "wb-2", orderId: "ord-1", rework: true });
    assert.equal(rework.allow, true);
  });
});

describe("D12 幽灵任务回归", () => {
  test("A1 门禁拒绝时不得落库：taskstore 与队列均无残留", async () => {
    await setGateMode("pm");

    const r = await tool("mac_order_create", {
      title: "D12 幽灵任务回归", description: "pm 模式下由非 PM 节点建单并指名处理人",
      assignee: "wb-target", by: "wb-other"
    });

    // 伴生缺陷：工单本身建成功了，不能整单返回 error
    assert.equal(r.error, undefined, "建单不应返回 error: " + JSON.stringify(r.error));
    assert.ok(r.data?.id, "应返回已建工单");
    assert.ok(r.data.dispatchError, "应带出派发失败原因");
    assert.match(r.data.dispatchError, /Supervisor/);

    await sleep(FLUSH_MS);
    assert.equal(taskCountForOrder(r.data.id), 0, ".taskstore.json 里出现了幽灵任务");
    assert.equal(queuedCountForOrder(r.data.id), 0, ".tasks.json 里出现了幽灵任务");

    // 工单确实在（不是「什么都没发生」），调用方因此不需要重试建单
    const got = await tool("mac_order_get", { id: r.data.id });
    assert.equal(got.data?.order?.id, r.data.id);
  });

  test("A2 正对照：放行时任务确实入队且只入一次", async () => {
    await setGateMode("human");

    const r = await tool("mac_order_create", {
      title: "D12 正对照", description: "human 模式下指名派发应当成功",
      assignee: "wb-target", by: "wb-other"
    });
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    assert.equal(r.data?.dispatchError, undefined, "放行路径不该有 dispatchError");

    await sleep(FLUSH_MS);
    assert.equal(taskCountForOrder(r.data.id), 1, "放行路径应有且仅有 1 条任务");
    assert.equal(queuedCountForOrder(r.data.id), 1, "放行路径任务应进入待领队列");
  });

  test("A3 被拒的工单状态不被推进（仍可后续补派）", async () => {
    await setGateMode("pm");
    const r = await tool("mac_order_create", {
      title: "D12 状态不推进", description: "被拒时不应把工单推进 developing",
      assignee: "wb-target", by: "wb-other"
    });
    assert.ok(r.data?.id);
    const got = await tool("mac_order_get", { id: r.data.id });
    assert.notEqual(got.data?.order?.status, "developing", "派发被拒却把工单推进了 developing");
  });

  test("A4 派发被拒透出内部错误码 -32603，不被拍平成 -32000", async () => {
    await setGateMode("pm");
    // mac_order_dispatch 走独立的派发通道，被拒时错误码必须可区分于「参数错」
    const created = await tool("mac_order_create", {
      title: "D12 错误码透出", description: "先建一张不指名的单", by: "human-console"
    });
    assert.ok(created.data?.id);
    const d = await tool("mac_order_dispatch", { id: created.data.id, assignee: "wb-target", by: "wb-other" });
    assert.ok(d.error, "pm 模式下跨工单派发应失败");
    assert.equal(d.error.code, -32603, "门禁错误码被拍平了: " + d.error.code);
  });
});
