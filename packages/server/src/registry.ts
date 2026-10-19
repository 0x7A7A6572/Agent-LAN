// 局域网花名册：心跳注册与在线判定，供状态台查询
// 名单持久化：节点一旦注册便保留，直到控制台手动删除
import fs from "node:fs";
import os from "node:os";
import type { AgentCard, AgentPresence } from "@mac/sdk";

const OFFLINE_AFTER_MS = 40000;
// 本机身份表（主机名 + 各网卡地址）：来源 IP 与自报主机名天然不可比，靠它认定同机
let LOCAL_KEYS: Set<string> | undefined;
function localHostKeys(): Set<string> {
  if (!LOCAL_KEYS) {
    const keys = new Set<string>(["localhost", "::1", "127.0.0.1"]);
    keys.add(os.hostname().toLowerCase());
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) keys.add(ni.address.toLowerCase());
    }
    LOCAL_KEYS = keys;
  }
  return LOCAL_KEYS;
}
// busy 豁免离线判定的上限，防节点崩死挂成僵尸执行中
const BUSY_MAX_MS = 7200000;
// 持久化字段：运行态（state/busy/workingOn）不落盘，重启不残留僵尸执行中
type Persisted = Pick<AgentPresence, "card" | "lastSeen" | "online" | "baseUrl" | "groupHost" | "sourceIp">;

export class Registry {
  private agents = new Map<string, AgentPresence>();
  private saveTimer?: NodeJS.Timeout;
  /** 在线状态翻转回调：Supervisor 靠它感知节点上下线 */
  onPresenceChange?: (name: string, online: boolean) => void;

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
      baseUrl: p.baseUrl, groupHost: p.groupHost,
      sourceIp: p.sourceIp
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
    let groupHost = card.host ?? (card.url === "inbound" && sourceIp ? sourceIp : card.url);
    // 同名双口径归并：注册带 host（MCP 手传/worker hostname）与不带（走来源 IP）混用时，
    // 以首次绑定为准；来源 IP 与已绑主机同段或同机即视为同一主机，不误判撞名
    if (existing && existing.groupHost !== groupHost) {
      // 同一节点可能带 host（worker 自报主机名）与不带（退化成来源 IP）两种口径交替注册。
      // 主机名与 IP 不可直接比较，若只做字符串比对，二者会互判异机、每轮心跳刷「撞名」。
      // 判据：任一侧属于本机身份表即同一主机；归并后一律沿用首次绑定，避免口径来回翻转。
      const local = localHostKeys();
      const bound = String(existing.groupHost).toLowerCase();
      const now = String(groupHost).toLowerCase();
      // 来源 IP 是权威依据：同一来源即同一主机，与自报 host 是否带无关
      const sameSource = !!sourceIp && !!existing.sourceIp && existing.sourceIp === sourceIp;
      const sameMachine = bound === now || local.has(bound) || local.has(now) || sameSource;
      if (!sameMachine) {
        return { reconnected: false, conflict: existing.groupHost };
      }
      groupHost = existing.groupHost;
    }
    // 执行态由 setBusy/report 管理，心跳整卡覆盖不得抹掉，否则伴生心跳一打就变空闲
    this.agents.set(card.name, {
      card,
      lastSeen: new Date().toISOString(),
      online: true,
      baseUrl: baseUrl === null ? undefined : (baseUrl ?? existing?.baseUrl),
      groupHost,
      agent: (card as AgentCard & { agent?: string }).agent ?? existing?.agent,
      state: existing?.state,
      workingOn: existing?.workingOn,
      waitingFor: existing?.waitingFor,
      busySince: existing?.busySince,
      busyKind: existing?.busyKind,
      busyUntil: existing?.busyUntil,
      sourceIp: sourceIp ?? existing?.sourceIp
    });
    if (!existing) {
      this.save();
      this.onPresenceChange?.(card.name, true);
    } else if (!existing.online) {
      // 离线节点重新上线也要通知，Supervisor 靠它恢复派发
      this.onPresenceChange?.(card.name, true);
    }
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

  /**
   * 执行中标记：领到任务/收到留言/节点主动上报时置位，上报结果或到期后清除。
   * @param workingOn 正在做什么（控制台直接展示）
   * @param kind      执行态来源（task/message/agent），缺省沿用原值
   * @param ttlMs     有效期毫秒；给了就到期自动回空闲，不给则沿用 busySince + BUSY_MAX_MS
   */
  setBusy(name: string, on: boolean, workingOn?: string, kind?: "task" | "message" | "agent", ttlMs?: number): boolean {
    const p = this.agents.get(name);
    if (!p) return false;
    p.state = on ? "working" : "idle";
    p.workingOn = on ? (workingOn ?? p.workingOn) : undefined;
    p.waitingFor = on ? p.waitingFor : undefined;
    p.busyKind = on ? (kind ?? p.busyKind ?? "task") : undefined;
    p.busyUntil = on && ttlMs ? Date.now() + ttlMs : undefined;
    if (on) p.busySince = Date.now();
    p.lastSeen = new Date().toISOString();
    return true;
  }

  /** 当前执行态来源（无则 undefined），领活时据此判断「留言已消化完」 */
  busyKindOf(name: string): "task" | "message" | "agent" | undefined {
    return this.agents.get(name)?.busyKind;
  }

  /** 等待人工确认：置 waitingFor，控制台据此提示；传空串清除 */
  setWaiting(name: string, waitingFor?: string): boolean {
    const p = this.agents.get(name);
    if (!p) return false;
    p.waitingFor = waitingFor && waitingFor.trim() ? waitingFor.trim() : undefined;
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
      // 带有效期的执行态（留言消化 / 主动上报）：到期自动回空闲，防节点不回报就一直挂「执行中」
      if (p.state === "working" && p.busyUntil && now >= p.busyUntil) {
        p.state = "idle";
        p.workingOn = undefined;
        p.busyKind = undefined;
        p.busyUntil = undefined;
        p.busySince = undefined;
      }
      const age = now - new Date(p.lastSeen).getTime();
      // 执行中的节点不产生心跳（worker 领活即退出），豁免离线判定
      const busyOk = p.state === "working"
        && p.busySince && now - p.busySince < BUSY_MAX_MS;
      if (!busyOk && age > OFFLINE_AFTER_MS && p.online) {
        p.online = false;
        this.save();
        this.onPresenceChange?.(p.card.name, false);
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
