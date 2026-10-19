// A2A server：Agent Card 发现、任务状态机、心跳名册、控制台
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentAdapter, AgentCard, Task, TaskState, InvokeEvent, AgentPresence } from "@mac/sdk";
import { AGENT_CARD_PATH, A2A_METHODS } from "@mac/sdk";
import { Registry } from "./registry.js";
import { createRemoteProxy } from "./remote-proxy.js";
import { FileChannel } from "./file-channel.js";
import { OrderStore } from "./orders.js";
import type { Order } from "./types.js";
import { RoleStore } from "./roles.js";
import { mcpHandle, type McpFacadeDeps } from "./mcp-facade.js";
export { createTui } from "./tui.js";
export { createRemoteProxy } from "./remote-proxy.js";

export interface ServerOptions {
  card: AgentCard;
  adapter: AgentAdapter;
  port: number;
  /** 本机控制台是否也注册自己（默认 true） */
  selfRegister?: boolean;
  /** 多行日志回调，控制台 TUI 直接复用 */
  onLog?: (line: string) => void;
  /** 文件通道存储目录，缺省 .mac-files */
  filesDir?: string;
  /** 工单落盘文件，缺省 filesDir 同级 .orders.json */
  ordersPath?: string;
  /** 角色映射落盘文件，缺省 filesDir 同级 .roles.json */
  rolesPath?: string;
  /** 节点名册落盘文件，缺省 filesDir 同级 .nodes.json */
  nodesPath?: string;
  /** debug 日志（心跳/check_in 刷屏类）是否显示，默认否 */
  debugLogs?: boolean;
}

const terminalStates: ReadonlySet<TaskState> = new Set(["completed", "failed", "canceled"]);

