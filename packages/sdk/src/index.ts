// 统一 agent 接口与 A2A 消息类型，所有包共用
export interface AgentCard {
  name: string;
  description?: string;
  url: string;
  version: string;
  /** 所在主机标识，如机器名或 IP；缺省按节点名分组 */
  host?: string;
  /** agent 程序类型（dsh/workbuddy/...），与 ~/.mac-worker/<agent> 目录一致 */
  agent?: string;
  capabilities: {
    streaming: boolean;
    adapters: string[];
  };
}

export type TaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled";

export interface FileArtifact {
  name: string;
  mimeType?: string;
  uri: string;
}

export type Artifact = FileArtifact;

export interface TaskStatus {
  state: TaskState;
  message?: string;
  timestamp: string;
}

export interface Task {
  id: string;
  sessionId?: string;
  state: TaskState;
  prompt: string;
  artifacts: Artifact[];
  createdAt: string;
  updatedAt: string;
  /** 最近一次投递给节点的时刻与对象：用于识别投递丢失并回收 */
  deliveredAt?: string;
  deliveredTo?: string;
  /** 投递已发出但未确认送达：为 true 时进程若中断，重启后据此回收 */
  deliveredInFlight?: boolean;
  /** 节点是否已就本任务回报过任何结果；投递丢失的判据之一 */
  reportedAt?: string;
}

export type InvokeEvent =
  | { kind: "status"; status: TaskStatus }
  | { kind: "artifact"; artifact: Artifact }
  | { kind: "message"; text: string };

export interface AgentAdapter {
  readonly name: string;
  invoke(task: Task): AsyncIterable<InvokeEvent>;
  shutdown?(): Promise<void>;
}

// A2A JSON-RPC 方法名常量
export const A2A_METHODS = {
  MESSAGE_SEND: "message/send",
  MESSAGE_STREAM: "message/stream",
  TASK_GET: "tasks/get",
  TASK_CANCEL: "tasks/cancel"
} as const;

export const AGENT_CARD_PATH = "/.well-known/agent-card.json";

export interface AgentPresence {
  card: AgentCard;
  lastSeen: string;
  online: boolean;
  /** 执行中标记：已领任务未上报结果；控制台按蓝色显示 */
  state?: "idle" | "working";
  /** busy 起始毫秒（服务端内部用，防僵尸超时判定） */
  busySince?: number;
  /**
   * 执行中来源，决定 workingOn 措辞与到期策略：
   * - task    派发的任务（由投递/上报驱动，不设 TTL，沿用 busySince + BUSY_MAX_MS）
   * - message 刚收到留言在消化（投递即置位，下一次领活即视为处理完）
   * - agent   节点主动上报（如人工接管 / 会话内自行开工），靠 TTL 或显式 idle 清除
   */
  busyKind?: "task" | "message" | "agent";
  /** 该执行态的到期毫秒时刻；到期由 sweep 自动回空闲（task 类不设） */
  busyUntil?: number;
  /** 正在做的工单摘要，如「ord-xxx 登录页」 */
  workingOn?: string;
  /** 正在等谁确认什么；有值即需人工介入，控制台据此提醒 */
  waitingFor?: string;
  /** 心跳来源推算的对端根地址，如 http://192.168.1.2:9600 */
  baseUrl?: string;
  /** 分组用主机标识：卡片 host > 来源 IP > url 兜底（服务端算好） */
  groupHost: string;
  /** 最近一次注册的来源 IP：同机判定的权威依据（自报 host 可能是主机名） */
  sourceIp?: string;
  /** agent 程序类型（dsh/workbuddy/...），注册时自报并随名册下发 */
  agent?: string;
  /** 最近一次带 name 的 MCP 工具调用时刻；无则该节点只有心跳在跳 */
  lastMcp?: string;
  /** 90s 内有 MCP 工具调用 = agent 会话真实存活（读时计算） */
  mcpActive?: boolean;
}
