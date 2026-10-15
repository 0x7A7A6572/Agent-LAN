# AI 工厂工单系统 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 hub 上加 Order（工单）模型与 5 个 order_* MCP 工具，并出 PM 提示词模板，支撑「PM 编排 + 子工单承载产物」的流水线协作。

**Architecture:** 新增 packages/server/src/orders.ts（纯存储与校验，可独立验证）；mcp-facade.ts 加 5 个工具转发到 OrderStore；index.ts 组装并落盘到 `.orders.json`；PM 说明书做成静态资源 /mcp/pm.md。控制台看板为第二期，不在本计划。

**Tech Stack:** TypeScript (Node ESM)、无新依赖（持久化用 node:fs，id 用 node:crypto）。

**Spec:** docs/superpowers/specs/2026-10-15-ai-factory-orders-design.md

## Global Constraints

- 验证方式：本仓库无测试框架，且用户规则禁止主动创建测试文件——每个任务用「构建 + 内联 e2e 验证」替代单测
- 注释规范：单行 ≤ 30 汉字；Docblock ≤ 3 行；纯文本；只写「负责什么 + 最易踩的约束」
- 不新增 npm 依赖
- MCP 工具命名前缀 mac_，错误用 replyError(-32602, ...) 报参数错、-32000 报业务错
- status 为自由字符串，内置枚举仅作约定：backlog/analyzing/developing/testing/review/done/canceled
- 构建命令：pnpm --filter @mac/server run build（build 会拷贝静态资源）

---

### Task 1: Order 模型与存储（orders.ts）

**Files:**
- Create: `packages/server/src/orders.ts`

**Interfaces:**
- Produces（Task 2 依赖，签名精确如下）:

```ts
export interface FileRef { name: string; uri: string; by?: string; at?: string }
export interface OrderEvent { at: string; by: string; field: string; from?: string; to?: string; note?: string }
export interface Order {
  id: string; title: string; description: string;
  status: string; priority: "urgent" | "high" | "normal" | "low";
  tags: string[]; source: string;
  assignee?: string; owner?: string;
  startDate?: string; dueDate?: string;
  createdAt: string; updatedAt: string;
  attachments: FileRef[];
  parent?: string; blockedBy: string[];
  timeline: OrderEvent[];
}
export interface OrderCreateInput {
  title: string; description?: string; status?: string;
  priority?: Order["priority"]; tags?: string[]; source?: string;
  assignee?: string; owner?: string; startDate?: string; dueDate?: string;
  parent?: string; blockedBy?: string[];
}
export interface OrderUpdateInput {
  status?: string; priority?: Order["priority"]; tags?: string[];
  assignee?: string; owner?: string; startDate?: string; dueDate?: string;
  description?: string; blockedBy?: string[]; force?: boolean;
}
export class OrderStore {
  constructor(filePath: string);
  create(input: OrderCreateInput, by: string): Order;
  get(id: string): Order | undefined;
  list(filter: { status?: string; assignee?: string; tag?: string; parent?: string; priority?: string }): Order[];
  update(id: string, patch: OrderUpdateInput, by: string): Order;
  attach(id: string, ref: FileRef): Order;
  children(id: string): { id: string; title: string; status: string }[];
}
```

- [ ] **Step 1: 写 orders.ts 完整实现**

```ts
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
```

注：`./types.js` — 把上面 Interfaces 里的 FileRef/OrderEvent/Order/OrderCreateInput/OrderUpdateInput 放进新文件 `packages/server/src/types.ts`（纯 interface，无逻辑），orders.ts 从这里 import。OrderStore 不依赖任何其他模块。

- [ ] **Step 2: 构建验证**

Run: `pnpm --filter @mac/server run build`
Expected: tsc 无错误

- [ ] **Step 3: 内联 e2e 验证存储语义**

