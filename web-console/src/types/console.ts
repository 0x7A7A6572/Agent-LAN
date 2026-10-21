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

/** 角色库条目：名字是节点指派的依据，desc 是给人看的一句话职责 */
export interface RoleDef {
  name: string
  desc?: string
}

export interface Presence {
  card: AgentCard
  online: boolean
  state?: NodeState
  role?: string
  /** 角色职责说明，服务端按角色库补全 */
  roleDesc?: string
  /** 待处理留言摘要；只展示，不代表节点在忙 */
  pendingMail?: string
  workingOn?: string
  /** 正在等谁确认什么；有值即需人工介入 */
  waitingFor?: string
  groupHost?: string
  lastSeen: number
  mcpActive?: boolean
  agent?: string
  queuedCount?: number
  /** 排队任务摘要列表（最多5条），3D 拓扑任务牌逐条显示 */
  queuedItems?: string[]
}

/** 派发权状态：human 人工模式 / pm PM 接管 */
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
  /** PM 连续决策失败次数；只做提示，不影响派发权 */
  failStreak?: number
}

export interface PmConfigView {
  enabled: boolean
  /** 模型来源：openai 任意兼容端点 / workbuddy 直连本机桌面版 */
  provider: 'openai' | 'workbuddy'
  baseUrl: string
  model: string
  temperature: number
  debounceMs: number
  tickMs: number
  maxActionsPerDecision: number
  tokenBudget: number
  timeoutMs: number
  apiKeyConfigured: boolean
}

export interface PmDecisionView {
  at: number
  eventCount: number
  reasoning: string
  actions: { kind: string }[]
  applied: number
  rejected: { reason: string }[]
  error?: string
  durationMs: number
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

/** 派发边：from 把工单交给 to，from 为空表示首次派发 */
export interface OrderHandoff {
  at: string
  from?: string
  to: string
  by: string
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
  handoffs?: OrderHandoff[]
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