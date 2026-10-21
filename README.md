# Agent-LAN

局域网内多 agent 互相派活、协同干活。一个常驻 hub 负责连接与调度，每台机器上的
agent 用一个常驻脚本接入，人在控制台随时能看、能停、能接管。

![Agent-LAN 控制台：左侧节点卡，右侧 3D 拓扑](docs/images/console-home.png)

## 为什么不用 MCP / ACP / A2A

这三种协议各自解决的是「单次调用」和「工具暴露」，不是「一台机器上的 agent 长期在线、
随时接活、随时被人叫停」。真拿它们当连接底座，问题立刻冒出来：

- **各家支持程度不同**：workbuddy / dsh / claude code / codex 对同一套协议的实现深度
  （stdio 还是 HTTP、能否流式、错误语义、鉴权方式）差异很大，适配成本全落在协议层，
  不在业务上。
- **接入门槛高**：要能被调用，就得先改客户端协议配置、重启、走授权弹窗，
  对「临时拉一台机器进来干活」来说太重。

所以这里只用了最底层的两样东西：**普通 HTTP**，外加一个 **MCP 兼容端点**。
`probe.sh` 一行装好，`worker.sh` 常驻领活，能跑 curl 就能上报，不需要任何人工授权。

### 连接点为什么是「会话里的后台任务」

worker 不是独立 agent 进程，而是挂在你**当前对话会话**下的常驻子进程：
常驻轮询、心跳不断，领到活的那一刻由**门铃**把会话叫醒，会话里的 agent 干完再回报。

这么接的前提是宿主只有一条唤醒通道（见下文「唤醒机制」），代价是流程稳不稳
**取决于模型**：漏报开工、忘记重新武装门铃、字段写错，都会卡住或假在线。

也就是说：**人在场时体验很好，靠模型自律的地方是薄弱环节**。
hub 侧的兜底（40 秒判离线、5 分钟移出名单、同机多会话自动接管、
「worker 已退出但进程状态还挂着」会被识别成假在线）就是为了让
「模型没按规矩来」这件事看得见。

## 架构

```
hub（一台常驻服务，默认 :9600）
  ├─ 名册与心跳 presence
  ├─ 工单 + Supervisor：闸门 gate / PM / 决策流
  ├─ 控制台 UI：3D 拓扑 + SSE 实时推送
  └─ 接入面：纯 HTTP   /probe.sh  /worker.sh  /mcp  /files

机器 A                         机器 B
  worker.sh 常驻 ─────────────── worker.sh 常驻
  ↑ 会话里的 agent               ↑ 会话里的 agent
```

- **调度与通信分离**：派发权归 hub，留言/上报这类数据流直接放行
- **派发权属于 hub**：PM 只是临时持有者，人随时可以收回，人工模式是默认态
- **拦截有边界**：跨工单派新活要过闸，同工单内返工豁免

## 快速开始

要求 Node >= 20、pnpm。

```bash
pnpm install
pnpm build     # 先构建 web-console，再构建全部 packages（server 会把控制台产物拷进 dist/web）
pnpm start     # 启动 hub
```

Windows 下也可以直接跑 `start.ps1`。启动后打开 **http://localhost:9600/console** 。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MAC_PORT` | 9600 | hub 监听端口 |
| `MAC_AGENT_NAME` | `node-server` | hub 自己的节点名（`start.ps1` 里设成 `hub`） |
| `MAC_ORDERS_PATH` | 仓库根 `.orders.json` | 工单落盘文件 |
| `MAC_ROLES_PATH` | 仓库根 `.roles.json` | 角色映射落盘文件 |
| `MAC_PM_CONFIG` / `MAC_PM_MEMORY` / `MAC_PM_POLICY` | 仓库根同名文件 | PM 配置、记忆、策略 |
| `MAC_DEBUG_LOGS` | 关 | 设成 `1` 打印详细日志 |

文件通道固定存到启动目录下的 `.mac-files/`（不入库）。接入侧的 `MAC_ROOT` 是
worker 自己的概念，指它安装的根目录（默认 `~/.mac-worker`）。

## 把一台机器接进来

在**目标机器**上执行：

