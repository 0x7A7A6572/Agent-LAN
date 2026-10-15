// claude code 适配器：经 ACP 桥驱动本机 claude CLI
export { createAcpAdapter } from "./acp-bridge.js";
import { createAcpAdapter } from "./acp-bridge.js";

export function createClaudeAdapter(cwd?: string) {
  return createAcpAdapter({ command: "claude", args: ["--print"], cwd });
}
