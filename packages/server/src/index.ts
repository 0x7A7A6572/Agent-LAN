// A2A server：Agent Card 发现、任务状态机、心跳名册、控制台
import http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentAdapter, AgentCard, Task, TaskState, InvokeEvent, AgentPresence } from "@mac/sdk";
import { AGENT_CARD_PATH, A2A_METHODS } from "@mac/sdk";
import { Registry } from "./registry.js";
import { createRemoteProxy } from "./remote-proxy.js";
import { FileChannel } from "./file-channel.js";
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
}

const terminalStates: ReadonlySet<TaskState> = new Set(["completed", "failed", "canceled"]);

export function createServer(options: ServerOptions): http.Server {
  const tasks = new Map<string, Task>();
  const registry = new Registry();
  const sseClients = new Map<string, Set<http.ServerResponse>>();
  const presenceSubs = new Set<http.ServerResponse>();
  const logs: string[] = [];
  const log = (line: string) => {
    const stamped = new Date().toLocaleTimeString("zh-CN", { hour12: false }) + " " + line;
    logs.push(stamped);
    if (logs.length > 200) logs.shift();
    options.onLog?.(stamped);
  };

  // 入站客户端（workbuddy/dsh 等）长轮询领取的任务队列
  const pullWaiters: Map<string, ((task: Task) => void)[]> = new Map();
  const PULL_TIMEOUT_MS = 25000;

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
    }
  }
  const pullQueues: Map<string, Task[]> = new Map();
  // 节点信箱：人随时插话，对方 pull 时随任务一并带走
  const mailboxes: Map<string, { text: string; from: string; at: string }[]> = new Map();

  function dropMail(name: string): { text: string; from: string; at: string }[] {
    const mail = mailboxes.get(name);
    mailboxes.delete(name);
    return mail ?? [];
  }

  /** 领任务：队列有货立即出队，否则挂起等待；返回 null 表示超时空手 */
  async function pullTask(name: string, timeoutMs: number): Promise<Task | null> {
    const q = pullQueues.get(name);
    if (q?.length) {
      const task = q.shift()!;
      log("-> task " + task.id.slice(0, 8) + " pulled by " + name);
      return task;
    }
    return new Promise<Task | null>((resolve) => {
      const timer = setTimeout(() => {
        const waiters = pullWaiters.get(name) ?? [];
        const i = waiters.indexOf(wake);
        if (i >= 0) waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      const wake = (task: Task) => {
        clearTimeout(timer);
        log("-> task " + task.id.slice(0, 8) + " pushed to " + name);
        resolve(task);
      };
      if (!pullWaiters.has(name)) pullWaiters.set(name, []);
      pullWaiters.get(name)!.push(wake);
    });
  }

  /** 客户端上报结果：更新任务并推送事件 */
  function reportResult(taskId: string, state: string, text?: string, artifacts?: { name: string; uri: string }[]): boolean {
    const t = tasks.get(taskId);
    if (!t) return false;
    t.state = state as Task["state"];
    t.updatedAt = new Date().toISOString();
    if (text) pushEvent(taskId, { kind: "message", text });
    for (const a of artifacts ?? []) {
      t.artifacts.push(a);
      pushEvent(taskId, { kind: "artifact", artifact: a });
    }
    pushEvent(taskId, { kind: "status", status: { state: t.state, timestamp: t.updatedAt } });
    log("[task] " + taskId.slice(0, 8) + " -> " + t.state + " (by agent)");
    return true;
  }

  const fileChannel = new FileChannel(options.filesDir ?? ".mac-files", "http://" + FileChannel.lanAddress() + ":" + options.port);

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
    const payload = "data: " + JSON.stringify({ presences: registry.list() }) + "\n\n";
    for (const res of presenceSubs) res.write(payload);
  }

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

    // target 指向其他节点 → 换用远端代理执行；不带 target → 本机 adapter
    const target: string | undefined = params?.target;
    let adapter = options.adapter;
    if (target && target !== options.card.name) {
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
        const { reconnected } = registry.heartbeat(card, baseUrl);
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
        return { presences: registry.list() };
      case "mailbox/send": {
        const to = String(params?.to ?? "");
        const text = String(params?.text ?? "");
        if (!to || !text) throw { code: -32602, message: "缺少 to 或 text" };
        if (!registry.find(to)) throw { code: -32602, message: "目标不在线或未知: " + to };
        if (!mailboxes.has(to)) mailboxes.set(to, []);
        mailboxes.get(to)!.push({ text, from: String(params?.from ?? remote), at: new Date().toISOString() });
        log("[mail] -> " + to + ": " + text.slice(0, 50));
        return { ok: true };
      }
      case A2A_METHODS.TASK_GET:
        return { task: tasks.get(params?.id) ?? null };
      case A2A_METHODS.TASK_CANCEL: {
        const t = tasks.get(params?.id);
        if (t && !terminalStates.has(t.state)) {
          t.state = "canceled";
          t.updatedAt = new Date().toISOString();
          pushEvent(t.id, { kind: "status", status: { state: "canceled" } });
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

  // ---------- 控制台页面：实时名册 + 日志 ----------
  function consoleHtml(): string {
    const tpl = path.join(path.dirname(fileURLToPath(import.meta.url)), "console.html");
    return fs.readFileSync(tpl, "utf8");
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const remote = remoteOf(req);

    if (req.method === "GET" && url.pathname === AGENT_CARD_PATH) {
      res.writeHead(200, { "content-type": "application/json" });
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
      const task = await pullTask(name, timeoutMs);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ task, messages: dropMail(name) }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/agent/result") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { taskId, state, text, artifacts } = JSON.parse(body);
      const ok = reportResult(taskId, state ?? "completed", text, artifacts);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok }));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/files/")) {
      const data = fileChannel.open(url.pathname.slice("/files/".length));
      if (!data) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(data);
      return;
    }
    if (req.method === "PUT" && url.pathname.startsWith("/files/")) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const uri = fileChannel.save(url.pathname.slice("/files/".length) || "file.bin", Buffer.concat(chunks));
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
    if (req.method === "GET" && url.pathname === "/console/presence/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      res.write("data: " + JSON.stringify({ presences: registry.list() }) + "\n\n");
      presenceSubs.add(res);
      req.on("close", () => presenceSubs.delete(res));
      return;
    }
    if (req.method === "GET" && url.pathname === "/console/logs") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ logs }));
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
        await mcpRoute(body, req, res);
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
        res.writeHead(200, { "content-type": "application/json" });
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
  checkIn: card => {
    registry.heartbeat(card, null);
    return { ok: true, intervalMs: 10000 };
  },
  pullTask: async (name, ms) => {
    const task = await pullTask(name, ms);
    const mail = dropMail(name);
    return { task, messages: mail };
  },
  report: (taskId, state, text, artifacts) => reportResult(taskId, state, text, artifacts),
  sendTask: async (prompt, target) => {
    const r = await handleRpc("message/send", { prompt, target }, "mcp", new URL("http://mcp.local"), { localAddress: "127.0.0.1", localPort: options.port }) as { task: { id: string; state: string } };
    return { taskId: r.task.id, state: r.task.state };
  },
  getTask: id => tasks.get(id) ?? { error: "任务不存在: " + id },
  listAgents: () => registry.list(),
  sendMail: (to, text, from) => {
    if (!registry.find(to)) return { ok: false };
    handleRpc("mailbox/send", { to, text, from }, "mcp", new URL("http://mcp.local"), { localAddress: "127.0.0.1", localPort: options.port });
    return { ok: true };
  },
  uploadFile: (name, dataBase64) => fileChannel.save(name, Buffer.from(dataBase64, "base64")),
  downloadFile: storedName => fileChannel.open(storedName)?.toString("base64"),
  log
};
function mcpRoute(body: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  return mcpHandle(body, req, res, mcpDeps);
}
  return httpServer;
}