用 run_code 起 OrderStore（临时文件落盘到系统临时目录），依次断言：
1. create 缺 title → 报错；create 带 parent 不存在 → 报错
2. A blockedBy B，B 未 done 时 A update status→developing → 报错带「依赖未完成」；force=true → 成功
3. B update status→done 后 A 正常推进
4. A blockedBy B 后再 update blockedBy=[A]（自环反向）→ 报「blockedBy 成环」
5. attach 后 attachments 长度 +1 且 timeline 含 attachment 事件
6. 重建 OrderStore 同一路径 → get(id) 仍在（落盘恢复）
Expected: 6 项全部通过

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/types.ts packages/server/src/orders.ts
git commit -m "feat(server): Order model and store with persistence"
```

---

### Task 2: 5 个 order_* MCP 工具与组装

**Files:**
- Modify: `packages/server/src/mcp-facade.ts`（TOOLS 数组 + McpFacadeDeps + tools/call switch）
- Modify: `packages/server/src/index.ts`（实例化 OrderStore、mcpDeps 接线、落盘路径）
- Modify: `packages/server/src/index.ts` 的 ServerOptions（新增可选 ordersPath）

**Interfaces:**
- Consumes: Task 1 的 OrderStore 全部方法
- Produces: 5 个 MCP 工具（mac_order_create / mac_order_get / mac_order_update / mac_order_list / mac_order_attach），McpFacadeDeps 新增：

```ts
orderCreate: (input: OrderCreateInput, by: string) => Order;
orderGet: (id: string) => { order: Order; children: { id: string; title: string; status: string }[] } | null;
orderUpdate: (id: string, patch: OrderUpdateInput, by: string) => Order;
orderList: (filter: Parameters<OrderStore["list"]>[0]) => Order[];
orderAttach: (id: string, name: string, contentBase64: string, by: string) => FileRef;
```

- [ ] **Step 1: mcp-facade.ts 加 TOOLS 描述（5 个）**

在 TOOLS 数组追加（description 写明语义，inputSchema 如下要点）：
- mac_order_create: required [title]；properties title/description/priority(enum 四值)/tags(array)/assignee/owner/startDate/dueDate/parent/blockedBy(array)
- mac_order_get: required [id]
- mac_order_update: required [id]；properties 覆盖 OrderUpdateInput 全字段 + force(boolean, description「绕过依赖等待，环检测仍生效」)
- mac_order_list: 无 required；properties status/assignee/tag/parent/priority
- mac_order_attach: required [id, name, contentBase64]

- [ ] **Step 2: mcp-facade.ts 加 McpFacadeDeps 五个成员（签名见上）与 switch 分支**

```ts
case "mac_order_create": {
  const o = deps.orderCreate({
    title: String(a.title), description: a.description ? String(a.description) : undefined,
    priority: a.priority as any, tags: a.tags, assignee: a.assignee ? String(a.assignee) : undefined,
    owner: a.owner ? String(a.owner) : undefined, startDate: a.startDate, dueDate: a.dueDate,
    parent: a.parent ? String(a.parent) : undefined,
    blockedBy: Array.isArray(a.blockedBy) ? a.blockedBy.map(String) : undefined,
    source: "mcp:" + remoteIpOf(req)
  }, String(a.by ?? "mcp"));
  reply(toolResult(o));
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
      force: Boolean(a.force)
    }, String(a.by ?? "mcp"));
    reply(toolResult(o));
  } catch (err: any) {
    replyError(-32000, String(err?.message ?? err));
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
    replyError(-32000, String(err?.message ?? err));
  }
  return;
}
```

注意：mcpHandle 现有签名没有 remoteIp，source 直接用字符串 "mcp"（与 mac_send_task 的现有做法一致，不为此改函数签名）。

- [ ] **Step 3: index.ts 组装**

```ts
import { OrderStore } from "./orders.js";
// ServerOptions 增加：
/** 工单落盘文件，缺省 filesDir 同级 .orders.json */
ordersPath?: string;
// createServer 内（fileChannel 创建之后）：
const orderStore = new OrderStore(options.ordersPath
  ?? path.join(path.resolve(options.filesDir ?? ".mac-files"), "..", ".orders.json"));
// mcpDeps 追加：
orderCreate: (input, by) => orderStore.create(input, by),
orderGet: id => {
  const o = orderStore.get(id);
  return o ? { order: o, children: orderStore.children(id) } : null;
},
orderUpdate: (id, patch, by) => orderStore.update(id, patch, by),
orderList: f => orderStore.list(f),
orderAttach: (id, name, contentBase64, by) => {
  const uri = fileChannel.save(name, Buffer.from(contentBase64, "base64"));
  const o = orderStore.attach(id, { name, uri, by });
  return { name, uri, by };
}
```

- [ ] **Step 4: 构建 + 全链路 e2e 验证**

Run: `pnpm --filter @mac/server run build`

run_code 起真实服务（port 随机、selfRegister: false），按序调用 MCP：
1. mac_order_create 母单（title=登录功能，tags=[frontend,backend]）→ 得 ord-A
2. mac_order_create 子单 ×2（parent=ord-A；第二个 blockedBy=[子单1]）→ 得 ord-B、ord-C
3. mac_order_update ord-C status=developing → 报「依赖未完成」
4. mac_order_update ord-B status=developing → ok；mac_order_attach ord-B 传一个文件 → 得 uri
5. mac_order_update ord-B status=done → ok；此时 ord-C 推进 → ok
6. mac_order_get ord-A → children 含两个子单
7. mac_order_list assignee 过滤 → 只回对应工单
8. 重启服务进程（重新 import + listen 同路径）→ mac_order_get ord-A 仍在（落盘恢复）
Expected: 8 步全部符合

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/mcp-facade.ts packages/server/src/index.ts
git commit -m "feat(server): expose order_* MCP tools wired to OrderStore"
```

---

