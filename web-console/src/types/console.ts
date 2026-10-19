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
  /** 正在等谁确认什么；有值即需人工介入 */
  waitingFor?: string
  groupHost?: string
  lastSeen: number
  mcpActive?: boolean
  agent?: string
  queuedCount?: number
}

/** 派发权状态：human 人工模式 / pm PM 接管 / degraded PM 超时已放行 */
export type DispatchMode = 'human' | 'pm' | 'degraded'

export interface PmState {
  mode: DispatchMode
  /** PM 节点名；pm 模式下的调度中枢 */
  pmName?: string
  enabled: boolean
  /** 已配置模型名，前端不显示 key */
  model?: string
  baseUrl?: string
  apiKeyConfigured?: boolean
}

export type OrderStatus =
  | 'backlog'
  | 'analyzing'
  | 'developing'
  | 'blocked'
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
  uri?: string
  by?: string
  at?: string
}

export interface FileInfo {
  name: string
  size: number
  mtime: string
  uri: string
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
