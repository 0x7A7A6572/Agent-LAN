// A2A server：Agent Card 发现、任务状态机、SSE 状态流
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AgentAdapter, AgentCard, Task, TaskState, InvokeEvent } from "@mac/sdk";
import { AGENT_CARD_PATH, A2A_METHODS } from "@mac/sdk";

export interface ServerOptions {
  card: AgentCard;
  adapter: AgentAdapter;
  port: number;
}

const terminalStates: ReadonlySet<TaskState> = new Set(["completed", "failed", "canceled"]);

export function createServer(options: ServerOptions): http.Server {
  const tasks = new Map<string, Task>();
  const sseClients = new Map<string, Set<http.ServerResponse>>();

  function pushEvent(taskId: string, event: unknown): void {
    for (const res of sseClients.get(taskId) ?? []) {
      res.write("data: " + JSON.stringify(event) + "\n\n");
    }
  }

  async function handleMessageSend(params: any): Promise<unknown> {
    const prompt: string = params?.prompt ?? params?.message?.parts?.[0]?.text;
    if (typeof prompt !== "string") throw jsonRpcError(-32602, "缺少 prompt");
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
    // 后台推进任务，流式产出状态与产物
    void driveTask(task);
    return { task: { id: task.id, state: task.state } };
  }

  async function driveTask(task: Task): Promise<void> {
    try {
      for await (const ev of options.adapter.invoke(task)) {
        applyEvent(task, ev);
        pushEvent(task.id, ev);
      }
    } catch (err) {
      applyEvent(task, {
        kind: "status",
        status: { state: "failed", message: String(err), timestamp: new Date().toISOString() }
      });
      pushEvent(task.id, { kind: "status", status: { state: "failed" } });
    }
  }

  function applyEvent(task: Task, ev: InvokeEvent): void {
    task.updatedAt = new Date().toISOString();
    if (ev.kind === "status") {
      task.state = ev.status.state;
      if (ev.status.message) task.artifacts; // 状态消息暂只落在状态里
    } else if (ev.kind === "artifact") {
      task.artifacts.push(ev.artifact);
    }
  }

  function jsonRpcError(code: number, message: string) {
    return { code, message };
  }

  async function handleRpc(method: string, params: any): Promise<unknown> {
    switch (method) {
      case A2A_METHODS.MESSAGE_SEND:
        return handleMessageSend(params);
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
        throw jsonRpcError(-32601, "方法不存在: " + method);
    }
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === AGENT_CARD_PATH) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(options.card));
      return;
    }
    if (req.method === "POST" && url.pathname === "/") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const rpc = JSON.parse(body);
      try {
        const result = await handleRpc(rpc.method, rpc.params);
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
