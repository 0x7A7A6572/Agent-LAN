// 控制台全部业务实体：与服务端 JSON 结构逐字段对齐
export interface AgentCard {
  name: string
  description?: string
  url: string
  host?: string
  agent?: string
  [k: string]: unknown
}

export type NodeState = 'idle' | 'working' | string

export interface Presence {
  card: AgentCard
  online: boolean
  state?: NodeState
  role?: string
  workingOn?: string
  groupHost?: string
  lastSeen: number
  mcpActive?: boolean
  agent?: string
}

export type OrderStatus =
  | 'backlog'
  | 'analyzing'
  | 'developing'
  | 'testing'
  | 'review'
  | 'done'
  | 'canceled'

export type OrderPriority = 'low' | 'normal' | 'high' | 'urgent'

export interface OrderTimelineEvent {
  at: string
  by: string
  field: string
  to?: string
  note?: string
}

export interface OrderAttachment {
  name: string
  [k: string]: unknown
}

export interface Order {
  id: string
  title: string
  description?: string
  status: OrderStatus
  priority: OrderPriority
  assignee?: string
  dueDate?: string
  source: string
  createdAt: string
  parent?: string
  timeline: OrderTimelineEvent[]
  attachments: OrderAttachment[]
}

export interface OrderDetail {
  order: Order
  children: Order[]
}

export interface JsonRpcError {
  message: string
  code?: number
  [k: string]: unknown
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0'
  id?: number
  result?: T
  error?: JsonRpcError
}
