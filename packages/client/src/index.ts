// 入站客户端：让 workbuddy / dsh 宿主以一段脚本接入连接组
import type { AgentCard, InvokeEvent, Task } from "@mac/sdk";

export interface AgentClientOptions {
  /** 服务节点根地址，如 http://192.168.1.1:9600 */
  serverUrl: string;
  /** 本客户端对外能力卡 */
  card: AgentCard;
  /** 任务处理器：收到 prompt，产出一串事件（文本/文件/状态） */
  handler: (task: Task) => AsyncIterable<InvokeEvent> | Iterable<InvokeEvent>;
  /** 心跳间隔毫秒，默认 10000 */
  heartbeatMs?: number;
}

export class AgentClient {
  private stopped = false;
  private beatTimer?: ReturnType<typeof setInterval>;
  private pullLoop?: Promise<void>;

  constructor(private options: AgentClientOptions) {}

  start(): void {
    this.stopped = false;
    const ms = this.options.heartbeatMs ?? 10000;
    void this.beatOnce();
    this.beatTimer = setInterval(() => void this.beatOnce(), ms);
    this.pullLoop = this.pullForever();
  }

  stop(): void {
    this.stopped = true;
    if (this.beatTimer) clearInterval(this.beatTimer);
    void this.leave();
  }

  private async beatOnce(): Promise<void> {
    try {
      await this.rpc("presence/heartbeat", { card: this.options.card, inbound: true });
    } catch { /* 服务暂不可达，下轮再试 */ }
  }

  private async leave(): Promise<void> {
    try { await this.rpc("presence/leave", { name: this.options.card.name }); } catch {}
  }

  private async rpc(method: string, params: unknown): Promise<any> {
    const r = await fetch(this.options.serverUrl + "/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  }

  /** 长轮询领任务 → 本地执行 → 上报结果 */
  private async pullForever(): Promise<void> {
    while (!this.stopped) {
      try {
        const r = await fetch(this.options.serverUrl + "/agent/pull?name=" + encodeURIComponent(this.options.card.name), {
          signal: AbortSignal.timeout(30000)
        });
        if (r.status === 404) { await sleep(3000); continue; } // 尚未注册成功
        const { task } = await r.json();
        if (!task) continue;
        await this.runTask(task);
      } catch {
        await sleep(3000);
      }
    }
  }

  private async runTask(task: Task): Promise<void> {
    // 取消监听：执行期间每 3s 查一次任务状态，hub 取消即中止本地执行
    let canceled = false;
    const cancelWatch = setInterval(() => {
      fetch(this.options.serverUrl + "/agent/task/" + encodeURIComponent(task.id))
        .then(r => r.json() as Promise<{ state?: string }>)
        .then(j => { if (j.state === "canceled") canceled = true; })
        .catch(() => {});
    }, 3000);
    try {
      for await (const ev of this.options.handler(task)) {
        if (canceled) throw new Error("hub 已取消该任务");
        if (ev.kind === "artifact") {
          // 文件上传到服务端文件通道，消息体只留 URI
          const uri = await this.uploadFile(ev.artifact.name, (ev.artifact as any).data ?? "");
          await this.report(task.id, undefined, undefined, [{ name: ev.artifact.name, uri }]);
        } else if (ev.kind === "message") {
          if (canceled) throw new Error("hub 已取消该任务");
          await this.report(task.id, ev.text);
        } else if (ev.kind === "status" && ev.status.state !== "working") {
          await this.report(task.id, undefined, ev.status.state);
        }
      }
      await this.report(task.id, undefined, "completed");
    } catch (err) {
      await this.report(task.id, String(err), "failed");
    } finally {
      clearInterval(cancelWatch);
    }
  }

  private async report(taskId: string, text?: string, state?: string, artifacts?: { name: string; uri: string }[]): Promise<void> {
    await fetch(this.options.serverUrl + "/agent/result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId, text, state, artifacts })
    }).catch(() => {});
  }

  private async uploadFile(name: string, data: string | Buffer): Promise<string> {
    const r = await fetch(this.options.serverUrl + "/files/" + encodeURIComponent(name), {
      method: "PUT", body: data as any
    });
    const j = await r.json();
    return j.uri;
  }
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
