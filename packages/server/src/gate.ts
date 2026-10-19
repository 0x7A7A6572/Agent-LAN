// 派发权门禁：调度控制流归 Supervisor，通信数据流放行
// 关键约束：PM 失联必须自动降级，否则会半死不活地占着派发权

export type DispatchMode = "human" | "pm" | "degraded";

export interface GateOptions {
  /** pm 模式下 PM 连续多久没有成功决策判定降级 */
  pmTimeoutMs: number;
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

export class DispatchGate {
  private mode: DispatchMode = "human";
  private lastPmBeat = 0;
  private pmName = "hub-pm";
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(private opts: GateOptions) {}

  start(): void {
    this.sweepTimer = setInterval(() => this.sweep(), 5000);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  get current(): DispatchMode {
    return this.mode;
  }

  get pmNodeName(): string {
    return this.pmName;
  }

  /** 人类开启/关闭 PM 接管；人始终是最高权限 */
  setMode(mode: DispatchMode, by: string): void {
    const before = this.mode;
    this.mode = mode;
    if (mode === "pm") this.lastPmBeat = Date.now();
    this.opts.onLog?.("[gate] 派发权 " + before + " -> " + mode + " (by " + by + ")");
  }

  /** PM 每次成功决策后续命；degraded 不自动恢复，需人确认 */
  beat(): void {
    this.lastPmBeat = Date.now();
  }

  /** 判定一次派发是否放行 */
  check(req: DispatchRequest): GateVerdict {
    // 人永远是最高权限，任何模式下都不拦
    if (req.actor === "human-console" || req.actor === this.pmName) {
      return { allow: true, mode: this.mode };
    }
    if (this.mode !== "pm") {
      // human / degraded：不拦截
      return { allow: true, mode: this.mode };
    }
    // pm 模式：只有同工单内返工豁免
    if (req.rework) {
      return { allow: true, mode: this.mode, reason: "同工单内返工" };
    }
    return {
      allow: false,
      mode: this.mode,
      reason: "PM 接管期间，跨工单派发必须经 Supervisor（当前发起方 " + req.actor + "）"
    };
  }

  private sweep(): void {
    if (this.mode !== "pm") return;
    if (Date.now() - this.lastPmBeat <= this.opts.pmTimeoutMs) return;
    const idle = Math.round((Date.now() - this.lastPmBeat) / 1000);
    this.mode = "degraded";
    this.opts.onLog?.("[gate] PM " + idle + "s 无成功决策，派发权降级为 degraded（已放行，需人工恢复）");
  }
}
