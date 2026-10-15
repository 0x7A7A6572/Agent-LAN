// 统一 agent 接口与 A2A 消息类型，所有包共用
export interface AgentCard {
  name: string;
  description?: string;
  url: string;
  version: string;
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
