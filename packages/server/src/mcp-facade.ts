// MCP 门面：把入站协议包装成 MCP 工具，agent 加一行配置即可入网
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AgentCard } from "@mac/sdk";
import type { Order, OrderCreateInput, OrderUpdateInput, FileRef } from "./types.js";
import type { OrderStore } from "./orders.js";

export interface McpFacadeDeps {
  /** 注册自己（心跳）；sourceIp 用于 inbound 节点自动分组 */
  checkIn: (card: AgentCard, sourceIp?: string) => { ok: boolean; conflictHost?: string; intervalMs: number; workerVersion?: string; guideUrl?: string };
  /** 领任务，超时返回 null */
  pullTask: (name: string, timeoutMs: number) => Promise<unknown>;
  /** 上报结果；by 为上报节点名，驱动执行中状态 */
  report: (taskId: string, state: string, text?: string, artifacts?: { name: string; uri: string }[], by?: string) => boolean;
  /** 派任务给指定节点 */
  sendTask: (prompt: string, target?: string) => Promise<{ taskId: string; state: string }>;
  /** 查任务 */
  getTask: (taskId: string) => unknown;
  /** 列出在册节点 */
  listAgents: () => unknown;
  /** 给节点留言（人随时介入的通道） */
  sendMail: (to: string, text: string, from: string) => { ok: boolean };
  /** 活动触达：该节点还活着 */
  touch: (name: string, mcp?: boolean) => boolean;
  /** 上传文件，返回局域网 URI */
  uploadFile: (name: string, dataBase64: string) => string;
  /** 读文件（base64） */
  downloadFile: (storedName: string) => string | undefined;
  /** 建工单 */
  orderCreate: (input: OrderCreateInput, by: string) => Order;
  /** 查工单（含子单） */
  orderGet: (id: string) => { order: Order; children: { id: string; title: string; status: string }[] } | null;
  /** 改工单（状态/依赖约束由存储层校验） */
  orderUpdate: (id: string, patch: OrderUpdateInput, by: string) => Order;
  /** 看板过滤 */
  orderList: (filter: Parameters<OrderStore["list"]>[0]) => Order[];
  /** 给工单挂产物文件 */
  orderAttach: (id: string, name: string, contentBase64: string, by: string) => FileRef;
  /** 节点规范全文（agent-onboarding 同源） */
  getGuide: () => string;
  log: (line: string, level?: "info" | "debug") => void;
}

const TOOLS = [
  {
    name: "mac_check_in",
    description: "向 Agent-LAN 主服务注册自己。40 秒内无任何活动判离线：长轮询 mac_pull_task 即算活动，无任务可领时也需每 30 秒内重调一次保活。注册应答里的 guideUrl 是完整节点规范，新会话需要读一次；核心义务：开工/完成必须 mac_report 且带 name，工单改指派必须紧跟 mac_send_task 通知新节点",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "节点唯一名，如 wb-machineA" },
        agent: { type: "string", description: "agent 程序类型（与安装目录名一致，如 dsh/workbuddy）；同机同类型共用" },
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
    description: "上报任务执行结果。必须带 name（不带则完成状态不写回工单、控制台不刷新）。工单任务开工时先报 state=working，完成报 completed，失败报 failed——不报等于白干",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        name: { type: "string", description: "你的节点名（与 mac_check_in 一致），用于即时刷新执行中状态" },
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
  },
  {
    name: "mac_order_create",
    description: "建工单。可建母单，也可 parent 指向母单建子单；blockedBy 表达依赖，全 done 后才能离开 backlog。by 传你的节点名（timeline 归因）",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "做什么，一句话" },
        description: { type: "string", description: "验收标准与依赖产物 URI" },
        priority: { type: "string", enum: ["urgent", "high", "normal", "low"] },
        tags: { type: "array", items: { type: "string" } },
        assignee: { type: "string" },
        owner: { type: "string" },
        startDate: { type: "string" },
        dueDate: { type: "string" },
        parent: { type: "string", description: "母单 id" },
        blockedBy: { type: "array", items: { type: "string" }, description: "依赖的工单 id 列表" }
      },
      required: ["title"]
    }
  },
  {
    name: "mac_order_get",
    description: "查工单全量：字段、timeline 流转记录、attachments 产物、children 子单列表",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"]
    }
  },
  {
    name: "mac_order_update",
    description: "改工单：状态推进、改处理人、改依赖等。每次变更记入 timeline。离开 backlog 时依赖必须全 done。改 assignee 后必须紧跟 mac_send_task 通知目标节点，否则对方永远收不到活",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string" },
        priority: { type: "string", enum: ["urgent", "high", "normal", "low"] },
        tags: { type: "array", items: { type: "string" } },
        assignee: { type: "string" },
        owner: { type: "string" },
        startDate: { type: "string" },
        dueDate: { type: "string" },
        description: { type: "string" },
        blockedBy: { type: "array", items: { type: "string" } },
        force: { type: "boolean", description: "绕过依赖等待，环检测仍生效" },
        note: { type: "string", description: "变更说明，写入流转记录" }
      },
      required: ["id"]
    }
  },
  {
    name: "mac_order_list",
    description: "看板：列出工单，按 status / assignee / tag / parent / priority 过滤，按优先级排序",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        assignee: { type: "string" },
        tag: { type: "string" },
        parent: { type: "string" },
        priority: { type: "string" }
      }
    }
  },
  {
    name: "mac_get_guide",
    description: "获取节点完整行为规范（接入、心跳、上报、工单流转义务、文件通道）。新会话/不确定流程时调用一次",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "mac_order_attach",
    description: "给工单挂产物文件：内容 base64 上传到共享文件区，返回局域网 URI 并记入工单",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        contentBase64: { type: "string" }
      },
      required: ["id", "name", "contentBase64"]
    }
  }
];

