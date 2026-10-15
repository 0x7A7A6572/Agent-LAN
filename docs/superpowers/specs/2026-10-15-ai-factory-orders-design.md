# AI 工厂：角色协作与工单流转 设计文档

日期：2026-10-15
状态：待评审

## 目标

在 multi-agent-connect 现有「节点注册 + 任务派发 + 文件共享」之上，
增加角色化协作能力：需求以工单形式进入，由编排 agent（PM）拆解、
派发、推进，各节点产出挂载在子工单上，最终在母工单验收。

## 已确认的决策

1. 流转驱动：编排 agent（方案 C）——hub 不写死状态机，
   流转逻辑活在 PM 的提示词里。
2. 角色绑定：混合（方案 C）——节点可声明固定角色（能力标签），
   也可接临时指派；角色定义跟着节点声明走。
3. 工单系统：完整工单对象（方案 B），含状态、处理人、优先级、
   标签、附件、起止时间、来源、父子关系、依赖、流转记录。
4. 产物挂载：子工单承载中间产物（方案 1），母工单 attachments
   只放最终验收物。
5. 动作集：新增 order_* MCP 工具组（方案 A），共 5 个。

## 数据模型

### Order（工单）

```ts
interface FileRef { name: string; uri: string; by?: string; at?: string }

interface OrderEvent {
  at: string;            // ISO 时间
  by: string;            // 操作者（节点名 / human-console）
  field: string;         // 变更字段：status / assignee / ...
  from?: string;
  to?: string;
  note?: string;
}

interface Order {
  id: string;            // ord-<uuid8>
  title: string;
  description: string;   // markdown
  status: string;        // 内置枚举见下，允许自定义字符串
  priority: "urgent" | "high" | "normal" | "low";
  tags: string[];
  source: string;        // human-console / 节点名
  assignee?: string;     // 当前处理节点
  owner?: string;        // 工单负责人，流转不变
  startDate?: string;    // YYYY-MM-DD
  dueDate?: string;
  createdAt: string;
  updatedAt: string;
  attachments: FileRef[];
  parent?: string;       // 母工单 id
  blockedBy: string[];   // 依赖的工单 id
  timeline: OrderEvent[];
}
```

### 内置 status 枚举（约定语义，不强制）

backlog（待处理）/ analyzing（分析中）/ developing（开发中）/
testing（测试中）/ review（验收中）/ done / canceled

自定义字符串允许存入；控制台对内置枚举显示颜色，自定义原样显示。

### 存储

内存 Map + JSON 落盘（.orders.json，与 .mac-files 同级），
hub 重启不丢工单。变更即写盘（防抖 1s 合并）。

## MCP 工具（5 个）

| 工具 | 入参 | 出参 | 说明 |
|---|---|---|---|
| mac_order_create | title 必填；description/priority/tags/assignee/parent/blockedBy/source/dueDate 可选 | Order | parent 存在则校验；blockedBy 校验目标存在 |
| mac_order_get | id | Order + children[] | children 为子工单 id+title+status 摘要 |
| mac_order_update | id 必填；其余字段可选 | Order | blockedBy 工单未 done 时禁止 status→非 backlog（携带 force=true 可绕过依赖等待，但环检测始终生效）；每次变更自动记 timeline |
| mac_order_list | 过滤：status/assignee/tag/parent/priority | Order[]（按 priority+updatedAt 排序） | 编排 agent 的看板 |
| mac_order_attach | id、name、contentBase64 | FileRef | 内部走 uploadFile，URI 自动写入 attachments |

现有 mac_send_task / mac_send_message 不动，负责把活推进到节点。

## 流转约定（PM 提示词承载，非代码强制）

母单生命周期（由 PM 驱动）：

1. 需求进入：human-console 或节点 mac_order_create 母单，
   assignee 留空或指 PM。
2. PM order_get 母单 → 拆子单（parent=母单），
   按节点能力标签 + 忙闲（order_list assignee 过滤）选 assignee，
   mac_send_task 通知节点开工（task 文本带子单 id）。
3. 节点完成：mac_report 上报 + 产物走子单 mac_order_attach。
4. PM 验子单产物 → order_update 推进/打回（打回 = 子单
   status 回 developing + note 写明原因，重新 send_task）。
5. 全部子单 done → PM 汇总最终交付物挂母单 attachments，
   母单 status → review → done。

依赖规则：blockedBy 中任一未 done，子单不得离开 backlog。

## 角色声明（节点侧）

复用现有 AgentCard.abilities（接入时已支持能力标签数组），
约定语义标签：requirement / product / frontend / backend /
test / devops / pm / docs。mac_list_agents 已能看到，
PM 据此选人。不新增注册字段。

## 控制台

新增 /console 工单视图（第二期可后置）：
看板列 = 内置 status，卡片 = 工单（标题/处理人/优先级色点/子单进度），
点开详情 = 字段 + timeline + 附件列表。
第一期先靠 mac_order_list + 节点工具使用，看板后补。

## PM 提示词模板

新增静态资源 /mcp/pm.md（与 install.md 同源同构，docs/pm-onboarding.md），
内容：PM 节点的工作流说明书（上面「流转约定」的展开版 +
工具用法示例 + 打回话术模板）。

## 错误处理

- order_update 对不存在的 id / parent / blockedBy → -32602 明确报错
- blockedBy 环检测：A blockedBy B 且 B blockedBy A → 拒绝；force 只绕过依赖等待，不绕过环
- 落盘失败 → 拒绝写操作并报错（宁可拒单不丢单）
- hub 重启恢复：启动时读 .orders.json 重建 Map

## 不做的（YAGNI）

- 不做状态机代码强制（流转合法性靠 PM 提示词 + blockedBy 硬约束）
- 不做角色权限隔离（任何节点都能调 order_* 工具，靠约定）
- 不做看板实时推送（第二期做）
- 不做跨 hub 工单（单 hub 内闭环）

## 实施拆分

1. Order 模型 + 存储 + 5 个 MCP 工具（含单测级验证）
2. pm.md 提示词模板 + install.md 增补
3. 控制台看板视图（第二期，可独立开工）
