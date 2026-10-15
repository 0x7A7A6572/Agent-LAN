// 局域网花名册：心跳注册与在线判定，供状态台查询
// 名单持久化：节点一旦注册便保留，直到控制台手动删除
import fs from "node:fs";
import type { AgentCard, AgentPresence } from "@mac/sdk";

const OFFLINE_AFTER_MS = 40000;
// busy 豁免离线判定的上限，防节点崩死挂成僵尸执行中
const BUSY_MAX_MS = 7200000;
// 持久化字段：运行态（state/busy/workingOn）不落盘，重启不残留僵尸执行中
type Persisted = Pick<AgentPresence, "card" | "lastSeen" | "online" | "baseUrl" | "groupHost">;

export class Registry {
  private agents = new Map<string, AgentPresence>();
  private saveTimer?: NodeJS.Timeout;

  constructor(private filePath?: string) {
    if (!filePath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Persisted[];
      for (const p of raw) this.agents.set(p.card.name, { ...p, online: false });
    } catch { /* 首次启动无文件 */ }
  }

  private save(): void {
    if (!this.filePath) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.writeNow();
    }, 500);
    this.saveTimer.unref?.();
  }

  private writeNow(): void {
    const arr = [...this.agents.values()].map(p => ({
      card: p.card, lastSeen: p.lastSeen, online: p.online,
      baseUrl: p.baseUrl, groupHost: p.groupHost
    }));
    try { fs.writeFileSync(this.filePath!, JSON.stringify(arr, null, 2)); }
    catch { /* 落盘失败下次变更重试 */ }
  }

  /** 退出前同步落盘，防尾写丢失 */
  flushNow(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.writeNow();
  }

  /** 控制台手动删除节点记录，返回是否删到 */
  remove(name: string): boolean {
    const ok = this.agents.delete(name);
    if (ok) this.save();
    return ok;
  }

  /** 心跳：注册或刷新在线；sourceIp 用于 inbound 节点的自动分组 */
  heartbeat(card: AgentCard, baseUrl?: string | null, sourceIp?: string): { reconnected: boolean; conflict?: string } {
    const existing = this.agents.get(card.name);
    // 分组键：卡片自报 host > inbound 的来源 IP > url
    const groupHost = card.host ?? (card.url === "inbound" && sourceIp ? sourceIp : card.url);
    // 异机撞名拒绝：同名但主机标识不同 = 两个程序抢同一身份，任务会互抢
    if (existing && existing.groupHost !== groupHost) {
      return { reconnected: false, conflict: existing.groupHost };
    }
    // 执行态由 setBusy/report 管理，心跳整卡覆盖不得抹掉，否则伴生心跳一打就变空闲
    this.agents.set(card.name, {
      card,
      lastSeen: new Date().toISOString(),
      online: true,
      baseUrl: baseUrl === null ? undefined : (baseUrl ?? existing?.baseUrl),
      groupHost,
      state: existing?.state,
      workingOn: existing?.workingOn,
      busySince: existing?.busySince
    });
    if (!existing) this.save();
    return { reconnected: !existing?.online && !!existing };
  }

  /** 活动触达：仅刷新在线时间，不覆盖卡片；mcp=true 时同时记 MCP 活跃时刻 */
  touch(name: string, mcp = false): boolean {
    const p = this.agents.get(name);
    if (!p) return false;
    p.lastSeen = new Date().toISOString();
    p.online = true;
    if (mcp) p.lastMcp = new Date().toISOString();
    return true;
  }

  /** 按名字查在线节点 */
  find(name: string): AgentPresence | undefined {
    this.sweep();
    return this.agents.get(name);
  }

  /** 执行中标记：领到任务置位，上报结果清除；workingOn 为正在做的工单描述 */
  setBusy(name: string, on: boolean, workingOn?: string): boolean {
    const p = this.agents.get(name);
    if (!p) return false;
    p.state = on ? "working" : "idle";
    p.workingOn = on ? (workingOn ?? p.workingOn) : undefined;
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

  /** 刷新在线状态：超时仅判离线，不删名单，删除走控制台手动 */
  sweep(): void {
    const now = Date.now();
    for (const p of this.agents.values()) {
      const age = now - new Date(p.lastSeen).getTime();
      // 执行中的节点不产生心跳（worker 领活即退出），豁免离线判定
      const busyOk = p.state === "working"
        && p.busySince && now - p.busySince < BUSY_MAX_MS;
      if (!busyOk && age > OFFLINE_AFTER_MS && p.online) {
        p.online = false;
        this.save();
      }
    }
  }

  list(): AgentPresence[] {
    this.sweep();
    // MCP 活跃判定：90s 内有 mac_pull_task 类调用；仅心跳无 MCP = worker 在跳、agent 会话已不在
    const now = Date.now();
    return [...this.agents.values()].map(p => ({
      ...p,
      mcpActive: !!p.lastMcp && now - new Date(p.lastMcp).getTime() < 90000
    }));
  }

  onlineCount(): number {
    return this.list().filter(p => p.online).length;
  }
}
