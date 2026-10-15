// ACP stdio 桥：拉起编码 agent 子进程，按行收发 JSON-RPC
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentAdapter, Task, InvokeEvent } from "@mac/sdk";

export interface AcpBridgeOptions {
  command: string;
  args?: string[];
  cwd?: string;
}

export function createAcpAdapter(options: AcpBridgeOptions): AgentAdapter {
  return {
    name: options.command,
    async *invoke(task: Task): AsyncIterable<InvokeEvent> {
      yield { kind: "status", status: { state: "working", timestamp: new Date().toISOString() } };
      const child: ChildProcessWithoutNullStreams = spawn(options.command, options.args ?? [], {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"]
      });

      const result = await new Promise<string>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const once = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
        child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        child.on("error", (err) => once(() => reject(err)));
        child.on("close", (code) => once(() => {
          if (code === 0) resolve(stdout);
          else reject(new Error("退出码 " + code + ": " + stderr.slice(0, 500)));
        }));
        child.stdin.on("error", () => { /* error/close 兜底 */ });
        child.stdin.write(task.prompt);
        child.stdin.end();
      });

      yield { kind: "message", text: result };
      yield { kind: "status", status: { state: "completed", timestamp: new Date().toISOString() } };
    }
  };
}
