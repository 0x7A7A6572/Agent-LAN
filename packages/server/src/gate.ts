// 派发权门禁：调度控制流归 Supervisor，通信数据流放行
// 关键约束：PM 接管期间只放行 PM 自己的派发与同工单返工，没有超时豁免

export type DispatchMode = "human" | "pm";

export interface GateOptions {
  onLog?: (line: string) => void;
}

/** 拦截判定的输入：一次派发请求 */
export interface DispatchRequest {
  /** 发起方节点名，来自连接上下文而非调用方自报 */
  actor: string;
  /** 目标节点 */
  target: string;
  /** 挂在哪张工单；裸任务为空 */
  orderId?: string;
  /** 该工单当前 assignee */
  assignee?: string;
  /** 是否同工单内返工 */
  rework?: boolean;
}

export interface GateVerdict {
  allow: boolean;
  mode: DispatchMode;
  reason?: string;
}

/**
 * 由任务 prompt 派生「同工单返工」标记。
 * 这是派发侧判断 rework 的唯一判据——落库前预检和入队时判定必须共用它，
 * 否则两处各写一遍字符串字面量，迟早漂移（D12 的根因之一）。
 */
export function isReworkPrompt(prompt: string): boolean {
  return prompt.includes("[返工]");
}

/**
 * 纯函数门禁判定：不依赖任何实例状态。
 * DispatchGate.check 必须走这里，保证「落库前预检」与「入队时判定」永远是同一套语义。
 */
export function evaluateDispatch(mode: DispatchMode, pmName: string, req: DispatchRequest): GateVerdict {
  // 人永远是最高权限，任何模式下都不拦
  if (req.actor === "human-console" || req.actor === pmName) {
    return { allow: true, mode };
  }
  if (mode !== "pm") {
    return { allow: true, mode };
  }
  // pm 模式：只有同工单内返工豁免
  if (req.rework) {
    return { allow: true, mode, reason: "同工单内返工" };
  }
  return {
    allow: false,
    mode,
    reason: "PM 接管期间，跨工单派发必须经 Supervisor（当前发起方 " + req.actor + "）"
  };
}

export class DispatchGate {
  private mode: DispatchMode = "human";
  private lastPmBeat = 0;
  private pmName = "hub-pm";

  constructor(private opts: GateOptions = {}) {}

  get current(): DispatchMode {
    return this.mode;
  }

  get pmNodeName(): string {
    return this.pmName;
  }

  /** 最近一次 PM 成功决策时间，仅用于观测，不参与放行判定 */
  get lastBeat(): number {
    return this.lastPmBeat;
  }

  /** 人类开启/关闭 PM 接管；人始终是最高权限 */
  setMode(mode: DispatchMode, by: string): void {
    const before = this.mode;
    this.mode = mode;
    if (mode === "pm") this.lastPmBeat = Date.now();
    this.opts.onLog?.("[gate] 派发权 " + before + " -> " + mode + " (by " + by + ")");
  }

  /** PM 每次成功决策后记一笔时间戳 */
  beat(): void {
    this.lastPmBeat = Date.now();
  }

  /** 判定一次派发是否放行 */
  check(req: DispatchRequest): GateVerdict {
    return evaluateDispatch(this.mode, this.pmName, req);
  }
}
