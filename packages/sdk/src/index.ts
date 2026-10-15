// 统一 agent 接口与 A2A 消息类型，所有包共用
export interface AgentCard {
  name: string;
  description?: string;
  url: string;
  version: string;
  /** 所在主机标识，如机器名或 IP；缺省按节点名分组 */
  host?: string;
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
  /** 心跳来源推算的对端根地址，如 http://192.168.1.2:9600 */
  baseUrl?: string;
  /** 分组用主机标识：卡片 host > 来源 IP > url 兜底（服务端算好） */
  groupHost: string;
}
