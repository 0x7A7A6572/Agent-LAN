// 局域网花名册：心跳注册与在线判定，供状态台查询
import type { AgentCard, AgentPresence } from "@mac/sdk";

const OFFLINE_AFTER_MS = 15000;
const DEAD_AFTER_MS = 60000;

export class Registry {
  private agents = new Map<string, AgentPresence>();

  /** 心跳：注册或刷新某节点的在线时间；baseUrl 由连接来源推导 */
  heartbeat(card: AgentCard, baseUrl?: string | null): { reconnected: boolean } {
    const existing = this.agents.get(card.name);
    this.agents.set(card.name, {
      card,
      lastSeen: new Date().toISOString(),
      online: true,
      baseUrl: baseUrl === null ? undefined : (baseUrl ?? existing?.baseUrl)
    });
    return { reconnected: !existing?.online && !!existing };
  }

  /** 按名字查在线节点 */
  find(name: string): AgentPresence | undefined {
    this.sweep();
    return this.agents.get(name);
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
      if (age > DEAD_AFTER_MS) this.agents.delete(name);
      else if (age > OFFLINE_AFTER_MS && p.online) p.online = false;
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
