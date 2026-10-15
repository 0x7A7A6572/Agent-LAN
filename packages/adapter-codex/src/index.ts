// codex 适配器：经 ACP 桥驱动本机 codex CLI
export { createAcpAdapter } from "./acp-bridge.js";
import { createAcpAdapter } from "./acp-bridge.js";

export function createCodexAdapter(cwd?: string) {
  return createAcpAdapter({ command: "codex", args: ["exec", "-"], cwd });
}