export function createServer(options: ServerOptions): http.Server {
  const tasks = new Map<string, Task>();
  const registry = new Registry(options.nodesPath
    ?? path.join(path.resolve(options.filesDir ?? ".mac-files"), "..", ".nodes.json"));
  const sseClients = new Map<string, Set<http.ServerResponse>>();
  const presenceSubs = new Set<http.ServerResponse>();
  const logs: string[] = [];
  const log = (line: string, level: "info" | "debug" = "info") => {
    // debug 级默认不入日志：心跳类高频刷屏用
    if (level === "debug" && !options.debugLogs) return;
    const stamped = new Date().toLocaleTimeString("zh-CN", { hour12: false }) + " " + line;
    logs.push(stamped);
    if (logs.length > 200) logs.shift();
    options.onLog?.(stamped);
  };

  // 入站客户端（workbuddy/dsh 等）长轮询领取的任务队列
  const pullWaiters: Map<string, ((task: Task) => void)[]> = new Map();
  const PULL_TIMEOUT_MS = 25000;

  // 待领队列持久化：.tasks.json 防抖落盘，hub 重启恢复，防排队任务无声丢失
  const tasksPath = options.ordersPath
    ? path.join(path.dirname(options.ordersPath), ".tasks.json")
    : path.join(path.resolve(options.filesDir ?? ".mac-files"), "..", ".tasks.json");
  const pullQueues: Map<string, Task[]> = new Map();
  let queueSaveTimer: ReturnType<typeof setTimeout> | undefined;
  function saveQueues(): void {
    clearTimeout(queueSaveTimer);
    queueSaveTimer = setTimeout(() => {
      queueSaveTimer = undefined;
      const obj: Record<string, Task[]> = {};
      for (const [k, v] of pullQueues) if (v.length) obj[k] = v;
      try { fs.writeFileSync(tasksPath, JSON.stringify(obj, null, 2)); } catch { /* 下次变更重试 */ }
    }, 300);
    queueSaveTimer.unref?.();
  }
  function flushQueues(): void {
    if (!queueSaveTimer) return;
    clearTimeout(queueSaveTimer);
    queueSaveTimer = undefined;
    const obj: Record<string, Task[]> = {};
    for (const [k, v] of pullQueues) if (v.length) obj[k] = v;
    try { fs.writeFileSync(tasksPath, JSON.stringify(obj, null, 2)); } catch { /* 退出时尽力 */ }
  }
  try {
    const raw = JSON.parse(fs.readFileSync(tasksPath, "utf8")) as Record<string, Task[]>;
    for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) pullQueues.set(k, v);
  } catch { /* 首次启动无文件 */ }

  // 任务库持久化：.taskstore.json 防抖落盘，重启不丢任务（防节点上报「任务不存在」）
  const taskStorePath = path.join(path.dirname(tasksPath), ".taskstore.json");
  let taskSaveTimer: ReturnType<typeof setTimeout> | undefined;
  function saveTasks(): void {
    clearTimeout(taskSaveTimer);
    taskSaveTimer = setTimeout(() => {
      taskSaveTimer = undefined;
      try {
        fs.writeFileSync(taskStorePath, JSON.stringify([...tasks.values()], null, 2));
      } catch { /* 下次变更重试 */ }
    }, 300);
    taskSaveTimer.unref?.();
  }
  function flushTasks(): void {
    if (!taskSaveTimer) return;
    clearTimeout(taskSaveTimer);
    taskSaveTimer = undefined;
    try { fs.writeFileSync(taskStorePath, JSON.stringify([...tasks.values()], null, 2)); } catch { /* 退出时尽力 */ }
  }
  try {
    const raw = JSON.parse(fs.readFileSync(taskStorePath, "utf8")) as Task[];
    for (const t of Array.isArray(raw) ? raw : []) tasks.set(t.id, t);
  } catch { /* 首次启动无文件 */ }

  function enqueueFor(name: string, task: Task): void {
    const waiters = pullWaiters.get(name);
    if (waiters?.length) {
      const w = waiters.shift()!;
      w(task);
    } else {
      // 无人等：存入待领队列
      let q = pullQueues.get(name);
      if (!q) { q = []; pullQueues.set(name, q); }
      q.push(task);
      saveQueues();
    }
  }
  // 节点信箱：人随时插话，对方 pull 时随任务一并带走
  const mailboxes: Map<string, { text: string; from: string; at: string }[]> = new Map();

  function dropMail(name: string): { text: string; from: string; at: string }[] {
    const mail = mailboxes.get(name);
    mailboxes.delete(name);
    return mail ?? [];
  }

  // ── 「正在处理」可见性 ────────────────────────────────────────────────
  // 控制台的执行中态原来只由「任务投递 / report(working)」驱动，于是：
  //   留言送达 → worker 消费后即退出 → 没有任何置执行态的时机 → 控制台一直显示「空闲」
  // 这里把三类来源统一成执行态：task（投递驱动）、message（送达驱动）、agent（节点自报，如人工接管）。
  const MSG_BUSY_TTL_MS = 10 * 60 * 1000;   // 留言消化兜底；节点下一次领活即提前清除
  const AGENT_BUSY_TTL_MS = 15 * 60 * 1000; // 节点主动上报兜底；显式 idle 可提前清除

  /** 留言送达即置执行中（留言没有任务生命周期，不置位控制台就看不见） */
  function markMailBusy(name: string, mail: { text?: string; from?: string }[]): void {
    if (!mail.length) return;
    const first = String(mail[0]?.text ?? "").replace(/\s+/g, " ").trim();
    const more = mail.length > 1 ? "等 " + mail.length + " 条" : "";
    const preview = first.length > 24 ? first.slice(0, 24) + "…" : first;
    registry.setBusy(name, true, "处理留言" + more + "：" + (preview || "(空)"), "message", MSG_BUSY_TTL_MS);
  }

  /** 节点重新领活 = 上一条留言已消化完，清掉留言执行态（任务态与主动上报态不动） */
  function clearMailBusyOnPull(name: string): void {
    if (registry.busyKindOf(name) === "message") registry.setBusy(name, false);
  }

  /** 投递确认送达：清 in-flight 标志，此后不再被当作丢失回收 */
  function confirmDelivered(taskId: string): void {
    const t = tasks.get(taskId);
    if (!t || !t.deliveredInFlight) return;
    t.deliveredInFlight = false;
    saveTasks();
  }

  /** 启动时回收：in-flight 说明上次投递的响应没能写完（多为进程被杀），任务没人拿到 */
  function reclaimInFlight(): void {
    for (const t of tasks.values()) {
      if (t.deliveredInFlight) {
        t.deliveredInFlight = false;
        redeliverTask(t.id, t.deliveredTo ?? "");
      }
    }
  }

  // 投递丢失回收：任务已交给某 waiter，但客户端在收到响应前断开时，
  // 它既不在队列也不在跑，会永久卡 working（要等 30 分钟超时）。
  // 判据由响应写出结果给出（facade 侧 socket 未 flush），不做时间猜测——
  // 时间判据会误伤「worker 领完退出、上层处理完再重启」的正常流程。
  function redeliverTask(taskId: string, name: string): void {
    const t = tasks.get(taskId);
    // input-required 是「等人工」的正当停顿，不是投递失败，绝不能回收重投——
    // 否则节点刚报完等人工，下一轮 pull 又收到同一任务，状态被打回 working。
    if (!t || !name || t.state !== "working" || t.reportedAt) return;
    t.state = "submitted";
    t.updatedAt = new Date().toISOString();
    t.deliveredAt = undefined;
    t.deliveredTo = undefined;
    t.deliveredInFlight = false;
    let q = pullQueues.get(name);
    if (!q) { q = []; pullQueues.set(name, q); }
    q.push(t);
    saveQueues();
    saveTasks();
    // 该节点已不再持有此任务：清执行态，免得控制台一直显示这条旧任务
    const stillBusy = [...tasks.values()].some(x =>
      x.id !== t.id && x.state === "working" && x.deliveredTo === name && !x.reportedAt);
    if (!stillBusy) registry.setBusy(name, false);
    pushPresence();
    log("[task] " + t.id.slice(0, 8) + " 投递未送达（连接中断），已回收重排队（" + name + "）");
  }

  // 交付后迟迟不回报：响应虽写出但客户端没拿到（连接被中间层掐断等）。
  // 与「会话接管」同一语义——同 name 的新 pull 说明上一轮持有者已不在。
  // 90s 宽限避开「领到任务→上报→重启」的正常往返，只捞真正断掉的。
  const STALE_DELIVERY_MS = 90000;
  function reclaimStaleFor(name: string): void {
    const now = Date.now();
    for (const t of tasks.values()) {
      // reportedAt 已置位说明节点回报过（working/input-required），不是投递丢失
      if (t.state !== "working" || t.deliveredTo !== name || t.reportedAt) continue;
      const age = now - new Date(t.deliveredAt ?? t.updatedAt).getTime();
      if (age < STALE_DELIVERY_MS) continue;
      redeliverTask(t.id, name);
    }
  }

  /** 领任务：队列有货立即出队，否则挂起等待；返回 null 表示超时空手 */
  async function pullTask(name: string, timeoutMs: number): Promise<Task | null> {
    reclaimStaleFor(name);
    const q = pullQueues.get(name);
    if (q?.length) {
      const task = q.shift()!;
      task.state = "working";
      task.updatedAt = new Date().toISOString();
      task.deliveredAt = task.updatedAt;
      task.deliveredTo = name;
      task.deliveredInFlight = true;
      registry.setBusy(name, true, workingOnOf(task));
      log("-> task " + task.id.slice(0, 8) + " pulled by " + name);
      saveQueues();
      saveTasks();
      return task;
    }
    // 会话接管：同 name 只允许一个活跃 waiter，新 pull 抵达即踢旧（旧立即空手返回）
    // 保证任务单消费者，多会话共用身份时不会互抢
    const old = (pullWaiters.get(name) ?? []).slice();
    for (const w of old) w(null as any);
    return new Promise<Task | null>((resolve) => {
      // 等待期间连接还挂着：连接活着就算在线，5s 续一次
      const keepAlive = setInterval(() => registry.touch(name), 5000);
      keepAlive.unref?.();
      const finish = (t: Task | null) => {
        clearInterval(keepAlive);
        resolve(t);
      };
      const timer = setTimeout(() => {
        const waiters = pullWaiters.get(name) ?? [];
        const i = waiters.indexOf(wake);
        if (i >= 0) waiters.splice(i, 1);
        finish(null);
      }, timeoutMs);
      timer.unref?.();
      const wake = (task: Task | null) => {
        clearTimeout(timer);
        const waiters = pullWaiters.get(name) ?? [];
        const i = waiters.indexOf(wake);
        if (i >= 0) waiters.splice(i, 1);
        if (task) {
          task.state = "working";
          task.updatedAt = new Date().toISOString();
          task.deliveredAt = task.updatedAt;
          task.deliveredTo = name;
          task.deliveredInFlight = true;
          registry.setBusy(name, true, workingOnOf(task));
          log("-> task " + task.id.slice(0, 8) + " pushed to " + name);
          saveTasks();
        }
        finish(task);
      };
      if (!pullWaiters.has(name)) pullWaiters.set(name, []);
      pullWaiters.get(name)!.push(wake);
    });
  }

  /** 任务状态 → 工单状态映射（1A）：终态与开工都自动流转 */
  const ORDER_STATE_MAP: Record<string, string> = {
    working: "developing", completed: "done", failed: "canceled", canceled: "canceled",
    // 等人工是正当停顿：不算完成也不该假装在推进，单列一态，答完再回 developing
    "input-required": "blocked"
  };
  /** 任务 prompt 里提取工单号，回写工单状态；已终态的工单不再被拉回 */
  function syncOrderFromTask(task: Task, state: string, by: string): void {
    // orderStore 在下方才初始化，回写只发生在运行期，此处必已就绪
    if (!orderStore) return;
    const m = /\[工单 (ord-\w+)\]/.exec(task.prompt);
    if (!m) return;
    const next = ORDER_STATE_MAP[state];
    if (!next) return;
    const o = orderStore.get(m[1]);
    if (!o || o.status === "done" || o.status === "canceled") return;
    try {
      orderStore.update(m[1], { status: next as any, force: true }, by);
      log("[order] " + m[1] + " -> " + next + " (by " + by + ")");
    } catch (err: any) {
      log("[order] 回写失败 " + m[1] + ": " + String(err?.message ?? err));
    }
  }

  function isTerminal(state: string): boolean {
    return terminalStates.has(state as TaskState);
  }

  /** 清待领队列：按条件剔除任务并落盘，返回被剔除的 */
  function clearQueuesFor(predicate: (t: Task) => boolean): Task[] {
    const dropped: Task[] = [];
    for (const [name, q] of pullQueues) {
      const keep = q.filter(t => { if (predicate(t)) { dropped.push(t); return false; } return true; });
      if (keep.length !== q.length) pullQueues.set(name, keep);
    }
    if (dropped.length) saveQueues();
    return dropped;
  }

  /** 取消单个任务：置 canceled 并广播事件 */
  function cancelTask(t: Task): void {
    t.state = "canceled";
    t.updatedAt = new Date().toISOString();
    pushEvent(t.id, { kind: "status", status: { state: "canceled", timestamp: t.updatedAt } });
    saveTasks();
    syncOrderFromTask(t, "canceled", "hub-cancel");
  }

  /** 工单派发 prompt：建单与重新派发共用一份格式 */
  function orderPrompt(o: Order): string {
    const attLines = o.attachments.length
      ? "\n\n[附件] " + o.attachments.map(a => a.name + ": " + a.uri).join("\n") : "";
    return "[工单 " + o.id + "] " + o.title + "\n" + o.description + attLines +
      "\n\n[开工先 mac_report(taskId, state=\"working\", name=你的节点名)；完成后 mac_report(completed)。这是硬性流程]";
  }

  /** 建单即派发：生成任务入库并入队目标节点 */
  function dispatchOrder(o: Order, assignee: string, by: string): void {
    const now = new Date().toISOString();
    const task: Task = { id: randomUUID(), state: "submitted", prompt: orderPrompt(o), artifacts: [], createdAt: now, updatedAt: now };
    tasks.set(task.id, task);
    saveTasks();
    enqueueFor(assignee, task);
    log("-> order " + o.id + " dispatched to " + assignee + " (by " + by + ")");
  }

  /** 取消工单：回收待领 + 终止活跃任务 + 状态流转 canceled */
  function cancelOrder(id: string, by: string): { ok: boolean; canceled: string[]; error?: string } {
    const o = orderStore.get(id);
    if (!o) return { ok: false, canceled: [], error: "工单不存在: " + id };
    const marker = "[工单 " + id + "]";
    const hit = (t: Task) => t.prompt.includes(marker);
    const dropped = clearQueuesFor(t => hit(t) && !isTerminal(t.state));
    const killed: string[] = [];
    for (const t of tasks.values()) {
      if (hit(t) && !isTerminal(t.state)) { cancelTask(t); killed.push(t.id); }
    }
    if (o.status !== "done" && o.status !== "canceled") {
      orderStore.update(id, { status: "canceled", force: true,
        note: "取消：终止任务 " + killed.length + " 个，回收待领 " + dropped.length + " 个" }, by);
    }
    log("[order] canceled " + id + " (by " + by + ")：终止 " + killed.length + "，回收 " + dropped.length);
    return { ok: true, canceled: killed };
  }

  /** 重新派发工单：可换 assignee，重建任务入队 */
  function redispatchOrder(id: string, assignee: string | undefined, by: string): { ok: boolean; taskId?: string; error?: string } {
    const o = orderStore.get(id);
    if (!o) return { ok: false, error: "工单不存在: " + id };
    if (assignee && assignee !== o.assignee) orderStore.update(id, { assignee }, by);
    const fresh = orderStore.get(id)!;
    if (!fresh.assignee) return { ok: false, error: "工单未指派 assignee" };
    if (!registry.find(fresh.assignee)) return { ok: false, error: "目标不在线或未知: " + fresh.assignee };
    dispatchOrder(fresh, fresh.assignee, by);
    orderStore.update(id, { status: "developing", force: true, note: "重新派发 -> " + fresh.assignee }, by);
    return { ok: true };
  }

  /** 客户端上报结果：更新任务并推送事件；终态任务拒绝覆写（防取消后被 completed 盖回） */
  function reportResult(taskId: string, state: string, text?: string, artifacts?: { name: string; uri: string }[], by?: string): { ok: boolean; reason?: string } {
    const t = tasks.get(taskId);
    if (!t) return { ok: false, reason: "任务不存在: " + taskId };
    if (isTerminal(t.state) && t.state !== state) {
      // 终态任务收到人工确认请求：不能复活任务，但请求本身要送达控制台，不能静默丢弃
      if (state === "input-required" && by) {
        registry.setWaiting(by, text || "等待人工确认");
        pushPresence();
        log("[!!] " + by + " 对一个已终态(" + t.state + ")的任务请求人工确认: " + (text ?? "").slice(0, 120));
        return { ok: false, reason: "任务 " + taskId.slice(0, 8) + " 已终态(" + t.state + ")，不能转回 input-required；人工确认请求已作为提醒推送到控制台" };
      }
      log("[task] " + taskId.slice(0, 8) + " 已终态 " + t.state + "，拒绝上报 " + state);
      return { ok: false, reason: "任务已终态 " + t.state + "，拒绝上报 " + state };
    }
    t.reportedAt = new Date().toISOString();
    t.state = state as Task["state"];
    t.updatedAt = new Date().toISOString();
    saveTasks();
    if (text) pushEvent(taskId, { kind: "message", text });
    for (const a of artifacts ?? []) {
      t.artifacts.push(a);
      pushEvent(taskId, { kind: "artifact", artifact: a });
    }
    pushEvent(taskId, { kind: "status", status: { state: t.state, timestamp: t.updatedAt } });
    log("[task] " + taskId.slice(0, 8) + " -> " + t.state + " (by agent)");
    if (state === "input-required") {
      // 通知通路：此前只写日志，控制台无感知；现随名册下发 waitingFor
      if (by) registry.setWaiting(by, text || "等待人工确认");
      log("[!!] 任务 " + taskId.slice(0, 8) + " 等待人工确认" + (text ? ": " + text.slice(0, 120) : ""));
    } else if (by) {
      registry.setWaiting(by, undefined);
      // 该任务已终态：节点若没别的在跑任务，执行态要回到空闲
      const stillBusy = [...tasks.values()].some(x =>
        x.id !== taskId && x.state === "working" && x.deliveredTo === by && !x.reportedAt);
      if (!stillBusy) registry.setBusy(by, false);
    }
    pushPresence();
    // 归因用上报节点名：此前硬编码 mcp-report，无法追溯是哪个节点改的状态
    syncOrderFromTask(t, state, by ?? "mcp-report");
    return { ok: true };
  }

  const fileChannel = new FileChannel(options.filesDir ?? ".mac-files", "http://" + FileChannel.lanAddress() + ":" + options.port);
  const orderStore = new OrderStore(options.ordersPath
    ?? path.join(path.resolve(options.filesDir ?? ".mac-files"), "..", ".orders.json"));
  const roleStore = new RoleStore(options.rolesPath
    ?? path.join(path.resolve(options.filesDir ?? ".mac-files"), "..", ".roles.json"));
  // 角色回写：控制台改角色后同步写进该节点本地的 node.json。
  // 仅同机有效——hub 不知道远端节点安装目录，跨机器由节点自己同步。
  // node.json 是 worker.sh 的身份文件，写坏会导致节点起不来，故一律尽力而为。
  function writeRoleToNodeJson(nodeName: string, role: string): void {
    const agent = registry.find(nodeName)?.agent;
    if (!agent) {
      log("[role] " + nodeName + " 缺 agent 类型，跳过 node.json 回写");
      return;
    }
    const file = path.join(os.homedir(), ".mac-worker", agent, "node.json");
    try {
      if (!fs.existsSync(file)) {
        log("[role] " + file + " 不存在（非同机节点），跳过回写");
        return;
      }
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      if (role) raw.role = role;
      else delete raw.role;
      fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
      log("[role] 已写回 " + nodeName + " 的 node.json（role=" + (role || "（无）") + "）");
    } catch (err: any) {
      log("[role] 写 node.json 失败 " + nodeName + ": " + String(err?.message ?? err));
    }
  }

  // 领任务时给名册生成「正在做」摘要：优先工单号反查标题，普通任务截 prompt
  const workingOnOf = (task: Task): string => {
    const m = /\[工单 (ord-\w+)\]/.exec(task.prompt);
    if (m) {
      const o = orderStore.get(m[1]);
      if (o) return o.id + " " + o.title;
      return m[1];
    }
    return task.prompt.slice(0, 24) + (task.prompt.length > 24 ? "…" : "");
  };
  // 名册快照附带 hub 侧角色与排队任务数：控制台据此展示与选人
  const withRoles = (list: AgentPresence[]) =>
    list.map(p => ({
      ...p,
      role: roleStore.get(p.card.name) || undefined,
      queuedCount: pullQueues.get(p.card.name)?.length ?? 0
    }));
  // 落盘是防抖的：退出前同步 flush，防尾写丢失
  const flushStores = () => { orderStore.flushNow(); registry.flushNow(); flushQueues(); flushTasks(); };
  process.on("exit", flushStores);
  process.on("SIGINT", () => { flushStores(); process.exit(0); });
  process.on("SIGTERM", () => { flushStores(); process.exit(0); });

  if (options.selfRegister !== false) {
    registry.heartbeat(options.card);
    const selfBeat = setInterval(() => registry.heartbeat(options.card), 10000);
    selfBeat.unref?.();
  }

  function pushEvent(taskId: string, event: unknown): void {
    for (const res of sseClients.get(taskId) ?? []) {
      res.write("data: " + JSON.stringify(event) + "\n\n");
    }
  }

  function pushPresence(): void {
    const payload = "data: " + JSON.stringify({ presences: withRoles(registry.list()) }) + "\n\n";
    for (const res of presenceSubs) res.write(payload);
  }

  // 每 5s 扫任务回执：领取后 30 分钟无终态 → failed（超时未回执），防任务无声丢失
  const TASK_RECEIPT_TIMEOUT_MS = 1800000;
  const receiptTimer = setInterval(() => {
    const now = Date.now();
    for (const t of tasks.values()) {
      if (t.state !== "working") continue;
      const age = now - new Date(t.updatedAt).getTime();
      if (age > TASK_RECEIPT_TIMEOUT_MS) {
        t.state = "failed";
        t.updatedAt = new Date().toISOString();
        saveTasks();
        pushEvent(t.id, { kind: "status", status: { state: "failed", message: "超时未回执", timestamp: t.updatedAt } });
        log("[task] " + t.id.slice(0, 8) + " -> failed: 超时未回执");
      }
    }
  }, 60000);
  receiptTimer.unref?.();

  // 孤儿工单回收：owner/assignee 节点已删或长期离线，工单会永远无人接管。
  // 退回创建者（human-console）并在 timeline 留痕，避免单子静默滞留。
  const ORPHAN_AFTER_MS = 3600000;
  const orphanTimer = setInterval(() => {
    for (const o of orderStore.list({})) {
      if (o.status === "done" || o.status === "canceled") continue;
      // 在途任务还在跑就不算孤儿
      const inFlight = [...tasks.values()].some(t =>
        !isTerminal(t.state) && t.prompt.includes("[工单 " + o.id + "]"));
      if (inFlight) continue;
      const holders = [o.assignee, o.owner].filter(Boolean) as string[];
      // 已交还人类的单不再处理，否则每轮都会重复写 timeline
      if (holders.includes("human-console")) continue;
      // human-console 不在名册里，不算幽灵
      const peers = holders.filter(h => h !== "human-console");
      // 幽灵持有者：节点已从名册删除（如 dsh-worker）。这是数据一致性问题，
      // 即便还有别的在线持有者也要清掉，否则工单永远挂着一个不存在的责任人。
      const ghost = peers.some(h => !registry.find(h));
      const alive = peers.some(h => registry.find(h)?.online);
      // 有人在线且无幽灵持有者 → 正常在办，不是孤儿
      if (!ghost && alive) continue;
      // assignee 用空串才能清掉（orders.ts 走 ?? 合并，undefined 会保留原值）
      const why = holders.length
        ? "持有节点 " + holders.join("/") + " 已离线或不存在"
        : "assignee/owner 均缺失";
      try {
        orderStore.update(o.id, { owner: "human-console", assignee: "human-console", force: true,
          note: "孤儿回收：" + why + "，退回创建者待人工重派" }, "hub-orphan-sweep");
        log("[order] 孤儿回收 " + o.id + "（" + why + "）");
      } catch { /* 状态约束冲突则跳过，下轮再试 */ }
    }
  }, 60000);
  orphanTimer.unref?.();

  // 每 5s 推一次全量名册（兜底刷新，掉线判定靠 sweep）
  const presenceTimer = setInterval(() => pushPresence(), 5000);
  presenceTimer.unref?.();

  async function handleMessageSend(params: any, remote: string): Promise<unknown> {
    const prompt: string = params?.prompt ?? params?.message?.parts?.[0]?.text;
    if (typeof prompt !== "string") throw { code: -32602, message: "缺少 prompt" };
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      state: "submitted",
      prompt,
      artifacts: [],
      createdAt: now,
      updatedAt: now
    };
    tasks.set(task.id, task);

    // target 指向其他节点 → 换用远端代理执行；不带 target 或指 hub 本名 → 本机 adapter
    const target: string | undefined = params?.target;
    let adapter = options.adapter;
    if (target && target === options.card.name) {
      log("-> task " + task.id.slice(0, 8) + " local (hub) : " + prompt.slice(0, 60));
    } else if (target) {
      const presence = registry.find(target);
      if (presence?.baseUrl) {
        adapter = createRemoteProxy({ baseUrl: presence.baseUrl, targetName: target });
        log("-> task " + task.id.slice(0, 8) + " forward to " + target + ": " + prompt.slice(0, 60));
      } else if (presence) {
        // 入站客户端：入队等它长轮询来领
        enqueueFor(target, task);
        log("-> task " + task.id.slice(0, 8) + " queued for " + target + ": " + prompt.slice(0, 60));
        return { task: { id: task.id, state: "submitted", target } };
      } else {
        throw { code: -32602, message: "目标不在线或未知: " + target };
      }
    } else {
      log("<- task " + task.id.slice(0, 8) + " from " + remote + ": " + prompt.slice(0, 60));
    }
    void driveTask(task, adapter);
    return { task: { id: task.id, state: task.state, target: target ?? options.card.name } };
  }

  async function driveTask(task: Task, adapter: AgentAdapter): Promise<void> {
    try {
      for await (const ev of adapter.invoke(task)) {
        applyEvent(task, ev);
        pushEvent(task.id, ev);
        if (ev.kind === "status") log("[task] " + task.id.slice(0, 8) + " -> " + ev.status.state);
      }
    } catch (err) {
      applyEvent(task, {
        kind: "status",
        status: { state: "failed", message: String(err), timestamp: new Date().toISOString() }
      });
      pushEvent(task.id, { kind: "status", status: { state: "failed" } });
      log("[task] " + task.id.slice(0, 8) + " -> failed: " + String(err).slice(0, 80));
    }
  }

  function applyEvent(task: Task, ev: InvokeEvent): void {
    task.updatedAt = new Date().toISOString();
    if (ev.kind === "status") {
      task.state = ev.status.state;
    } else if (ev.kind === "artifact") {
      task.artifacts.push(ev.artifact);
    }
  }

  async function handleRpc(method: string, params: any, remote: string, url: URL, conn: { localAddress?: string; localPort?: number }): Promise<unknown> {
    switch (method) {
      case A2A_METHODS.MESSAGE_SEND:
        return handleMessageSend(params, remote);
      case "presence/heartbeat": {
        const card = params?.card as AgentCard;
        if (!card?.name) throw { code: -32602, message: "缺少 card.name" };
        // inbound 客户端没有可直连地址，不记 baseUrl（走长轮询领取）
        const baseUrl = params?.inbound ? null : (() => {
          const port = conn.localPort ?? 0;
          const addr = (conn.localAddress ?? "127.0.0.1").replace("::1", "127.0.0.1").replace("::ffff:", "");
          return "http://" + addr + ":" + port;
        })();
        const sourceIp = remote.replace("::ffff:", "").replace("::1", "127.0.0.1");
        const { reconnected } = registry.heartbeat(card, baseUrl, sourceIp);
        if (reconnected) log("++ " + card.name + " reconnected (" + card.url + ")");
        else log("++ " + card.name + " connected (" + card.url + ")");
        pushPresence();
        return { ok: true, intervalMs: 10000 };
      }
      case "presence/leave": {
        const ok = registry.leave(params?.name);
        if (ok) log("-- " + params.name + " left");
        pushPresence();
        return { ok };
      }
      case "presence/list":
        return { presences: withRoles(registry.list()) };
      case "mailbox/send": {
        const to = String(params?.to ?? "");
        const text = String(params?.text ?? "");
        if (!to || !text) throw { code: -32602, message: "缺少 to 或 text" };
        if (to === options.card.name) throw { code: -32602, message: to + " 是主服务本体，不收留言；给它的指令请在会话里直接说" };
        if (!registry.find(to)) throw { code: -32602, message: "目标不在线或未知: " + to };
        if (!mailboxes.has(to)) mailboxes.set(to, []);
        mailboxes.get(to)!.push({ text, from: String(params?.from ?? remote), at: new Date().toISOString() });
        log("[mail] -> " + to + ": " + text.slice(0, 2000));
        return { ok: true };
      }
      case A2A_METHODS.TASK_GET:
        return { task: tasks.get(params?.id) ?? null };
      case A2A_METHODS.TASK_CANCEL: {
        const t = tasks.get(params?.id);
        if (t && !terminalStates.has(t.state)) {
          clearQueuesFor(x => x.id === t.id);
          cancelTask(t);
          log("[task] " + t.id.slice(0, 8) + " canceled via tasks/cancel");
        }
        return { task: t ? { id: t.id, state: t.state } : null };
      }
      default:
        throw { code: -32601, message: "方法不存在: " + method };
    }
  }

  function remoteOf(req: http.IncomingMessage): string {
    return req.socket.remoteAddress ?? "unknown";
  }

  // ---------- 控制台页面：web-console SPA 构建产物 ----------
  function consoleHtml(): string {
    const tpl = path.join(path.dirname(fileURLToPath(import.meta.url)), "web", "index.html");
    return fs.readFileSync(tpl, "utf8");
  }

  // web 构建产物根（assets/logos 等静态资源）
  const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "web");

  // 官方接入脚本：节点一条命令下载，规则统一由服务端维护
  // 版本=去占位行后内容 sha256 前 8 位，注入占位后缓存；节点心跳比对自动更新
  let workerCache: { version: string; script: string } | null = null;
  function workerScript(): { version: string; script: string } {
    if (workerCache) return workerCache;
    const tpl = path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.sh");
    const raw = fs.readFileSync(tpl, "utf8");
    const version = createHash("sha256").update(raw.replace(/^WORKER_VERSION=.*$/m, "")).digest("hex").slice(0, 8);
    workerCache = { version, script: raw.replace("__VERSION__", version) };
    return workerCache;
  }

  // 接入体检脚本：目标机器自检 bash/curl/写权限/网络
  function probeScript(): string {
    const tpl = path.join(path.dirname(fileURLToPath(import.meta.url)), "probe.sh");
    return fs.readFileSync(tpl, "utf8");
  }

  // 安装提示词：与 docs/agent-onboarding.md 同源，构建时拷贝
  function installMd(): string {
    const tpl = path.join(path.dirname(fileURLToPath(import.meta.url)), "install.md");
    return fs.readFileSync(tpl, "utf8");
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const remote = remoteOf(req);

    if (req.method === "GET" && url.pathname === AGENT_CARD_PATH) {
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify(options.card));
      return;
    }
    if (req.method === "GET" && url.pathname === "/agent/pull") {
      const name = url.searchParams.get("name") ?? "";
      if (!registry.find(name)) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "未注册: " + name }));
        return;
      }
      const timeoutMs = Math.min(Number(url.searchParams.get("timeout")) || PULL_TIMEOUT_MS, 55000);
      clearMailBusyOnPull(name);
      const task = await pullTask(name, timeoutMs);
      const messages = dropMail(name);
      // 留言不走任务生命周期：送达即置执行中，否则控制台看不到「正在处理」
      if (!task) markMailBusy(name, messages);
      if (messages.length) pushPresence();
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ task, messages }));
      return;
    }
    // 节点轮询任务状态：发现 canceled 即中止本地执行
    if (req.method === "GET" && url.pathname.startsWith("/agent/task/")) {
      const id = url.pathname.slice("/agent/task/".length);
      const t = tasks.get(id);
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ state: t?.state }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/agent/result") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { taskId, state, text, artifacts, name } = JSON.parse(body);
      const r = reportResult(taskId, state ?? "completed", text, artifacts, name);
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ ok: r.ok, reason: r.reason }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/console/files") {
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ files: fileChannel.list() }));
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/console/files/open/")) {
      // hub 主机上打开资源管理器并定位文件；控制台不在 hub 本机时此按钮无效果
      const name = decodeURIComponent(url.pathname.slice("/console/files/open/".length));
      const p = fileChannel.dirOf(name);
      if (!p) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "文件不存在: " + name })); return; }
      try {
        if (process.platform === "win32") spawn("explorer", ["/select,", p], { detached: true, stdio: "ignore" }).unref();
        else if (process.platform === "darwin") spawn("open", ["-R", p], { detached: true, stdio: "ignore" }).unref();
        else spawn("xdg-open", [path.dirname(p)], { detached: true, stdio: "ignore" }).unref();
        log("[file] 资源管理器定位 " + name);
        res.writeHead(200, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: any) {
        res.writeHead(500, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ error: String(err?.message ?? err) }));
      }
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/files/")) {
      const data = fileChannel.open(decodeURIComponent(url.pathname.slice("/files/".length)));
      if (!data) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(data);
      return;
    }
    if (req.method === "PUT" && url.pathname.startsWith("/files/")) {
      const chunks: Buffer[] = [];
      let total = 0;
      let tooLarge = false;
      for await (const chunk of req) {
        total += (chunk as Buffer).length;
        // 单文件上限 200MB，防止误传大文件占满文件区（测试要传 apk）
        if (total > 200 * 1024 * 1024) { tooLarge = true; break; }
        chunks.push(chunk as Buffer);
      }
      if (tooLarge) { res.writeHead(413, { connection: "close" }); res.end(JSON.stringify({ error: "文件超过 200MB 上限" })); return; }
      const uri = fileChannel.save(decodeURIComponent(url.pathname.slice("/files/".length)) || "file.bin", Buffer.concat(chunks));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ uri }));
      log("[file] stored " + uri);
      return;
    }
    if (req.method === "GET" && url.pathname === "/console") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(consoleHtml());
      return;
    }
    // SPA 静态资源：/assets/* 与 /console/logos/*（logos 兼容旧控制台路径）
    const MIME: Record<string, string> = {
      ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
      ".png": "image/png", ".ico": "image/x-icon", ".html": "text/html; charset=utf-8",
    };
    const staticPrefixes = ["/assets/", "/console/logos/"];
    if (req.method === "GET" && staticPrefixes.some(pre => url.pathname.startsWith(pre))) {
      const rel = url.pathname.startsWith("/assets/")
        ? url.pathname.slice(1)
        : "logos/" + path.basename(url.pathname);
      const file = path.join(webRoot, rel);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
      const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": type, "cache-control": url.pathname.startsWith("/assets/") ? "max-age=604800" : "max-age=86400" });
      res.end(fs.readFileSync(file));
      return;
    }
    if (req.method === "GET" && url.pathname === "/worker.sh") {
      log("[worker] " + remoteOf(req) + " 下载 worker.sh（版本 " + workerScript().version + "）");
      res.writeHead(200, { "content-type": "text/x-shellscript; charset=utf-8" });
      res.end(workerScript().script);
      return;
    }
    // 节点自更新结果上报：成功/失败都进控制台日志，不静默
    if (req.method === "POST" && url.pathname === "/worker/update-report") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const b = JSON.parse(body || "{}");
        const name = String(b.name ?? remoteOf(req));
        const lv = b.level === "error" ? "[!!]" : "[worker]";
        log(lv + " " + name + " 自更新: " + String(b.message ?? "(无详情)"));
      } catch { log("[worker] 收到无法解析的更新上报: " + body.slice(0, 200)); }
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/probe.sh") {
      res.writeHead(200, { "content-type": "text/x-shellscript; charset=utf-8" });
      res.end(probeScript());
      return;
    }
    if (req.method === "GET" && url.pathname === "/mcp/install.md") {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      res.end(installMd());
      return;
    }
    if (req.method === "GET" && url.pathname === "/console/presence/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      res.write("data: " + JSON.stringify({ presences: withRoles(registry.list()) }) + "\n\n");
      presenceSubs.add(res);
      req.on("close", () => presenceSubs.delete(res));
      return;
    }
    if (req.method === "GET" && url.pathname === "/console/logs") {
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ logs }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/console/logs/clear") {
      logs.length = 0;
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ ok: true }));
      log("[console] 日志已清空");
      return;
    }
    if (req.method === "GET" && url.pathname === "/console/roles") {
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ roles: roleStore.all(), allowed: roleStore.allowed }));
      return;
    }
    if (req.method === "PUT" && url.pathname === "/console/roles/allowed") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { roles } = JSON.parse(body);
      const list = Array.isArray(roles) ? roles.map(String) : [];
      const saved = roleStore.setAllowed(list);
      log("[role] 允许列表 -> " + (saved.join(", ") || "（空）"));
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ ok: true, allowed: saved }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/console/roles") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { name, role } = JSON.parse(body);
      try {
        roleStore.set(String(name), String(role ?? ""));
        // 同步写回节点本地 node.json，让节点自己也知道角色（重连后仍生效）
        writeRoleToNodeJson(String(name), String(role ?? ""));
        log("[role] " + name + " -> " + (role || "（无）"));
        res.writeHead(200, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ ok: true, role: roleStore.get(String(name)) }));
      } catch (err: any) {
        res.writeHead(200, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
      }
      return;
    }
    // 工单 REST：控制台专用转发（与 mac_order_* 同一 OrderStore）
    if (req.method === "DELETE" && url.pathname.startsWith("/console/nodes/")) {
      const name = decodeURIComponent(url.pathname.slice("/console/nodes/".length));
      const ok = registry.remove(name);
      log("[node] " + (ok ? "已删除节点记录: " + name : "节点不存在: " + name));
      if (ok) pushPresence();
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ ok }));
      return;
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/console/orders/")) {
      const id = decodeURIComponent(url.pathname.slice("/console/orders/".length));
      const ok = orderStore.remove(id);
      log("[order] " + (ok ? "已删除工单: " + id : "工单不存在: " + id));
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ ok }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/console/orders") {
      const q = url.searchParams;
      const list = orderStore.list({
        status: q.get("status") ?? undefined,
        assignee: q.get("assignee") ?? undefined,
        tag: q.get("tag") ?? undefined,
        parent: q.get("parent") ?? undefined,
        priority: q.get("priority") ?? undefined
      });
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ orders: list }));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/console/orders/")) {
      const id = url.pathname.slice("/console/orders/".length);
      const o = orderStore.get(id);
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify(o ? { order: o, children: orderStore.children(id) } : { error: "工单不存在: " + id }));
      return;
    }
    // 取消工单：回收待领 + 终止活跃任务 + 状态流转
    if (req.method === "POST" && url.pathname.startsWith("/console/orders/") && url.pathname.endsWith("/cancel")) {
      const id = url.pathname.slice("/console/orders/".length, -"/cancel".length);
      const r = cancelOrder(id, "human-console");
      log("[order] cancel " + id + " -> " + (r.ok ? "ok" : r.error));
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify(r));
      return;
    }
    // 重新派发工单：可换 assignee，重建任务入队
    if (req.method === "POST" && url.pathname.startsWith("/console/orders/") && url.pathname.endsWith("/dispatch")) {
      const id = url.pathname.slice("/console/orders/".length, -"/dispatch".length);
      let body = "";
      for await (const chunk of req) body += chunk;
      let assignee: string | undefined;
      try { assignee = JSON.parse(body || "{}").assignee; } catch { /* 空体按原 assignee */ }
      const r = redispatchOrder(id, assignee ? String(assignee) : undefined, "human-console");
      log("[order] redispatch " + id + " -> " + (r.ok ? "ok" : r.error));
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify(r));
      return;
    }
    if (req.method === "POST" && url.pathname === "/console/orders") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const b = JSON.parse(body);
      try {
        const o = orderStore.create({ ...b, source: b.source ?? "human-console" }, "human-console");
        // 控制台随建单上传的附件：挂单入 timeline，派发 prompt 带上地址
        for (const a of Array.isArray(b.attachments) ? b.attachments : []) {
          if (a?.name && a?.uri) orderStore.attach(o.id, { name: String(a.name), uri: String(a.uri), by: "human-console" });
        }
        const fresh = orderStore.get(o.id) ?? o;
        log("[order] created " + o.id + " " + o.title + (o.assignee ? " -> " + o.assignee : ""));
        // 建单时指名 assignee 则自动派发通知
        if (fresh.assignee && registry.find(fresh.assignee)) {
          dispatchOrder(fresh, fresh.assignee, "human-console");
        }
        res.writeHead(200, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ order: o }));
      } catch (err: any) {
        res.writeHead(200, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ error: String(err?.message ?? err) }));
      }
      return;
    }
    if ((req.method === "POST") && url.pathname.startsWith("/console/orders/") && url.pathname.endsWith("/update")) {
      const id = url.pathname.slice("/console/orders/".length, -"/update".length);
      let body = "";
      for await (const chunk of req) body += chunk;
      const b = JSON.parse(body);
      try {
        // 附件不走 update：它不在 OrderUpdateInput 里，需单独 attach/detach。
        const { addAttachments, removeAttachments, ...patch } = b ?? {};
        orderStore.update(id, patch, "human-console");
        for (const a of Array.isArray(addAttachments) ? addAttachments : []) {
          if (a?.name && a?.uri) {
            orderStore.attach(id, { name: String(a.name), uri: String(a.uri), by: "human-console" });
          }
        }
        for (const n of Array.isArray(removeAttachments) ? removeAttachments : []) {
          orderStore.detach(id, String(n), "human-console");
        }
        const o = orderStore.get(id)!;
        log("[order] " + id + " -> " + o.status + (o.assignee ? " (" + o.assignee + ")" : ""));
        res.writeHead(200, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ order: o }));
      } catch (err: any) {
        res.writeHead(200, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ error: String(err?.message ?? err) }));
      }
      return;
    }
    if (url.pathname === "/mcp") {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("access-control-allow-headers", "content-type, mcp-session-id, mcp-protocol-version, authorization, accept");
      res.setHeader("access-control-expose-headers", "mcp-session-id");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        await mcpRoute(body, req, res, remote.replace("::ffff:", ""));
        return;
      }
      if (req.method === "GET") {
        // Streamable HTTP 的 SSE 下行流：保持连接，服务端主动消息时可用
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
        res.write(": stream open\n\n");
        const ka = setInterval(() => res.write(": ping\n\n"), 15000);
        ka.unref?.();
        req.on("close", () => clearInterval(ka));
        return;
      }
      if (req.method === "DELETE") { res.writeHead(204); res.end(); return; }
      res.writeHead(405, { allow: "GET, POST, DELETE, OPTIONS" });
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const rpc = JSON.parse(body);
      try {
        const result = await handleRpc(rpc.method, rpc.params, remote, url, {
          localAddress: req.socket.localAddress,
          localPort: req.socket.localPort
        });
        res.writeHead(200, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      } catch (err: any) {
        const e = err?.code ? err : { code: -32000, message: String(err) };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: e }));
      }
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/stream")) {
      const taskId = url.pathname.split("/")[2];
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      if (!sseClients.has(taskId)) sseClients.set(taskId, new Set());
      sseClients.get(taskId)!.add(res);
      req.on("close", () => { sseClients.get(taskId)?.delete(res); });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // MCP 门面绑线：把 server 内部能力以工具形式暴露
