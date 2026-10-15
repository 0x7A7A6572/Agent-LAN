// 入口：组装 server 与 adapter，启动 A2A 端点
import { createServer } from "@mac/server";
import { createClaudeAdapter } from "@mac/adapter-claude";
import { createCodexAdapter } from "@mac/adapter-codex";
import { createAcpAdapter } from "@mac/adapter-codex/acp-bridge";
import type { AgentAdapter, AgentCard } from "@mac/sdk";

const port = Number(process.env.MAC_PORT ?? 9600);
const agentName = process.env.MAC_AGENT_NAME ?? "node-1";
const adapterKind = process.env.MAC_ADAPTER ?? "claude";

const adapters: Record<string, () => AgentAdapter> = {
  claude: () => createClaudeAdapter(process.cwd()),
  codex: () => createCodexAdapter(process.cwd()),
  // 自定义命令：MAC_ADAPTER_CMD=node MAC_ADAPTER_ARGS=fake-agent.cjs
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
  capabilities: { streaming: true, adapters: [adapterKind] }
};

createServer({ card, adapter, port }).listen(port, () => {
  console.log("[" + agentName + "] A2A endpoint: http://0.0.0.0:" + port);
  console.log("  agent card: http://0.0.0.0:" + port + "/.well-known/agent-card.json");
});
