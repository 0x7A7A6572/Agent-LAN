// 入口：组装 server 与 adapter，启动 A2A 端点与控制台
import { createServer, createTui } from "@mac/server";
import { createClaudeAdapter } from "@mac/adapter-claude";
import { createCodexAdapter } from "@mac/adapter-codex";
import { createAcpAdapter } from "@mac/adapter-codex/acp-bridge";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentAdapter, AgentCard, AgentPresence } from "@mac/sdk";

const port = Number(process.env.MAC_PORT ?? 9600);
const agentName = process.env.MAC_AGENT_NAME ?? "node-1";
const adapterKind = process.env.MAC_ADAPTER ?? "claude";

const adapters: Record<string, () => AgentAdapter> = {
  claude: () => createClaudeAdapter(process.cwd()),
  codex: () => createCodexAdapter(process.cwd()),
  custom: () => createAcpAdapter({
    command: process.env.MAC_ADAPTER_CMD ?? "node",
    args: (process.env.MAC_ADAPTER_ARGS ?? "").split(" ").filter(Boolean),
    cwd: process.cwd()
  })
};

const adapter = adapters[adapterKind]?.() ?? adapters.claude();

const card: AgentCard = {
  name: agentName,
  description: "multi-agent-connect 节点 (" + adapterKind + ")",
  url: "http://0.0.0.0:" + port,
  version: "0.0.1",
  host: os.hostname(),
  capabilities: { streaming: true, adapters: [adapterKind] }
};

let tui: ((line?: string) => void) | undefined;
const presences: AgentPresence[] = [];
let lastPresenceSig = "";
let lastLineCache: string | undefined;
// TUI 名册快照：轮询 presence/list，指纹变化才重绘；日志不再触发刷屏
async function pollPresence() {
  try {
    const r = await fetch("http://127.0.0.1:" + port + "/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "presence/list" })
    }).then(r => r.json());
    const next = r.result?.presences ?? [];
    const sig = next.map((p: AgentPresence) => [p.card.name, p.online, p.state ?? "", p.workingOn ?? ""].join("|")).join(";");
    if (sig === lastPresenceSig) return;
    lastPresenceSig = sig;
    presences.length = 0;
    presences.push(...next);
    tui?.();
  } catch {}
}

createServer({
  card, adapter, port,
  // hub 是基础设施不是 agent，不进名册；给它派活省略 target 即本机执行
  selfRegister: false,
  debugLogs: process.env.MAC_DEBUG_LOGS === "1",
  // 数据落盘固定仓库根（与启动 cwd 解耦），可用 env 重定向
  ordersPath: process.env.MAC_ORDERS_PATH ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".orders.json"),
  rolesPath: process.env.MAC_ROLES_PATH ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".roles.json"),
  // 日志只写底部单行缓存，不触发 TUI 重绘（消刷屏）
  onLog: line => { lastLineCache = line; }
}).listen(port, async () => {
  tui = createTui({ selfName: agentName, port, getPresences: () => presences });
  setInterval(pollPresence, 3000);
  await pollPresence();
  tui(lastLineCache ?? "控制台: http://localhost:" + port + "/console");
});
