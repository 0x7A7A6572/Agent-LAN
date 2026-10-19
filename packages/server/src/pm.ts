// PM 决策调度器：把一批事件交给 LLM，产出结构化动作
// 关键约束：LLM 只做判断，合法性一律由 hub 侧校验，不信任模型输出

import fs from "node:fs";
import path from "node:path";
import type { HubEvent } from "./events.js";

export interface PmConfig {
  enabled: boolean;
  /** 模型来源：openai 任意兼容端点 / workbuddy 直连本机桌面版 */
  provider: "openai" | "workbuddy";
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  debounceMs: number;
  tickMs: number;
  maxActionsPerDecision: number;
  tokenBudget: number;
  timeoutMs: number;
}

export const PM_CONFIG_DEFAULTS: PmConfig = {
  enabled: false,
  provider: "openai",
  baseUrl: "http://127.0.0.1:11434/v1",
  apiKey: "",
  model: "qwen2.5:14b",
  temperature: 0.2,
  debounceMs: 3000,
  tickMs: 300000,
  maxActionsPerDecision: 10,
  tokenBudget: 6000,
  timeoutMs: 60000
};

export type PmAction =
  | { kind: "noop"; reason?: string }
  | { kind: "create_orders"; orders: { title: string; description?: string; parent?: string; priority?: string; blockedBy?: string[] }[] }
  | { kind: "assign"; orderId: string; assignee: string; note?: string }
  | { kind: "update_status"; orderId: string; status: string; note?: string }
  | { kind: "send_message"; to: string; text: string };

export interface PmDecision {
  at: number;
  eventCount: number;
  reasoning: string;
  actions: PmAction[];
  applied: number;
  rejected: { action: unknown; reason: string }[];
  error?: string;
  durationMs: number;
}

export interface NodeStat {
  dispatched: number;
  completed: number;
  failed: number;
  reworked: number;
  lastActive?: number;
}

export interface PmMemory {
  decisions: PmDecision[];
  nodes: Record<string, NodeStat>;
  orders: Record<string, { reworks: number; createdAt: number; closedAt?: number }>;
}

const MAX_DECISIONS = 200;

export function loadConfig(file: string): PmConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PmConfig>;
    return sanitizeConfig({ ...PM_CONFIG_DEFAULTS, ...raw });
  } catch {
    return { ...PM_CONFIG_DEFAULTS };
  }
}

/** 配置落盘前收敛：非法值回退默认，避免热改配置把 hub 打挂 */
export function sanitizeConfig(c: PmConfig): PmConfig {
  const num = (v: unknown, d: number, min: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? n : d;
  };
  return {
    enabled: !!c.enabled,
    provider: c.provider === "workbuddy" ? "workbuddy" : "openai",
    baseUrl: typeof c.baseUrl === "string" && c.baseUrl.trim() ? c.baseUrl.trim().replace(/\/+$/, "") : PM_CONFIG_DEFAULTS.baseUrl,
    apiKey: typeof c.apiKey === "string" ? c.apiKey : "",
    model: typeof c.model === "string" && c.model.trim() ? c.model.trim() : PM_CONFIG_DEFAULTS.model,
    temperature: Math.min(2, Math.max(0, num(c.temperature, PM_CONFIG_DEFAULTS.temperature, 0))),
    debounceMs: num(c.debounceMs, PM_CONFIG_DEFAULTS.debounceMs, 500),
    tickMs: num(c.tickMs, PM_CONFIG_DEFAULTS.tickMs, 30000),
    maxActionsPerDecision: num(c.maxActionsPerDecision, PM_CONFIG_DEFAULTS.maxActionsPerDecision, 1),
    tokenBudget: num(c.tokenBudget, PM_CONFIG_DEFAULTS.tokenBudget, 500),
    timeoutMs: num(c.timeoutMs, PM_CONFIG_DEFAULTS.timeoutMs, 5000)
  };
}

export function saveConfig(file: string, c: PmConfig): PmConfig {
  const clean = sanitizeConfig(c);
  fs.writeFileSync(file, JSON.stringify(clean, null, 2) + "\n");
  return clean;
}

export function loadMemory(file: string): PmMemory {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PmMemory>;
    return {
      decisions: Array.isArray(raw.decisions) ? raw.decisions.slice(-MAX_DECISIONS) : [],
      nodes: raw.nodes ?? {},
      orders: raw.orders ?? {}
    };
  } catch {
    return { decisions: [], nodes: {}, orders: {} };
  }
}