```bash
# 先体检：bash / curl / 目录写权限 / python(可选) / hub 连通性
curl -s --noproxy '*' http://<hub-ip>:9600/probe.sh -o probe.sh
SERVER=<hub-ip>:9600 bash probe.sh

# 一键安装（每 agent 独立目录，身份持久化）
SERVER=<hub-ip>:9600 bash probe.sh --install AGENT=dsh NAME=dev-pc-win11

# 常驻领活
bash ~/.mac-worker/dsh/worker.sh
```

装完之后：

- worker.sh **常驻轮询不退出**，领到任务或留言把完整 JSON 打到 stdout 继续轮询
- 会话侧另起一个**门铃** `bell.sh`：发现新任务/新留言即退出，由「退出」触发会话唤醒（见下一节）
- 断线自动重连；脚本版本与 hub 不一致时自动更新
- 重连永远只需同一条命令，身份从 `node.json` 读回，不用记安装参数

完整接入提示词（给对面机器的 agent 看）见 [docs/agent-onboarding.md](docs/agent-onboarding.md)。

## 唤醒机制：为什么需要门铃

agent 会话是 **pull 模型**：模型只在宿主交给它一个事件时才会开口。宿主能产生的事件只有三种
—— 用户输入、定时器、**后台子进程退出**。前两个都不由程序控制，于是「有活来了」这件事唯一
能对齐的是第三个：**让宿主托管的一个子进程退出**，宿主随即投递一条任务结束通知，会话获得新
turn。这就是「退出」为什么等于敲门。

这条链路目前没有替代品，实测依据：

- 宿主 CLI 没有向运行中会话注入消息的接口（子命令只有 `ps` / `logs` / `attach` / `kill` /
  `respawn` / `agents`，没有 `send` / `inject` / `notify`）
- hub 的 `GET /mcp` 虽然开了 SSE 下行流并保活，但**没有订阅者登记、也没有发送侧**；
  `mcp-session-id` 只发不建表 —— 客户端就算订阅也收不到东西
- 协议上 MCP 确实支持 `notifications/*` 服务端主动消息，但**消息送达客户端 ≠ 唤醒会话**：
  要不要把它变成一个 turn 是宿主策略，不是协议能力

所以这里用**门铃**补齐：一个只读 `node.json` 的小脚本，发现新任务/新留言就退出，靠「退出」
触发唤醒。它与 `worker.sh` 解耦 —— worker 继续常驻保心跳，死的是门铃，不是 worker。

```bash
# 每次处理完重新武装（这是当前形态的固有成本）
MAC_DIR=~/.mac-worker/<agent> bash ~/.mac-worker/<agent>/bell.sh
```

门铃同时兼作**静默守卫**：`node.json` 里 `state.updatedAt` 超过 120 秒没更新（说明 worker 已死）
就以 exit 3 叫醒会话去重连，不会让节点悄悄掉线。

## 后续分支：daemon 工作模式（未实现）

把执行体从「会话」换成常驻 daemon，是解决唤醒问题的另一条路 —— 不是修唤醒，而是**绕开**它：
daemon 一直在跑，任务 push 到了直接干活，根本不需要「叫醒」这一步。

```
现在（当前实现）  hub ──投递──> 会话（兼执行体）      ← 卡在「怎么叫醒会话」
分支（未实现）    hub ──push──> daemon（执行体）──> 干活 ──> 回报
                                  └─ 需要判断时才叫会话
```

要落地需要补三处：hub 侧 `GET /mcp` 登记订阅者并新增 `pushMcpNotification()`（在任务投递、
留言写入处调用）；客户端从 curl 轮询换成常驻 MCP 连接（`@mac/client` 补 SSE 订阅）；
daemon 自己要实现「检查是否有人插话」才能接受人工干预。

**没有立刻做的原因，是取舍不对等：**

| | 现在（门铃 + 会话） | daemon 分支 |
|---|---|---|
| 过程可见性 | 会话界面里逐句可见：思考、工具调用、完整输出 | **界面静止**，只有状态与结果；过程只能靠自建日志，且只能记「事先想到要记的」 |
| 响应延迟 | 2 秒级（轮询 + 唤醒） | 毫秒级 |
| 常驻可靠性 | 依赖会话活着 | 独立进程，不受会话生命周期影响 |
| 人机协同颗粒度 | 逐句（人在环，随时插话纠正） | 按任务（下单 — 等回报） |
| 适合的活型 | 判断密集、需要盯着返工 | 确定性、可批量、人插不上手 |

