# ord-fac5aba0 交付：新会话自动接入（连通性规划）

节点 dsh-PC-hake · 2026-10-16

## 问题

"只有新安装会带有安装规范，实测新开会话还是无法让 agent 正确读取到。"

根因：接入规范只在 mac_check_in 的应答里给一个 guideUrl，
**新会话根本不知道要去调它**——没有任何东西把"这台机器已接入 LAN"这件事
写进 agent 每次启动都会读的位置。于是每开一个新窗口，都要人工再喂一遍提示词。

## 方案：把规范写进 agent 的自动读取文件

安装时（probe.sh --install）自动往每个 agent「每次新会话必读」的文件追加一段
带标记的接入说明，标记块可幂等整段替换：

| agent | 写入位置 |
|---|---|
| dsh | ~/.dsh/AGENTS.md |
| workbuddy / codebuddy | ~/.workbuddy/AGENTS.md |
| 其他 | ~/.mac-worker/<agent>/AGENT.md |

写入内容（占位符按实际身份填充）：

- 本机已接入，节点名与主服务地址
- 接活方式：起 worker.sh，拿到任务/留言就退出并打印 JSON，
  上层报开工→干完→重启脚本进入下一轮
- 人工确认走 mac_report(state="input-required")，没有 request_input 工具
- 规范全文入口（curl /mcp/install.md 或 mac_get_guide）
- 上报必须带 name，否则状态不回写工单

## 为什么这样能不重复、不复杂

- **不重复**：标记块 AGENT-LAN:BEGIN/END 幂等替换，反复安装只留一份；
  agent 每次新会话自动读到，无需人工重复交代。
- **不复杂**：接入动作收敛为「起 worker.sh 并在拿到 JSON 后按三步循环」，
  细节都在自动读到的文件里，人不用背。

## 验证

- 真实安装两次：BEGIN=1 END=1、字节数不变、原有规则完整保留
- 安装不再误起 worker（见下）
- 未替换占位符残留：0

## 过程中发现并修掉的自身缺陷（重要）

首版实现用了**非引号 heredoc**（cat <<EOF），导致提示词正文里的反引号与 $() 被
shell 当命令执行：

1. 每次安装真的启动了一个无限循环的 worker —— 安装挂死；
   环境里一度堆到 9 个 dsh worker 实例互相抢任务，正是状态抖动的来源。
2. 更严重的是把 install.md 全文注入进了 ~/.dsh/AGENTS.md，污染了全局规则文件。

修法：改用引号 heredoc（<<'HINTEOF'）+ 占位符 __NAME__/__SERVER__/__DIR__ 后置替换；
正文里不再出现会被 shell 解释的构造。已恢复被污染的 AGENTS.md 并复测。

教训：往 agent 自动读取文件里写内容时，模板必须用引号 heredoc，
否则正文里的任何反引号都是一条命令。
