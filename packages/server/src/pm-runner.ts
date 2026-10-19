// PM 决策闭环：把事件批次变成经过门禁校验的动作，再交给 hub 执行
// 关键约束：LLM 的输出一律不可信，逐条校验后才允许落地

import type { HubEvent } from "./events.js";
import type { PmAction, PmConfig, PmDecision, PmMemory } from "./pm.js";
import { buildPrompt, callPm, parseDecision, PM_IRON_RULES } from "./pm.js";
import type { Order } from "./types.js";

export interface PmRunnerDeps {
  config: () => PmConfig;
  memory: () => PmMemory;
  policy: () => string;
  /** 未完成工单快照 */
  openOrders: () => Order[];
  /** 在线节点快照 */
  nodes: () => { name: string; online: boolean; state?: string; workingOn?: string; role?: string; queuedCount?: number }[];
  createOrders: (orders: PmAction extends never ? never : any[], by: string) => string[];
  assign: (orderId: string, assignee: string, note: string, by: string) => void;
  updateStatus: (orderId: string, status: string, note: string, by: string) => void;
  sendMessage: (to: string, text: string) => void;
  dispatch: (orderId: string, assignee: string, by: string) => void;
  log: (line: string) => void;
}

const PM_NAME = "hub-pm";
/** 同一工单 10 分钟内最多被 PM 改几次，防抖环 */
const ORDER_TOUCH_WINDOW_MS = 10 * 60 * 1000;
const ORDER_TOUCH_LIMIT = 3;
const STATUS_ORDER = ["backlog", "analyzing", "developing", "testing", "review", "done"];

/** 执行一批事件对应的决策；返回本次决策记录 */
export async function runDecision(
  batch: HubEvent[],
  deps: PmRunnerDeps
): Promise<PmDecision> {
  const cfg = deps.config();
  const started = Date.now();
  const memory = deps.memory();

  const { system, user } = buildPrompt(
    {
      events: batch,
      orders: deps.openOrders().map(o => ({
        id: o.id,
        title: o.title,
        status: o.status,
        assignee: o.assignee,
        parent: o.parent,
        blockedBy: (o as any).blockedBy,
      })),
      nodes: deps.nodes(),
      memory,
      policy: deps.policy()
    },
    cfg.tokenBudget
  );

  const call = await callPm(cfg, system, user);
  if ("error" in call) {
    return {
      at: started,
      eventCount: batch.length,
      reasoning: "",
      actions: [],
      applied: 0,
      rejected: [],
      error: call.error,
      durationMs: Date.now() - started
    };
  }

  const parsed = parseDecision(call.text, cfg.maxActionsPerDecision, 0);
  if ("error" in parsed) {
    return {
      at: started,
      eventCount: batch.length,
      reasoning: "",
      actions: [],
      applied: 0,
      rejected: [],
      error: parsed.error,
      durationMs: Date.now() - started
    };
  }

  const { applied, rejected } = applyActions(parsed.actions, deps, memory);
  return {
    at: started,
    eventCount: batch.length,
    reasoning: parsed.reasoning,
    actions: parsed.actions,
    applied,
    rejected,
    durationMs: Date.now() - started
  };
}

/** 逐条校验并执行；单条非法只丢这一条，不影响其余 */
function applyActions(
  actions: PmAction[],
  deps: PmRunnerDeps,
  memory: PmMemory
): { applied: number; rejected: { action: unknown; reason: string }[] } {
  const rejected: { action: unknown; reason: string }[] = [];
  let applied = 0;
  const orders = deps.openOrders();
  const byId = new Map(orders.map(o => [o.id, o]));
  const online = new Set(deps.nodes().filter(n => n.online).map(n => n.name));
  // 本轮已改过的工单计数：防止一次决策里对同一单反复操作
  const touched = new Map<string, number>();
  const memOrders = memory.orders;

  const guard = (orderId: string): string | null => {
    const now = Date.now();
    const rec = memOrders[orderId];
    // 时间窗内的历史修改 + 本轮修改一起算
    const recent = (rec?.reworks ?? 0) + (touched.get(orderId) ?? 0);
    if (rec && now - (rec.createdAt ?? 0) < ORDER_TOUCH_WINDOW_MS && recent > ORDER_TOUCH_LIMIT) {
      return "该工单 10 分钟内已被修改超过 " + ORDER_TOUCH_LIMIT + " 次，暂缓";
    }
    return null;
  };

  for (const action of actions) {
    try {
      switch (action.kind) {
        case "noop":
          applied++;
          break;

        case "create_orders": {
          const created = deps.createOrders(action.orders, PM_NAME);
          for (const o of action.orders) {
            if (o.parent && !byId.has(o.parent)) {
              rejected.push({ action, reason: "父单不存在: " + o.parent });
            }
          }
          for (const id of created) {
            memOrders[id] = { reworks: 0, createdAt: Date.now() };
          }
          applied++;
          deps.log("[pm] 建单 " + created.length + " 张: " + created.join(","));
          break;
        }

        case "assign": {
          const o = byId.get(action.orderId);
          if (!o) { rejected.push({ action, reason: "工单不存在: " + action.orderId }); break; }
          if (!online.has(action.assignee)) { rejected.push({ action, reason: "目标节点不在线: " + action.assignee }); break; }
          if (action.assignee === PM_NAME) { rejected.push({ action, reason: "不能派给自己" }); break; }
          const g = guard(action.orderId);
          if (g) { rejected.push({ action, reason: g }); break; }
          if (!action.note?.trim()) { rejected.push({ action, reason: "改指派必须写 note" }); break; }
          deps.assign(action.orderId, action.assignee, action.note, PM_NAME);
          deps.dispatch(action.orderId, action.assignee, PM_NAME);
          touched.set(action.orderId, (touched.get(action.orderId) ?? 0) + 1);
          applied++;
          deps.log("[pm] 派单 " + action.orderId + " -> " + action.assignee);
          break;
        }

        case "update_status": {
          const o = byId.get(action.orderId);
          if (!o) { rejected.push({ action, reason: "工单不存在: " + action.orderId }); break; }
          const from = STATUS_ORDER.indexOf(o.status);
          const to = STATUS_ORDER.indexOf(action.status);
          // 状态只能向前；自定义状态不参与单调性校验
          if (from >= 0 && to >= 0 && to < from) {
            rejected.push({ action, reason: "状态不能回退: " + o.status + " -> " + action.status });
            break;
          }
          if ((o as any).blockedBy?.length && action.status !== "backlog") {
            const undone = (o as any).blockedBy.filter((b: string) => byId.get(b)?.status !== "done" && byId.has(b));
            if (undone.length) { rejected.push({ action, reason: "依赖未完成: " + undone.join(",") }); break; }
          }
          const g = guard(action.orderId);
          if (g) { rejected.push({ action, reason: g }); break; }
          deps.updateStatus(action.orderId, action.status, action.note ?? "", PM_NAME);
          touched.set(action.orderId, (touched.get(action.orderId) ?? 0) + 1);
          applied++;
          break;
        }

        case "send_message": {
          if (!online.has(action.to)) { rejected.push({ action, reason: "目标节点不在线: " + action.to }); break; }
          deps.sendMessage(action.to, action.text);
          applied++;
          break;
        }
      }
    } catch (err: any) {
      rejected.push({ action, reason: "执行失败: " + String(err?.message ?? err) });
    }
  }

  return { applied, rejected };
}

export { PM_NAME, PM_IRON_RULES };
