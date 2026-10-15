# multi-agent-connect

LAN 内多 agent 互调服务。架构（已定，存于记忆库）：

```
┌─────────────────────────────────────────────┐
│  跨机器层  A2A (HTTP, JSON-RPC + SSE)        │
│  Agent Card 发现 · Task 状态机 · Artifact 文件│
├─────────────────────────────────────────────┤
│  本机适配层  每台机器一个 adapter 进程        │
│  workbuddy → 原生 HTTP 接入                  │
│  dsh        → 原生 HTTP 接入                 │
│  codex      → ACP/stdio 桥接 → 统一 Agent 接口│
│  claude     → ACP/stdio 桥接 → 统一 Agent 接口│
└─────────────────────────────────────────────┘
```

## 包结构

| 包 | 职责 |
|---|---|
| `packages/sdk` | 统一类型（AgentCard / Task / InvokeEvent / AgentAdapter）与协议常量 |
| `packages/server` | A2A server：Agent Card 发现、message/send、task 状态流（SSE）、Registry |
| `packages/adapter-claude` | claude code 的 ACP stdio 桥适配器 |
| `packages/adapter-codex` | codex 的 ACP stdio 桥适配器 |
| `packages/app` | 可执行入口：server + adapter 组装启动 |

## 快速开始

```bash
pnpm install
pnpm build
MAC_AGENT_NAME=node-1 MAC_ADAPTER=claude MAC_PORT=9600 pnpm --filter @mac/app start
```

环境变量：`MAC_PORT`（默认 9600）、`MAC_AGENT_NAME`（节点名）、`MAC_ADAPTER`（claude | codex）。
