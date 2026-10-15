// 工单存储：校验与流转约束，JSON 落盘防丢
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Order, OrderCreateInput, OrderUpdateInput, OrderEvent, FileRef } from "./types.js";

const PRIORITIES = ["urgent", "high", "normal", "low"];

export class OrderStore {
  private orders = new Map<string, Order>();
  private saveTimer?: NodeJS.Timeout;

  constructor(private filePath: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Order[];
      for (const o of raw) this.orders.set(o.id, o);
    } catch { /* 首次启动无文件 */ }
  }

  private save(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      const arr = [...this.orders.values()];
      fs.writeFileSync(this.filePath, JSON.stringify(arr, null, 2));
    }, 500);
    this.saveTimer.unref?.();
  }

  create(input: OrderCreateInput, by: string): Order {
    if (!input.title?.trim()) throw new Error("缺少 title");
    if (input.priority && !PRIORITIES.includes(input.priority)) throw new Error("priority 非法: " + input.priority);
    if (input.parent && !this.orders.has(input.parent)) throw new Error("父工单不存在: " + input.parent);
    for (const b of input.blockedBy ?? []) if (!this.orders.has(b)) throw new Error("依赖不存在: " + b);
    if (input.parent && (input.blockedBy ?? []).includes(input.parent)) throw new Error("不能依赖自己的父工单");
    if (input.blockedBy?.length && this.hasCycle(undefined, input.blockedBy)) throw new Error("blockedBy 成环");
    const now = new Date().toISOString();
    const order: Order = {
      id: "ord-" + randomUUID().slice(0, 8),
      title: input.title.trim(),
      description: input.description ?? "",
      status: input.status ?? "backlog",
      priority: input.priority ?? "normal",
      tags: input.tags ?? [],
      source: input.source ?? by,
      assignee: input.assignee,
      owner: input.owner ?? input.assignee,
      startDate: input.startDate,
      dueDate: input.dueDate,
      createdAt: now,
      updatedAt: now,
      attachments: [],
      parent: input.parent,
      blockedBy: input.blockedBy ?? [],
      timeline: [{ at: now, by, field: "created", to: input.status ?? "backlog" }]
    };
    this.orders.set(order.id, order);
    this.save();
    return order;
  }

  /** 立即落盘并取消待写定时器，进程退出前调用防丢尾写 */
  flushNow(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    fs.writeFileSync(this.filePath, JSON.stringify([...this.orders.values()], null, 2));
  }

  get(id: string): Order | undefined { return this.orders.get(id); }

  list(f: { status?: string; assignee?: string; tag?: string; parent?: string; priority?: string }): Order[] {
    const rank = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
    return [...this.orders.values()]
      .filter(o => (!f.status || o.status === f.status)
        && (!f.assignee || o.assignee === f.assignee)
        && (!f.parent || o.parent === f.parent)
        && (!f.priority || o.priority === f.priority)
        && (!f.tag || o.tags.includes(f.tag)))
      .sort((a, b) => rank[a.priority] - rank[b.priority]
        || b.updatedAt.localeCompare(a.updatedAt));
  }

  update(id: string, patch: OrderUpdateInput, by: string): Order {
    const o = this.orders.get(id);
    if (!o) throw new Error("工单不存在: " + id);
    if (patch.priority && !PRIORITIES.includes(patch.priority)) throw new Error("priority 非法: " + patch.priority);
    if (patch.blockedBy) {
      for (const b of patch.blockedBy) {
        if (b === id) throw new Error("不能依赖自己");
        if (!this.orders.has(b)) throw new Error("依赖不存在: " + b);
      }
      if (this.hasCycle(id, patch.blockedBy)) throw new Error("blockedBy 成环");
    }
    const leavingBacklog = patch.status && patch.status !== "backlog" && o.status === "backlog";
    if (leavingBacklog && !patch.force) {
      const undone = o.blockedBy.filter(b => this.orders.get(b)?.status !== "done");
      if (undone.length) throw new Error("依赖未完成: " + undone.join(",") + "（force=true 可强制）");
    }
    const now = new Date().toISOString();
    const events: OrderEvent[] = [];
    const track = (field: string, to: unknown) => {
      const from = (o as any)[field];
      if (JSON.stringify(from) !== JSON.stringify(to)) {
        (o as any)[field] = to;
        events.push({ at: now, by, field, from: String(from), to: String(to) });
      }
    };
    track("status", patch.status ?? o.status);
    track("priority", patch.priority ?? o.priority);
    track("assignee", patch.assignee ?? o.assignee);
    track("owner", patch.owner ?? o.owner);
    track("startDate", patch.startDate ?? o.startDate);
    track("dueDate", patch.dueDate ?? o.dueDate);
    track("description", patch.description ?? o.description);
    track("tags", patch.tags ?? o.tags);
    track("blockedBy", patch.blockedBy ?? o.blockedBy);
    if (events.length) {
      o.updatedAt = now;
      o.timeline.push(...events);
      this.save();
    }
    return o;
  }

  attach(id: string, ref: FileRef): Order {
    const o = this.orders.get(id);
    if (!o) throw new Error("工单不存在: " + id);
    const now = new Date().toISOString();
    o.attachments.push({ ...ref, by: ref.by, at: now });
    o.updatedAt = now;
    o.timeline.push({ at: now, by: ref.by ?? "unknown", field: "attachment", to: ref.name });
    this.save();
    return o;
  }

  children(id: string): { id: string; title: string; status: string }[] {
    return [...this.orders.values()]
      .filter(o => o.parent === id)
      .map(o => ({ id: o.id, title: o.title, status: o.status }));
  }

  private hasCycle(selfId: string | undefined, blockedBy: string[]): boolean {
    // blockedBy 边反向遍历：self→依赖，依赖链回到 self 即成环
    const visit = (id: string, seen: Set<string>): boolean => {
      if (selfId && id === selfId) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      const o = this.orders.get(id);
      return (o?.blockedBy ?? []).some(b => visit(b, seen));
    };
    return blockedBy.some(b => visit(b, new Set()));
  }
}
