// MCP 门面：把入站协议包装成 MCP 工具，agent 加一行配置即可入网
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AgentCard } from "@mac/sdk";

export interface McpFacadeDeps {
  /** 注册自己（心跳）；sourceIp 用于 inbound 节点自动分组 */
  checkIn: (card: AgentCard, sourceIp?: string) => { ok: boolean; intervalMs: number };
  /** 领任务，超时返回 null */
  pullTask: (name: string, timeoutMs: number) => Promise<unknown>;
  /** 上报结果 */
  report: (taskId: string, state: string, text?: string, artifacts?: { name: string; uri: string }[]) => boolean;
  /** 派任务给指定节点 */
  sendTask: (prompt: string, target?: string) => Promise<{ taskId: string; state: string }>;
  /** 查任务 */
  getTask: (taskId: string) => unknown;
  /** 列出在册节点 */
  listAgents: () => unknown;
  /** 给节点留言（人随时介入的通道） */
  sendMail: (to: string, text: string, from: string) => { ok: boolean };
  /** 活动触达：该节点还活着 */
  touch: (name: string) => boolean;
  /** 上传文件，返回局域网 URI */
  uploadFile: (name: string, dataBase64: string) => string;
  /** 读文件（base64） */
  downloadFile: (storedName: string) => string | undefined;
  log: (line: string) => void;
}

const TOOLS = [
  {
    name: "mac_check_in",
    description: "向 multi-agent-connect 主服务注册自己。40 秒内无任何活动判离线：长轮询 mac_pull_task 即算活动，无任务可领时也需每 30 秒内重调一次保活",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "节点唯一名，如 wb-machineA" },
        description: { type: "string", description: "一句话说明本节点能做什么" },
        host: { type: "string", description: "所在主机标识（机器名或 IP），同机的多个 agent 填同一个" },
        abilities: { type: "array", items: { type: "string" }, description: "能力标签列表" }
      },
      required: ["name"]
    }
  },
  {
    name: "mac_pull_task",
    description: "领取派给本节点名的任务。无任务时最多等待 waitMs 毫秒后返回空。定期调用即可持续接活，长轮询挂起期间在线状态自动保持",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "你的节点名，必须与 mac_check_in 注册的 name 一致" },
        waitMs: { type: "number", description: "无任务时最长等待毫秒数，默认 20000，最大 25000" }
      },
      required: ["name"]
    }
  },
  {
    name: "mac_report",
    description: "上报任务执行结果。任务完成或失败时必须调用",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        state: { type: "string", enum: ["completed", "failed", "working", "input-required"] },
        text: { type: "string", description: "结果文本或失败原因" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              contentBase64: { type: "string", description: "文件内容 base64" }
            },
            required: ["name", "contentBase64"]
          },
          description: "产出的文件，上传后以局域网 URI 供他人取用"
        }
      },
      required: ["taskId", "state"]
    }
  },
  {
    name: "mac_send_task",
    description: "把任务派给局域网内另一个节点执行。target 省略时由主服务本机执行",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "任务内容" },
        target: { type: "string", description: "目标节点名，用 mac_list_agents 查" }
      },
      required: ["prompt"]
    }
  },
  {
    name: "mac_get_task",
    description: "查询任务当前状态与结果",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"]
    }
  },
  {
    name: "mac_list_agents",
    description: "列出局域网内当前所有节点与在线状态",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "mac_send_message",
    description: "给局域网内另一个节点留言。对方下次领取任务时会看到。适合发指令补充、优先级调整、纠偏",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "目标节点名" },
        text: { type: "string", description: "留言内容" },
        from: { type: "string", description: "你的名字或身份" }
      },
      required: ["to", "text"]
    }
  },
  {
    name: "mac_upload_file",
    description: "上传文件到共享文件区，返回供所有节点访问的局域网地址",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        contentBase64: { type: "string" }
      },
      required: ["name", "contentBase64"]
    }
  },
  {
    name: "mac_download_file",
    description: "按文件名读取共享文件区里的文件（mac_report/mac_upload_file 返回的地址末段）",
    inputSchema: {
      type: "object",
      properties: { storedName: { type: "string" } },
      required: ["storedName"]
    }
  }
];

function toolResult(data: unknown): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
  };
}