### Task 3: PM 提示词模板与文档收口

**Files:**
- Create: `docs/pm-onboarding.md`
- Modify: `packages/server/package.json`（build 拷贝 pm.md）
- Modify: `packages/server/src/index.ts`（路由 GET /mcp/pm.md，模式与 /mcp/install.md 相同）
- Modify: `docs/agent-onboarding.md`（加「编排角色」一节指向 pm.md）

**Interfaces:**
- Consumes: Task 2 的 5 个工具名
- Produces: GET /mcp/pm.md 返回 PM 全文（与 docs/pm-onboarding.md 同源）

- [ ] **Step 1: 写 docs/pm-onboarding.md**

```markdown
# PM 编排节点接入说明书

你是 multi-agent-connect AI 工厂的编排者（PM）。你的职责：接需求、拆工单、
派发、盯进度、验收推进。你不亲自实现需求，你通过下面这套工具驱动全部流转。

## 工具

- mac_order_create：建工单（母单或子单，parent 指向母单）
- mac_order_get：查工单全量（含 timeline 流转记录与 children）
- mac_order_update：推进状态 / 改处理人 / 挂产物（每次变更自动记 timeline）
- mac_order_list：你的看板（按 status / assignee / tag 过滤）
- mac_order_attach：给工单挂产物文件
- mac_send_task / mac_send_message：把活推进到节点手里（最后一公里）
- mac_list_agents：看在线节点与能力标签

## 工作流

1. 接需求：需求以母单形式出现（人建或你建）。mac_order_get 读透它。
2. 拆解：按交付边界拆子单（parent=母单），有先后关系的用 blockedBy 表达。
   每个子单 title 写「做什么」，description 写「验收标准 + 依赖产物 URI」。
3. 派发：mac_list_agents 选能力匹配且空闲的节点为 assignee，
   mac_send_task 通知它开工（任务文本带上子单 id 和验收标准）。
4. 盯进度：节点 mac_report 后，你 mac_order_get 子单看产物，
   验收通过 → 子单 status 推进；不通过 → status 回退 + note 写明原因，
   重新 send_task（这就是打回）。
5. 依赖解锁：blockedBy 全部 done 后，被依赖的子单才能离开 backlog。
   force=true 可强制推进，仅用于人明确指示时。
6. 收口：全部子单 done → 把最终交付物 mac_order_attach 到母单，
   母单 status → review，向来源（source 字段）报告，人确认后 → done。

## 约定

- 每次推进都在 update 时写清楚 note，timeline 是唯一的流转事实。
- 节点能力标签约定：requirement/product/frontend/backend/test/pm/docs。
- 母单 attachments 只放最终验收物，中间产物一律挂子单。
- 不确定的事问人：mac_send_message to=human 不存在，
  直接在 mac_report 的 text 里写「需人工决策：<问题>」。
```

- [ ] **Step 2: build 拷贝 + 路由**

packages/server/package.json 的 build 改为：

```json
"build": "tsc -p tsconfig.json && node -e \"const fs=require('fs');['console.html','worker.sh','probe.sh'].forEach(f=>fs.copyFileSync('src/'+f,'dist/'+f));fs.copyFileSync('../../docs/agent-onboarding.md','dist/install.md');fs.copyFileSync('../../docs/pm-onboarding.md','dist/pm.md')\""
```

index.ts 在 /mcp/install.md 路由旁复制一份：

```ts
if (req.method === "GET" && url.pathname === "/mcp/pm.md") {
  res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
  res.end(pmMd());
  return;
}
// 函数：
function pmMd(): string {
  const tpl = path.join(path.dirname(fileURLToPath(import.meta.url)), "pm.md");
  return fs.readFileSync(tpl, "utf8");
}
```

- [ ] **Step 3: agent-onboarding.md 加一节**

在文档末尾追加：

```markdown
## 四、编排角色（AI 工厂模式）

把某个节点设为 PM（编排者）：它读 http://<主服务IP>/mcp/pm.md 按说明书工作，
用 mac_order_* 系列工具拆单、派发、推进流水线，其他节点照常接活上报。
PM 的接入方式与普通节点完全相同（先跑 probe.sh 体检，再下载 worker.sh）。
```

- [ ] **Step 4: 构建 + 验证**

Run: `pnpm --filter @mac/server run build`

run_code/pwsh 验证：起服 → GET /mcp/pm.md 返回 200 且首行是「# PM 编排节点接入说明书」；GET /mcp/install.md 含「编排角色」一节。
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add docs/pm-onboarding.md docs/agent-onboarding.md packages/server/package.json packages/server/src/index.ts
git commit -m "feat(server): PM onboarding template served at /mcp/pm.md"
```

---

## 计划外（第二期，另行开工）

- 控制台工单看板视图（读 order 数据渲染，不新增服务端能力）
- 节点接活时自动从任务文本解析子单 id 回填 assignee
