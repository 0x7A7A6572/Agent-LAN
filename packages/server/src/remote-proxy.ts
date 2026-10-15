// 远端代理：把本节点收到的任务转发给另一节点执行，事件流原样回传
import type { AgentAdapter, Task, InvokeEvent } from "@mac/sdk";

export interface RemoteProxyOptions {
  /** 目标节点根地址，如 http://192.168.1.2:9600 */
  baseUrl: string;
  /** 目标节点名，仅用于标识 */
  targetName: string;
}

export function createRemoteProxy(options: RemoteProxyOptions): AgentAdapter {
  return {
    name: "proxy:" + options.targetName,
    async *invoke(task: Task): AsyncIterable<InvokeEvent> {
      const rpc = await fetch(options.baseUrl + "/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "message/send",
          params: { prompt: task.prompt }
        })
      }).then(r => r.json());
      if (rpc.error) throw new Error("远端拒绝: " + rpc.error.message);
      const remoteTaskId: string = rpc.result.task.id;

      // 订阅远端 SSE，转发事件直到终态
      const controller = new AbortController();
      try {
        const res = await fetch(options.baseUrl + "/tasks/" + remoteTaskId + "/stream", {
          signal: controller.signal
        });
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let done = false;
        while (!done) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) break;
          buf += decoder.decode(value);
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (!frame.startsWith("data: ")) continue;
            const ev = JSON.parse(frame.slice(6)) as InvokeEvent;
            if (ev.kind === "status" && ["completed", "failed", "canceled"].includes(ev.status.state)) {
              done = true;
              controller.abort();
            }
            yield ev;
          }
        }
      } finally {
        controller.abort();
      }
    }
  };
}
