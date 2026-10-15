// A2A server：Agent Card 发现、任务状态机、心跳名册、控制台
import http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentAdapter, AgentCard, Task, TaskState, InvokeEvent, AgentPresence } from "@mac/sdk";
import { AGENT_CARD_PATH, A2A_METHODS } from "@mac/sdk";
import { Registry } from "./registry.js";
export { createTui } from "./tui.js";

export interface ServerOptions {
  card: AgentCard;
  adapter: AgentAdapter;
  port: number;
  /** 本机控制台是否也注册自己（默认 true） */
  selfRegister?: boolean;
  /** 多行日志回调，控制台 TUI 直接复用 */
  onLog?: (line: string) => void;
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
    log("<- task " + task.id.slice(0, 8) + " from " + remote + ": " + prompt.slice(0, 60));
    void driveTask(task);
    return { task: { id: task.id, state: task.state } };
  }

  async function driveTask(task: Task): Promise<void> {
    try {
      for await (const ev of options.adapter.invoke(task)) {
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

  async function handleRpc(method: string, params: any, remote: string): Promise<unknown> {
    switch (method) {
      case A2A_METHODS.MESSAGE_SEND:
        return handleMessageSend(params, remote);
      case "presence/heartbeat": {
        const card = params?.card as AgentCard;
        if (!card?.name) throw { code: -32602, message: "缺少 card.name" };
        const { reconnected } = registry.heartbeat(card);
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

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const remote = remoteOf(req);

    if (req.method === "GET" && url.pathname === AGENT_CARD_PATH) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(options.card));
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
    if (req.method === "POST" && url.pathname === "/") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const rpc = JSON.parse(body);
      try {
        const result = await handleRpc(rpc.method, rpc.params, remote);
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
}
