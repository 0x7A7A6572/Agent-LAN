// 工单领域类型：纯接口定义，供 orders.ts 与 MCP 工具层共用

export interface FileRef { name: string; uri: string; by?: string; at?: string }
export interface OrderEvent { at: string; by: string; field: string; from?: string; to?: string; note?: string }
// 派发边：from 交给 to，控制台拓扑据此画流光。from 为空表示首次派发
export interface OrderHandoff { at: string; from?: string; to: string; by: string }
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
  handoffs?: OrderHandoff[];
}
export interface OrderCreateInput {
  title: string; description?: string; status?: string;
  priority?: Order["priority"]; tags?: string[]; source?: string;
  assignee?: string; owner?: string; startDate?: string; dueDate?: string;
  parent?: string; blockedBy?: string[];
}
export interface OrderUpdateInput {
  title?: string; status?: string; priority?: Order["priority"]; tags?: string[];
  assignee?: string; owner?: string; startDate?: string; dueDate?: string;
  description?: string; parent?: string; blockedBy?: string[]; force?: boolean;
  note?: string;
}
