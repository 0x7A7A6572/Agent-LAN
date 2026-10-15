// 终端状态台：单行覆盖刷新，显示在线节点与最近事件
import type { AgentPresence } from "@mac/sdk";

export interface TuiState {
  selfName: string;
  port: number;
  getPresences: () => AgentPresence[];
}

const CLEAR = "\x1b[2J\x1b[H";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const GRAY = "\x1b[90m";
const RESET = "\x1b[0m";

export function createTui(state: TuiState): (line?: string) => void {
  let lastLine = "";
  const render = () => {
    const presences = state.getPresences();
    const online = presences.filter(p => p.online);
    const rows: string[] = [];
    rows.push(CLEAR);
    rows.push("multi-agent-connect · " + state.selfName + " · :" + state.port);
    rows.push("─".repeat(46));
    rows.push("在线 " + online.length + " / 已知 " + presences.length);
    rows.push("");
    // 按主机分组展示：同机多 agent 归到一台主机名下
    const groups = new Map<string, AgentPresence[]>();
    for (const p of presences) {
      const h = p.groupHost ?? p.card.host ?? p.card.url;
      if (!groups.has(h)) groups.set(h, []);
      groups.get(h)!.push(p);
    }
    let firstGroup = true;
    for (const [host, members] of groups) {
      if (!firstGroup) rows.push("");
      firstGroup = false;
      const anyOn = members.some(p => p.online);
      rows.push((anyOn ? GREEN : GRAY) + "▣ " + host + RESET + DIM + "  (" + members.filter(p => p.online).length + "/" + members.length + " 在线)" + RESET);
      for (const p of members) {
        const mark = p.online ? GREEN + "  ├ ●" : GRAY + "  ├ ○";
        const time = new Date(p.lastSeen).toLocaleTimeString("zh-CN", { hour12: false });
        rows.push(mark + " " + p.card.name.padEnd(12) + DIM + p.card.description?.slice(0, 40) + "  " + time + RESET);
      }
    }
    if (presences.length === 0) rows.push(DIM + "（暂无其他节点接入）" + RESET);
    rows.push("");
    rows.push("─".repeat(46));
    if (lastLine) rows.push(DIM + lastLine + RESET);
    process.stdout.write(rows.join("\n") + "\n");
  };
  // 每 3s 重绘（节点离线/上线由事件与 sweep 驱动，轮询兜底）
  const timer = setInterval(render, 3000);
  timer.unref?.();
  return (line) => {
    if (line) lastLine = line;
    render();
  };
}