一句话：**daemon 化不等于放弃可观测性，前提是别让它去干需要人盯着的那类活。** 真要推进，
建议走**分层**而不是整体替换 —— daemon 负责心跳、搬运、跑构建/测试/同步这类「不想看也不必看」
的活，判断密集的活留在会话里。

## 控制台

`http://<hub-ip>:9600/console`，SSE 实时推送，不用刷新。

| 区块 | 作用 |
|---|---|
| 节点卡 | 在线状态、角色、心跳、正在处理什么、待处理留言 |
| 3D 拓扑 | 节点按主机成簇，状态走发光色；hub 常驻中心，PM 接管时调度层移到中心 |
| 工单 | 看板按状态分栏，支持母子单、依赖、附件、重新派发、取消 |
| 日志 | hub 事件流 |
| 设置 | PM 接管开关与配置、角色库、安装说明 |

3D 场景用 Three.js 渲染，材质依赖 HDRI 环境反射（`public/cc0/night.bin.exr`）；
状态色只走发光、平台用哑光深灰，否则很容易变成塑料玩具感。

## 工单与 Supervisor

工单是正式流转的载体：状态（backlog / developing / blocked / testing / done）、
处理人、依赖、timeline、附件。

把派发权交给 PM 之后：

- 跨工单派新活必须经 PM，`mac_send_task` 直接派会被拒
- 同工单返工走 `mac_rework`，不受闸门限制
- 留言与上报不受影响
- PM 连续决策失败时控制台标红，但**派发权不会自动放开**，必须人手动收回

## MCP 端点

主服务在 `POST /mcp` 暴露一组工具，是 hub 的工具面；`worker.sh` 与 `@mac/client`
都通过它注册、领活、上报。保留 MCP 形状只是为了让支持 MCP 的客户端能直接连，
它是**一种接入方式**，不是底座。

| 工具 | 作用 |
|---|---|
| `mac_check_in` | 注册 / 心跳（可带 state 与 workingOn） |
| `mac_pull_task` | 领活（长等待，最多 25s） |
| `mac_report` | 上报开工 / 完成 / 失败 / 等人工，可附产物 |
| `mac_send_task` / `mac_send_message` | 派活 / 捎话给别的节点 |
| `mac_get_task` / `mac_list_agents` / `mac_get_guide` | 查任务、看名册、拉接入说明 |
| `mac_order_*` | 工单：create / get / list / update / attach / cancel / dispatch |
| `mac_rework` | 同工单返工 |
| `mac_upload_file` / `mac_download_file` | 文件通道 |

## 包结构

| 包 | 职责 |
|---|---|
| `packages/sdk` | 统一类型（AgentCard / Task / InvokeEvent / AgentAdapter）与协议常量 |
| `packages/server` | hub：名册心跳、工单、Supervisor 闸门、MCP 门面、文件通道、静态资源 |
| `packages/client` | Node 侧接入客户端 `AgentClient` |
| `packages/app` | 可执行入口：组装 server 并启动 |
| `packages/adapter-claude` / `adapter-codex` | 本地进程适配器（stdio） |
| `web-console` | Vue 3 + Tailwind + shadcn-vue 控制台，Three.js 3D 拓扑 |

## 已知限制

- 后台任务流程的稳定性依赖模型是否按提示词执行；hub 只能事后识别（假在线、失联），
  模型不配合时无法自动纠正
- 会话空闲时**无法被外部事件主动唤醒**（宿主没有注入接口），只能靠门铃的「进程退出」间接实现。
  后果有两条：每次唤醒后都要重新武装门铃；会话不会自己「主动汇报进展」，必须有人或定时器先叫它
- 只在局域网使用，没有鉴权层，不要暴露到公网
- Windows 下建议在 Git Bash 里跑安装脚本，不要装进 WSL（会与 Windows 侧身份割裂）

## 文档

- [接入规范（给对面 agent 的提示词）](docs/agent-onboarding.md)
- [Supervisor hub 设计](docs/superpowers/specs/2026-10-19-supervisor-hub-design.md)
- [AI 工厂工单设计](docs/superpowers/specs/2026-10-15-ai-factory-orders-design.md)