export function attachMcpFacade(server: http.Server, deps: McpFacadeDeps): void {
  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/mcp" || req.method !== "POST") return;

    // 拦下请求自行处理：拿到 body 后调内部 mcpHandle
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      void mcpHandle(raw, req, res, deps).catch(err => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: String(err) } }));
        }
      });
    });
  });
}

export async function mcpHandle(raw: string, req: http.IncomingMessage, res: http.ServerResponse, deps: McpFacadeDeps, sourceIp?: string): Promise<void> {
  let msg: any;
  try { msg = JSON.parse(raw); } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
    return;
  }
  const id = msg.id ?? null;
  const reply = (result: unknown) => {
    if (id === null) { res.writeHead(202); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  };
  const replyError = (code: number, message: string) => {
    res.writeHead(200, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  };

  switch (msg.method) {
    case "initialize": {
      // 无状态实现：给客户端发一个会话标头，容忍它后续回传
      res.setHeader("mcp-session-id", randomUUID());
      reply({
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "multi-agent-connect", version: "0.0.1" }
      });
      return;
    }
    case "notifications/initialized":
      reply(undefined);
      return;
    case "ping":
      reply({});
      return;
    case "tools/list":
      reply({ tools: TOOLS });
      return;
    case "tools/call": {
      const name: string = msg.params?.name ?? "";
      const a = msg.params?.arguments ?? {};
      try {
        switch (name) {
          case "mac_check_in": {
            // check_in 本身就是心跳
            const card: AgentCard = {
              name: String(a.name),
              description: [a.description, ...(a.abilities ?? [])].filter(Boolean).join(" · "),
              url: "inbound",
              version: "0.0.1",
              host: a.host ? String(a.host) : undefined,
              capabilities: { streaming: false, adapters: ["mcp"] }
            };
            const r = deps.checkIn(card, sourceIp);
            deps.log("++ " + card.name + " checked in via MCP");
            reply(toolResult({ ok: r.ok, heartbeatMs: r.intervalMs, offlineAfterMs: 40000, yourName: card.name }));
            return;
          }
          case "mac_pull_task": {
            // 调用者身份：必须与 check_in 注册的节点名一致，拒绝匿名领活
            const caller = String(a.name ?? "");
            if (!caller || !deps.touch(caller)) {
              replyError(-32001, "未知节点: " + (caller || "缺少 name") + "，请先 mac_check_in 注册");
              return;
            }
            const waitMs = Math.min(Number(a.waitMs) || 20000, 25000);
            const r = await deps.pullTask(caller, waitMs) as { task: unknown; messages?: unknown[] };
            reply(toolResult({ task: r?.task ?? null, messages: r?.messages ?? [] }));
            return;
          }
          case "mac_report": {
            const files = (a.files ?? []).map((f: { name: string; contentBase64: string }) => ({
              name: f.name,
              uri: deps.uploadFile(f.name, f.contentBase64)
            }));
            const ok = deps.report(String(a.taskId), String(a.state), a.text, files.length ? files : undefined);
            reply(toolResult({ ok, files: files.map((f: { uri: string }) => f.uri) }));
            return;
          }
          case "mac_send_task": {
            const r = await deps.sendTask(String(a.prompt), a.target ? String(a.target) : undefined);
            reply(toolResult(r));
            return;
          }
          case "mac_get_task": {
            reply(toolResult(deps.getTask(String(a.taskId))));
            return;
          }
          case "mac_list_agents": {
            reply(toolResult(deps.listAgents()));
            return;
          }
          case "mac_send_message": {
            const ok = deps.sendMail(String(a.to), String(a.text), String(a.from ?? "anonymous"));
            reply(toolResult({ ok }));
            return;
          }
          case "mac_upload_file": {
            const uri = deps.uploadFile(String(a.name), String(a.contentBase64));
            reply(toolResult({ uri }));
            return;
          }
          case "mac_download_file": {
            const data = deps.downloadFile(String(a.storedName));
            reply(toolResult(data !== undefined
              ? { contentBase64: data }
              : { error: "文件不存在: " + a.storedName }));
            return;
          }
          default:
            replyError(-32602, "未知工具: " + name);
        }
      } catch (err: any) {
        replyError(-32000, String(err?.message ?? err));
      }
      return;
    }
    default:
      replyError(-32601, "方法不存在: " + msg.method);
  }
}
