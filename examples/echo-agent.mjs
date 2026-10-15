// workbuddy / dsh 宿主接入示例：回声 agent
// 用法：SERVER_URL=http://192.168.1.1:9600 node examples/echo-agent.mjs
// 宿主侧只需把 handler 换成自己的能力实现
import { AgentClient } from "../packages/client/dist/index.js";

const serverUrl = process.env.SERVER_URL ?? "http://127.0.0.1:9600";

const client = new AgentClient({
  serverUrl,
  card: {
    name: process.env.AGENT_NAME ?? "echo-agent",
    description: "示例：收到什么回什么",
    url: "inbound",  // 入站客户端没有自己的监听地址
    version: "0.0.1",
    capabilities: { streaming: true, adapters: ["echo"] }
  },
  async *handler(task) {
    yield { kind: "status", status: { state: "working", timestamp: new Date().toISOString() } };
    yield { kind: "message", text: "echo: " + task.prompt };
  }
});

client.start();
console.log("[" + (process.env.AGENT_NAME ?? "echo-agent") + "] 已接入 " + serverUrl + "，Ctrl+C 退出");
process.on("SIGINT", () => { client.stop(); process.exit(0); });
