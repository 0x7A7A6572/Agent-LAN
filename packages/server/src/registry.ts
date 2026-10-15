// 局域网花名册：心跳注册与在线判定，供状态台查询
import type { AgentCard, AgentPresence } from "@mac/sdk";

const OFFLINE_AFTER_MS = 40000;
const DEAD_AFTER_MS = 300000;
// busy 豁免离线判定的上限，防节点崩死挂成僵尸执行中
const BUSY_MAX_MS = 7200000;

export class Registry {
  private agents = new Map<string, AgentPresence>();

  /** 心跳：注册或刷新在线；sourceIp 用于 inbound 节点的自动分组 */
  heartbeat(card: AgentCard, baseUrl?: string | null, sourceIp?: string): { reconnected: boolean } {
    const existing = this.agents.get(card.name);
    // 分组键：卡片自报 host > inbound 的来源 IP > url
    const groupHost = card.host ?? (card.url === "inbound" && sourceIp ? sourceIp : card.url);
    this.agents.set(card.name, {
      card,
      lastSeen: new Date().toISOString(),
      online: true,
      baseUrl: baseUrl === null ? undefined : (baseUrl ?? existing?.baseUrl),
      groupHost
    });
    return { reconnected: !existing?.online && !!existing };
  }

  /** 活动触达：仅刷新在线时间，不覆盖卡片 */
  touch(name: string): boolean {
    const p = this.agents.get(name);
    if (!p) return false;
    p.lastSeen = new Date().toISOString();
    p.online = true;
    return true;
  }

  /** 按名字查在线节点 */
  find(name: string): AgentPresence | undefined {
    this.sweep();
    return this.agents.get(name);
  }

  /** 执行中标记：领到任务置位，上报结果清除 */
  setBusy(name: string, on: boolean): boolean {
    const p = this.agents.get(name);
    if (!p) return false;
    p.state = on ? "working" : "idle";
    if (on) p.busySince = Date.now();
    p.lastSeen = new Date().toISOString();
    return true;
  }

  /** 标记节点主动下线 */
  leave(name: string): boolean {
    const p = this.agents.get(name);
    if (!p) return false;
    p.online = false;
    p.lastSeen = new Date().toISOString();
    return true;
  }

  /** 刷新在线状态：超过 15s 无心跳判离线，超过 60s 从名单移除 */
  sweep(): void {
    const now = Date.now();
    for (const [name, p] of this.agents) {
      const age = now - new Date(p.lastSeen).getTime();
      if (age > DEAD_AFTER_MS) { this.agents.delete(name); continue; }
      // 执行中的节点不产生心跳（worker 领活即退出），豁免离线判定
      const busyOk = p.state === "working"
        && p.busySince && now - p.busySince < BUSY_MAX_MS;
      if (!busyOk && age > OFFLINE_AFTER_MS && p.online) p.online = false;
    }
  }

  list(): AgentPresence[] {
    this.sweep();
    return [...this.agents.values()];
  }

  onlineCount(): number {
    return this.list().filter(p => p.online).length;
  }
}
