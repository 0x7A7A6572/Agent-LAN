// hub 内部事件总线：采集领域事件，去抖合并成批交给决策器
// 关键约束：PM 自己动作引发的事件必须标记来源，否则会自激发死循环

export type HubEventKind =
  | "order/created"
  | "order/status"
  | "order/assigned"
  | "task/completed"
  | "task/input-required"
  | "node/online"
  | "node/offline"
  | "mail/sent"
  | "pm/tick";

export interface HubEvent {
  kind: HubEventKind;
  at: number;
  /** 事件摘要，直接进决策 prompt，字段保持扁平 */
  data: Record<string, unknown>;
  /** 制造者：节点名 / human-console / pm。pm 产出的事件不触发下一轮 */
  causedBy: string;
}

export interface EventBusOptions {
  /** 去抖窗口毫秒：窗口内的多个事件合并为一批 */
  debounceMs: number;
  /** 一批事件到齐后回调，异步执行完再接收下一批 */
  onBatch: (batch: HubEvent[]) => void | Promise<void>;
  /** 保底扫描间隔毫秒，0 关闭 */
  tickMs: number;
  onLog?: (line: string) => void;
}

const MAX_BATCH = 40;

export class EventBus {
  private pending: HubEvent[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private tickTimer?: ReturnType<typeof setInterval>;
  private busy = false;
  private dropped: string[] = [];

  constructor(private opts: EventBusOptions) {}

  start(): void {
    if (this.opts.tickMs > 0) {
      this.tickTimer = setInterval(() => this.scheduleTick(), this.opts.tickMs);
      this.tickTimer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.timer = undefined;
    this.tickTimer = undefined;
  }

  /** 投递事件。causedBy 为 pm 的事件只入批不触发，避免自激 */
  emit(e: HubEvent): void {
    if (e.causedBy === "pm") {
      // PM 的产物下一轮靠全局快照看见，不进触发队列
      this.opts.onLog?.("[pm] 事件 " + e.kind + " 由 PM 产生，不触发决策");
      return;
    }
    this.pending.push(e);
    if (this.pending.length > MAX_BATCH) {
      this.pending.splice(0, this.pending.length - MAX_BATCH);
      this.opts.onLog?.("[pm] 事件积压，已丢弃最旧的 " + (this.pending.length - MAX_BATCH) + " 条");
    }
    this.arm();
  }

  /** PM 决策期间产生的事件：不触发，但记一笔供人工查看 */
  noteDropped(kind: string): void {
    this.dropped.push(kind);
    if (this.dropped.length > 50) this.dropped.shift();
  }

  private scheduleTick(): void {
    this.emit({ kind: "pm/tick", at: Date.now(), data: { pending: this.pending.length }, causedBy: "human-console" });
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.opts.debounceMs);
    this.timer.unref?.();
  }

  /** 立即取走当前批次；决策进行中不重入 */
  private async flush(): Promise<void> {
    if (this.busy) { this.arm(); return; }
    if (!this.pending.length) return;
    const batch = this.pending.splice(0, this.pending.length);
    this.busy = true;
    try {
      await this.opts.onBatch(batch);
    } catch (err: any) {
      this.opts.onLog?.("[pm] 批次处理异常: " + String(err?.message ?? err));
    } finally {
      this.busy = false;
      if (this.pending.length) this.arm();
    }
  }

  get size(): number {
    return this.pending.length;
  }
}