export function saveMemory(file: string, m: PmMemory): void {
  m.decisions = m.decisions.slice(-MAX_DECISIONS);
  fs.writeFileSync(file, JSON.stringify(m, null, 2) + "\n");
}

/** 铁律：写进 prompt 让模型知道边界，同时也是门禁校验的依据 */
export const PM_IRON_RULES = [
  "不能把任务派给自己",
  "目标节点必须在线且当前空闲或负载较低",
  "依赖未完成的工单不能离开 backlog",
  "工单状态只能向前推进，不能回退到已完成的更早阶段",
  "变更 assignee 必须在 note 中说明原因",
  "单次决策最多产出 " + PM_CONFIG_DEFAULTS.maxActionsPerDecision + " 个动作",
  "同一工单 10 分钟内不被修改超过 3 次",
  "没有需要做的事时返回 noop，不要为了显得忙碌而动作"
].join("\n- ");

export interface PromptInput {
  events: HubEvent[];
  orders: unknown[];
  nodes: unknown[];
  memory: PmMemory;
  policy: string;
}

/** 组装决策输入；超预算时按优先级裁剪订单快照 */
export function buildPrompt(input: PromptInput, budget: number): { system: string; user: string } {
  const system = [
    "你是 Agent-LAN 的 Supervisor（PM）。你只负责调度判断，不亲自实现任何需求。",
    "",
    "职责：接收事件，判断下一步该做什么，产出动作数组。",
    "你不决定细节实现，只决定「谁来做哪张单」和「工单推进到什么状态」。",
    "",
    "铁律（违反会被系统驳回）：",
    "- " + PM_IRON_RULES,
    "",
    "输出要求：严格返回一个 JSON 对象，不要 markdown 代码块，不要额外解释。",
    '格式：{"reasoning":"一句话判断依据","actions":[...]}',
    "",
    "可用动作：",
    '- {"kind":"create_orders","orders":[{"title":"...","description":"...","parent":"ord-xxx","priority":"high","blockedBy":[]}]}',
    '- {"kind":"assign","orderId":"ord-xxx","assignee":"节点名","note":"为什么派给他"}',
    '- {"kind":"update_status","orderId":"ord-xxx","status":"review","note":"..."}',
    '- {"kind":"send_message","to":"节点名","text":"..."}',
    '- {"kind":"noop"}'
  ].join("\n");

  const parts: string[] = [];
  if (input.policy) parts.push("## 当前策略\n" + input.policy);

  const evLines = input.events.map(e => "- [" + e.kind + "] " + JSON.stringify(e.data));
  parts.push("## 本次触发事件（" + input.events.length + " 条）\n" + evLines.join("\n"));

  const orderLines = (input.orders as any[]).map(o =>
    "- " + o.id + " [" + o.status + "] " + o.title +
    " | assignee=" + (o.assignee ?? "未指派") +
    (o.parent ? " | parent=" + o.parent : "") +
    (o.blockedBy?.length ? " | blockedBy=" + o.blockedBy.join(",") : "")
  );
  parts.push("## 未完成工单（" + orderLines.length + " 张）\n" + (orderLines.join("\n") || "（无）"));

  const nodeLines = (input.nodes as any[]).map(n =>
    "- " + n.name + (n.role ? "[" + n.role + "]" : "") +
    " | " + (n.online ? "在线" : "离线") +
    (n.state === "working" ? " 执行中(" + (n.workingOn ?? "") + ")" : " 空闲") +
    (n.queuedCount ? " | 排队 " + n.queuedCount : "") +
    (n.description ? " | " + n.description : "")
  );
  parts.push("## 节点（" + nodeLines.length + " 个）\n" + (nodeLines.join("\n") || "（无）"));

  const recent = input.memory.decisions.slice(-10).map(d =>
    "- " + new Date(d.at).toISOString().slice(11, 16) + " " + (d.reasoning || "(无推理)") +
    " -> " + d.actions.map(a => a.kind).join(",") + " (执行 " + d.applied + "/" + d.actions.length + ")"
  );
  parts.push("## 最近决策\n" + (recent.join("\n") || "（无）"));

  const stats = Object.entries(input.memory.nodes)
    .filter(([, s]) => s.dispatched > 0)
    .map(([name, s]) => "- " + name + "：派 " + s.dispatched + " 完成 " + s.completed +
      " 失败 " + s.failed + " 返工 " + s.reworked +
      " 成功率 " + (s.dispatched ? Math.round((s.completed / s.dispatched) * 100) : 0) + "%");
  if (stats.length) parts.push("## 节点历史表现\n" + stats.join("\n"));

  let user = parts.join("\n\n");
  // 粗估 token：中文约 1 字 1 token，英文 4 字符 1 token。超预算优先砍订单/节点/记忆
  const estimate = (s: string) => Math.ceil(s.length / 2);
  while (estimate(user) > budget && parts.length > 3) {
    parts.splice(parts.length - 1, 1);
    user = parts.join("\n\n");
  }
  return { system, user };
}

