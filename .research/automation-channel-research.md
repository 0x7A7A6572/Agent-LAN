# 自动化通道调研结论

2026-10-19 · 分支 feat/acp-bridge

## 背景

当前只能用「会话内后台 job」驱动 worker，根本原因是没有能直接操作
workbuddy / dsh 对话的入口。本文记录对三条候选通道的实测调研。

## 结论速览

| 通道 | DSH | workbuddy | 能否解决"直接操作对话" |
|---|---|---|---|
| **ACP** | ✅ 实测可用 | ❌ 实测不可用 | DSH 侧可以，但见下方限制 |
| **A2A** | ❌ 完全没有 | ⚠️ 标准实现但受控 | 不能 |
| remote-gateway HTTP | — | ✅ 存在但需 token | 不能 |

## 一、DSH 的 ACP（唯一实测可用的通道）

### 可用能力（实测）

握手返回的能力声明：

    agentCapabilities.sessionCapabilities: { close:{}, list:{}, resume:{} }

- **session/list**：成功列出 46+ 个会话，每条带 cwd
- **session/resume**：对空闲会话成功恢复，返回完整 configOptions
- **凭据可用**：llm-deepseek-account 加载 2 个模型（V4.1-Flash / V4-Pro）
- **免 token**：走 stdio JSON-RPC

### 决定性限制

对 GUI 正在使用的会话 resume 会失败：

    session "..." is already owned by an active write handle

**并发写互斥**。这是正确的安全设计，但意味着 ACP **无法接管用户正在使用的对话**。
只能：为平台任务另建专属会话（会持久化，可在 session/list 中看到）。

### 另一个限制

    session "..." runs under agent preset "ptc",
    which the one-shot runner does not compose

`dsh headless --session-id` 无法接管 GUI 会话（preset 不兼容）。
ACP 可以，但受上面的写句柄互斥限制。

## 二、DSH 的 A2A —— 不存在

扫遍 @deepseek-ai 全部 200+ 包，**零个 a2a 实现**。
DSH 的对外通信能力只有 ACP / MCP client / SDK / webhook。

## 三、workbuddy 的两条通道都走不通

### ACP：有 flag 但不可用

`--acp` 是有效 flag（会路由到 headless bundle），但实测：

- 直接执行 → Cannot find module '../dist/codebuddy'
- 设 CODEBUDDY_FORCE_LITE_WB_BUNDLE=1 → 进程启动但 ACP 无任何响应

结论：内部路由标记，不是可用的标准 ACP 服务端。

### A2A：标准实现，但认证与开关都不受控

代码确认为完整标准协议：/.well-known/agent-card.json、
A2A-Version 1.0/0.3、标准 TASK_STATE_* 枚举。

**两个阻塞点**：

1. **认证是交互式授权，不是 token**
   A2A 调用失败时走 elicitationService.elicit() 弹授权卡片，
   没有可取出的 token 变量。用户需点一次授权。
2. **受 AB 测试开关控制**
   A2A 工具的 isEnabled 依赖 abTestService，
   且 settings.json / mcp.json 中均无 A2A agent 配置项
   （靠云端下发发现服务）。
   → 无法保证该开关对我们开放。

### remote-gateway HTTP

每个交互会话暴露 /api/v1/runs 等端点，但全部 401。
token 来自 CODEBUDDY_REMOTE_CONTROL_API_KEY / GATEWAY_PASSWORD 环境变量，
GUI 进程持有，外部进程读不到。

## 四、当前可用方案

| 方案 | 状态 |
|---|---|
| worker.sh 轮询（现有） | ✅ 可用，是当前唯一稳定通道 |
| ACP 驱动 DSH 专属会话 | ⚠️ 理论可行，需另建会话，不能接管现有对话 |
| workbuddy 直连 | ❌ 三条路全部阻塞 |

## 五、待确认事项

1. A2A 的 AB 开关是否对本机开放？（需要能看到实际下发配置）
2. 是否接受「平台任务使用 ACP 专属会话」而非接管用户对话？
3. workbuddy 侧是否维持 worker.sh 轮询（现状）？

## 六、结论

**没有找到能"直接操作现有对话"的通用入口。**

- DSH 侧 ACP 最接近，但受写句柄互斥，只能管专属会话
- workbuddy 侧全部通道阻塞
- 因此 worker.sh 轮询仍是当前唯一稳定、可用的方案