// spec：参数错回 -32602，其余内部错误 -32000
const PARAM_ERROR_MARKS = ["缺少", "不存在", "非法", "成环", "不能依赖", "依赖未完成"];
function orderErrorCode(msg: string): number {
  return PARAM_ERROR_MARKS.some(m => msg.includes(m)) ? -32602 : -32000;
}

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
        serverInfo: { name: "Agent-LAN", version: "0.0.1" }
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
            } as AgentCard & { agent?: string };
            if (a.agent) (card as any).agent = String(a.agent);
            const r = deps.checkIn(card, sourceIp);
            if (r.conflictHost) {
              deps.log("[!] 节点名冲突: " + card.name + " 已注册于主机 " + r.conflictHost);
              replyError(-32002, "节点名 " + card.name + " 已被主机 " + r.conflictHost +
                " 的节点占用，请换一个 name 重新注册（同机多实例时 NAME 必须各不相同）");
              return;
            }
            deps.log("++ " + card.name + " checked in via MCP", "debug");
            reply(toolResult({ ok: r.ok, heartbeatMs: r.intervalMs, offlineAfterMs: 40000, yourName: card.name, workerVersion: r.workerVersion, guideUrl: r.guideUrl }));
            return;
          }
          case "mac_pull_task": {
            // 调用者身份：必须与 check_in 注册的节点名一致，拒绝匿名领活
            const caller = String(a.name ?? "");
            if (!caller || !deps.touch(caller, true)) {
              replyError(-32001, "未知节点: " + (caller || "缺少 name") + "，请先 mac_check_in 注册");
              return;
            }
            const waitMs = Math.min(Number(a.waitMs) || 20000, 25000);
            const r = await deps.pullTask(caller, waitMs) as { task: unknown; messages?: unknown[] };
            reply(toolResult({ task: r?.task ?? null, messages: r?.messages ?? [] }));
            return;
          }
          case "mac_report": {
            // name 可选：带上才能即时刷新执行中状态（与 pull 的 name 一致）
            if (a.name) deps.touch(String(a.name), true);
            const files = (a.files ?? []).map((f: { name: string; contentBase64: string }) => ({
              name: f.name,
              uri: deps.uploadFile(f.name, f.contentBase64)
            }));
            const ok = deps.report(String(a.taskId), String(a.state), a.text, files.length ? files : undefined, a.name ? String(a.name) : undefined);
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
          case "mac_get_guide": {
            reply(toolResult({ guide: deps.getGuide() }));
            return;
          }
          case "mac_order_create": {
            try {
              const o = deps.orderCreate({
                title: a.title == null ? "" : String(a.title), description: a.description ? String(a.description) : undefined,
                priority: a.priority as any, tags: a.tags, assignee: a.assignee ? String(a.assignee) : undefined,
                owner: a.owner ? String(a.owner) : undefined, startDate: a.startDate, dueDate: a.dueDate,
                parent: a.parent ? String(a.parent) : undefined,
                blockedBy: Array.isArray(a.blockedBy) ? a.blockedBy.map(String) : undefined,
                source: "mcp"
              }, String(a.by ?? "mcp"));
              reply(toolResult(o));
            } catch (err: any) {
              replyError(orderErrorCode(String(err?.message ?? err)), String(err?.message ?? err));
            }
            return;
          }
          case "mac_order_get": {
            const r = deps.orderGet(String(a.id));
            reply(toolResult(r ?? { error: "工单不存在: " + a.id }));
            return;
          }
          case "mac_order_update": {
            try {
              const o = deps.orderUpdate(String(a.id), {
                status: a.status ? String(a.status) : undefined,
                priority: a.priority as any, tags: a.tags,
                assignee: a.assignee ? String(a.assignee) : undefined,
                owner: a.owner ? String(a.owner) : undefined,
                startDate: a.startDate, dueDate: a.dueDate,
                description: a.description ? String(a.description) : undefined,
                blockedBy: Array.isArray(a.blockedBy) ? a.blockedBy.map(String) : undefined,
                force: Boolean(a.force),
                note: a.note ? String(a.note) : undefined
              }, String(a.by ?? "mcp"));
              reply(toolResult(o));
            } catch (err: any) {
              replyError(orderErrorCode(String(err?.message ?? err)), String(err?.message ?? err));
            }
            return;
          }
          case "mac_order_list": {
            reply(toolResult(deps.orderList({
              status: a.status ? String(a.status) : undefined,
              assignee: a.assignee ? String(a.assignee) : undefined,
              tag: a.tag ? String(a.tag) : undefined,
              parent: a.parent ? String(a.parent) : undefined,
              priority: a.priority ? String(a.priority) : undefined
            })));
            return;
          }
          case "mac_order_attach": {
            try {
              const ref = deps.orderAttach(String(a.id), String(a.name), String(a.contentBase64), String(a.by ?? "mcp"));
              reply(toolResult(ref));
            } catch (err: any) {
              replyError(orderErrorCode(String(err?.message ?? err)), String(err?.message ?? err));
            }
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