export interface PmClientResult {
  decision: PmDecision;
  ok: boolean;
}

/** 解析模型输出：容忍 markdown 包裹与前后杂字，失败则整批作废 */
export function parseDecision(text: string, maxActions: number, durationMs: number): { actions: PmAction[]; reasoning: string } | { error: string } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { error: "返回内容里没有 JSON 对象" };
  let obj: any;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch (err: any) {
    return { error: "JSON 解析失败: " + String(err?.message ?? err) };
  }
  if (!Array.isArray(obj.actions)) return { error: "缺少 actions 数组" };
  if (obj.actions.length > maxActions) return { error: "动作数 " + obj.actions.length + " 超过上限 " + maxActions };
  const actions: PmAction[] = [];
  for (const a of obj.actions) {
    if (!a || typeof a.kind !== "string") return { error: "动作缺少 kind" };
    switch (a.kind) {
      case "noop":
        actions.push({ kind: "noop" });
        break;
      case "create_orders":
        if (!Array.isArray(a.orders) || !a.orders.length) return { error: "create_orders 缺少 orders" };
        if (!a.orders.every((o: any) => o && typeof o.title === "string")) return { error: "子单缺少 title" };
        actions.push({ kind: "create_orders", orders: a.orders });
        break;
      case "assign":
        if (!a.orderId || !a.assignee) return { error: "assign 缺少 orderId/assignee" };
        actions.push({ kind: "assign", orderId: String(a.orderId), assignee: String(a.assignee), note: a.note ? String(a.note) : undefined });
        break;
      case "update_status":
        if (!a.orderId || !a.status) return { error: "update_status 缺少 orderId/status" };
        actions.push({ kind: "update_status", orderId: String(a.orderId), status: String(a.status), note: a.note ? String(a.note) : undefined });
        break;
      case "send_message":
        if (!a.to || !a.text) return { error: "send_message 缺少 to/text" };
        actions.push({ kind: "send_message", to: String(a.to), text: String(a.text) });
        break;
      default:
        return { error: "未知动作: " + String(a.kind) };
    }
  }
  return { actions, reasoning: typeof obj.reasoning === "string" ? obj.reasoning : "" };
}

/**
 * 调 OpenAI 兼容端点；超时/网络错误一律返回 error，不重试。
 * @param sse 端点只回流式响应时置 true（本地 WorkBuddy shim 即如此），由调用方拼回完整文本
 */
export async function callPm(
  cfg: PmConfig,
  system: string,
  user: string,
  sse = false
): Promise<{ text: string } | { error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (cfg.apiKey) headers.authorization = "Bearer " + cfg.apiKey;
    const res = await fetch(cfg.baseUrl + "/chat/completions", {
      method: "POST",
      headers,
      signal: ctrl.signal,
      body: JSON.stringify({
        model: cfg.model,
        temperature: cfg.temperature,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      return { error: "HTTP " + res.status + ": " + detail };
    }
    if (sse) {
      const { readSseCompletion } = await import("./workbuddy-provider.js");
      const text = await readSseCompletion(res, cfg.timeoutMs);
      if (typeof text !== "string") return text;
      if (!text.trim()) return { error: "响应里没有 content" };
      return { text };
    }
    const data = await res.json() as any;
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) return { error: "响应里没有 content" };
    return { text };
  } catch (err: any) {
    if (err?.name === "AbortError") return { error: "LLM 超时（" + cfg.timeoutMs + "ms）" };
    return { error: "调用失败: " + String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

/** 配置/记忆文件路径：与工单同目录，env 可覆盖 */
export function pmPaths(dataDir: string): { config: string; memory: string; policy: string } {
  return {
    config: process.env.MAC_PM_CONFIG ?? path.join(dataDir, ".pm-config.json"),
    memory: process.env.MAC_PM_MEMORY ?? path.join(dataDir, ".pm-memory.json"),
    policy: process.env.MAC_PM_POLICY ?? path.join(dataDir, ".pm-policy.md")
  };
}
