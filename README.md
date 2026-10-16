# Agent-LAN

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

## 连接组状态（实时）

每个节点启动后自带两个实时状态台：

| 形式 | 入口 | 说明 |
|---|---|---|
| 终端 TUI | 启动即见 | ANSI 单屏覆盖刷新（3s），● 在线 ○ 离线，底部滚动最近事件 |
| 网页控制台 | `http://localhost:<port>/console` | SSE 实时推送名册，卡片墙 + 日志流 |

### 心跳协议

- 节点每 10s 调任意节点的 `presence/heartbeat`（params.card = AgentCard）
- MCP 节点：任何 `mac_*` 工具调用都会刷新在线（含 pull 等待期间每 5s 自动续）
- 40s 无活动判离线，5 分钟无活动移出名单
- `presence/leave` 主动下线；`presence/list` 拉全量名册
- 浏览器控制台走 `GET /console/presence/stream`（SSE）

## 跨节点调用

`message/send` 的 params 支持 `target`：

- `target` = 在线节点名 → 本节点代理转发，远端执行，事件流原样回传
- `target` = 入站客户端（workbuddy/dsh）→ 任务入队，客户端长轮询领取，结果上报回传
- 不带 `target` → 本机 adapter 执行

## 文件通道

- `PUT /files/<name>` 上传，返回 `http://<局域网IP>:<port>/files/<id>-<name>`
- `GET /files/<stored>` 取回；Artifact 只存 URI 不进消息体
- 存储目录 `MAC_FILES_DIR`（默认 .mac-files）

## 入站客户端（workbuddy / dsh 接入）

```js
import { AgentClient } from "@mac/client";

new AgentClient({
  serverUrl: "http://192.168.1.1:9600",
  card: { name: "wb-echo", url: "inbound", version: "0.0.1",
          capabilities: { streaming: true, adapters: ["echo"] } },
  async *handler(task) {
    yield { kind: "message", text: "echo: " + task.prompt };
  }
}).start();
```

完整示例见 `examples/echo-agent.mjs`。客户端机制：10s 心跳（inbound 标记）+ 长轮询领任务（/agent/pull）+ 结果上报（/agent/result）。

## MCP 门面（其他机器零安装接入）

主服务暴露 Streamable HTTP MCP 端点 `/mcp`，局域网内任何 MCP client（workbuddy / dsh / claude code / codex）加一行配置即入网：

```json
{ "mcpServers": { "Agent-LAN": { "url": "http://<hub-ip>:<port>/mcp" } } }
```

| 工具 | 作用 |
|---|---|
| `mac_check_in` | 注册自己（name / description / abilities） |
| `mac_pull_task` | 领取派给自己的任务（长等待，最多 25s） |
| `mac_report` | 上报结果（文本 + 文件自动入共享区） |
| `mac_send_task` | 派任务给其他节点 |
| `mac_get_task` | 查任务状态与结果 |
| `mac_list_agents` | 列出全部节点与在线状态 |
| `mac_upload_file` / `mac_download_file` | 共享文件存取 |

给对方 agent 的接入提示词见 `docs/agent-onboarding.md`。
