// 入口：组装 server 与 adapter，启动 A2A 端点与控制台
import { createServer, createTui } from "@mac/server";
import { createClaudeAdapter } from "@mac/adapter-claude";
import { createCodexAdapter } from "@mac/adapter-codex";
import { createAcpAdapter } from "@mac/adapter-codex/acp-bridge";
import os from "node:os";
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
// TUI 需要名册快照：server 不直接暴露 registry，用 onLog 触发重绘 + presence/list 轮询
async function pollPresence() {
  try {
    const r = await fetch("http://127.0.0.1:" + port + "/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "presence/list" })
    }).then(r => r.json());
    presences.length = 0;
    presences.push(...(r.result?.presences ?? []));
    tui?.();
  } catch {}
}

createServer({
  card, adapter, port,
  // hub 是基础设施不是 agent，不进名册；给它派活省略 target 即本机执行
  selfRegister: false,
  onLog: line => { tui?.(line); }
}).listen(port, async () => {
  tui = createTui({ selfName: agentName, port, getPresences: () => presences });
  setInterval(pollPresence, 3000);
  await pollPresence();
  tui("控制台: http://localhost:" + port + "/console");
});