const mcpDeps: McpFacadeDeps = {
  checkIn: (card, sourceIp, state, workingOn) => {
    const r = registry.heartbeat(card, null, sourceIp);
    // 节点主动上报执行态：心跳不带 state 时一律不改动现有态（伴生心跳不能把执行中打回空闲）。
    // 用于「人工接管 / 会话内自行开工」这类没有任务投递的干活场景。
    if (state === "working") {
      registry.setBusy(card.name, true, workingOn && String(workingOn).trim() ? String(workingOn).trim() : "主动接管中", "agent", AGENT_BUSY_TTL_MS);
      pushPresence();
    } else if (state === "idle" && registry.busyKindOf(card.name) !== "task") {
      registry.setBusy(card.name, false);
      pushPresence();
    }
    return {
      ok: !r.conflict,
      conflictHost: r.conflict,
      intervalMs: 10000,
      workerVersion: workerScript().version,
      guideUrl: "http://" + FileChannel.lanAddress() + ":" + options.port + "/mcp/install.md"
    };
  },
  pullTask: async (name, ms) => {
    clearMailBusyOnPull(name);
    const task = await pullTask(name, ms);
    const mail = dropMail(name);
    // 与 HTTP /agent/pull 保持一致：留言送达即置执行中
    if (!task) markMailBusy(name, mail);
    if (mail.length) pushPresence();
    return { task, messages: mail };
  },
  onDeliveryFailed: (taskId, name) => redeliverTask(taskId, name),
  onDelivered: taskId => confirmDelivered(taskId),
  report: (taskId, state, text, artifacts, by) => {
    // 节点上报结果驱动执行中状态：working 置位（带上任务描述，否则会抹空工作项），其余清除
    if (by) {
      const t = tasks.get(taskId);
      registry.setBusy(by, state === "working", state === "working" && t ? workingOnOf(t) : undefined);
    }
    return reportResult(taskId, state, text, artifacts, by);
  },
  sendTask: async (prompt, target) => {
    const r = await handleRpc("message/send", { prompt, target }, "mcp", new URL("http://mcp.local"), { localAddress: "127.0.0.1", localPort: options.port }) as { task: { id: string; state: string } };
    return { taskId: r.task.id, state: r.task.state };
  },
  getTask: id => tasks.get(id) ?? { error: "任务不存在: " + id },
  listAgents: () => withRoles(registry.list()),
  touch: (name, mcp) => registry.touch(name, mcp),
  sendMail: (to, text, from) => {
    if (!registry.find(to)) return { ok: false };
    handleRpc("mailbox/send", { to, text, from }, "mcp", new URL("http://mcp.local"), { localAddress: "127.0.0.1", localPort: options.port });
    return { ok: true };
  },
  uploadFile: (name, dataBase64) => fileChannel.save(name, Buffer.from(dataBase64, "base64")),
  downloadFile: storedName => fileChannel.open(storedName)?.toString("base64"),
  orderCreate: (input, by) => orderStore.create(input, by),
  orderGet: id => {
    const o = orderStore.get(id);
    return o ? { order: o, children: orderStore.children(id) } : null;
  },
  orderUpdate: (id, patch, by) => orderStore.update(id, patch, by),
  orderList: f => orderStore.list(f),
  orderAttach: (id, name, contentBase64, by) => {
    const uri = fileChannel.save(name, Buffer.from(contentBase64, "base64"));
    orderStore.attach(id, { name, uri, by });
    return { name, uri, by };
  },
  orderCancel: (id, by) => cancelOrder(id, by),
  orderRedispatch: (id, assignee, by) => redispatchOrder(id, assignee, by),
  getGuide: () => installMd(),
  log
};
function mcpRoute(body: string, req: http.IncomingMessage, res: http.ServerResponse, sourceIp: string): Promise<void> {
  return mcpHandle(body, req, res, mcpDeps, sourceIp);
}
  // 启动时按仍在跑的任务重建节点执行态：state/workingOn 不落盘，
  // 不重建的话 hub 重启后节点会一直显示空闲或停在旧任务上（"更新一次就不更新"）
  for (const t of tasks.values()) {
    if (t.state === "working" && t.deliveredTo) {
      registry.setBusy(t.deliveredTo, true, workingOnOf(t));
    }
  }
  // 启动即回收：上次进程若在「投递已发出、确认未写回」之间被杀，任务没人拿到
  reclaimInFlight();
  return httpServer;
}

