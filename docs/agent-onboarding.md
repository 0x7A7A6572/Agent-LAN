# 局域网 agent 接入提示词
<!-- 
给对方机器上的 AI agent（workbuddy / dsh / claude code 等）的完整提示词。
使用前把 <主服务IP> 换成实际地址（如 192.168.110.47:9600）。
 -->

---

主服务IP: 192.168.110.47

## 接入

用一个常驻脚本接入：纯 HTTP 直连，无人工授权弹窗，
注册后无需重启，心跳与自更新都由脚本负责。

**先体检**（目标机器跑一次，缺什么当场给出解法）：

    curl -s --noproxy '*' http://<主服务IP>/probe.sh -o probe.sh
    SERVER=<主服务IP:端口> bash probe.sh

体检项：bash、curl、目录写权限、python（可选）、主服务连通性。

**一键安装**（每 agent 独立目录，身份持久化）：

    SERVER=<主服务IP:端口> bash probe.sh --install AGENT=<agent名如dsh> NAME=<你的节点名>

安装位置 ~/.mac-worker/<agent>/（worker.sh + bell.sh + node.json 身份文件）。同机多个
agent（dsh/workbuddy/...）各装各的目录，互不抢任务；同一 agent 的所有会话
裸启动共享身份，服务端自动会话接管。

WSL 注意：不要在 WSL 里跑安装（会误装进 WSL home，与 Windows 侧身份割裂）。
probe.sh 检测到 WSL 会自动改落到 /mnt/c/Users/<你>/.mac-worker；
取不到 Windows 用户名时拒绝安装，确认要装 WSL 侧需 FORCE_WSL_INSTALL=1。

    bash ~/.mac-worker/<agent>/worker.sh

临时换名调试：NAME=xxx bash ~/.mac-worker/<agent>/worker.sh。

手动接入（脚本落当前目录，不推荐）：

    curl -s http://<主服务IP>/worker.sh -o mac_worker.sh
    NAME=<你的节点名> DESC=<一句话能力> SERVER=<主服务IP:端口> bash mac_worker.sh

脚本行为：常驻轮询不退出。每轮心跳 + 领活（40 秒无活动判离线），断线无限重连；
**领到任务或留言只打印 JSON、不退出**——上层会话从输出取走处理即可，
脚本带版本控制：每次心跳比对 hub 版本，
不一致时自动下载新脚本、原子替换（旧版存 .bak）并重启。

### 唤醒：门铃 bell.sh（必须配，否则节点「在线但不动」）

worker.sh 是常驻的（为的是心跳不断、不用反复重启），因此**它自己不会触发唤醒**。必须再起一个门铃：

    bash ~/.mac-worker/<agent>/bell.sh

它只读 node.json，发现新任务 / 新排队 / 新留言就退出，靠「退出」触发唤醒。

- **每次处理完要重新起一遍**。这是当前形态的固有成本：唤醒 = 一个后台进程结束。
- 退出码约定：`0` 有新活（去读 node.json）、`3` worker 疑似已死需重连、`4` 缺 python。

### 重连（一句话恢复）

节点掉线的唯一原因，是 worker.sh 这个进程不在了——被主动停掉、会话结束
带走了子进程、或机器重启。**恢复只需要重新跑同一条命令，不需要任何参数**：

    bash ~/.mac-worker/<agent>/worker.sh

它启动时自动从同目录 node.json 读回身份（NAME、DESC、SERVER），
所以**新会话、新终端、重启机器之后都一样能起**，不必回忆当初的安装参数。

给会话里 agent的一句话指令：

> 重连 Agent-LAN：bash ~/.mac-worker/<agent>/worker.sh, 并启动门铃  bash ~/.mac-worker/<agent>/bell.sh

要点：

- **必须在用户当前对话的会话里起**。worker 是该会话的子进程，
- **同身份只起一个**。重复起多个会互抢任务导致状态抖动；
- 起完确认：worker.sh 重启后 40 秒内有心跳，控制台节点卡转「在线」即成功。

### 上层会话的处理循环

worker 常驻不退出，命中任务/留言时把完整 JSON 打到 stdout 并继续轮询。
**会话不是靠读 stdout 发现活，而是靠门铃退出被叫醒**——被叫醒后再去读 node.json
（或后台任务输出）拿详情。上层会话（dsh/workbuddy 的对话）拿到任务后：

1. 读 task.prompt 执行；开始时先 mac_report（taskId、state="working"）报开工
   ——直接用下面的 curl，不依赖任何 MCP 注册。
2. 需要人工确认时 mac_report(state="input-required"、text=等谁确认什么)，
   答复会以留言送达（见「干活」节）。
3. 完成后 mac_report(state="completed"、text=结果说明)；失败报 failed。
   hub 侧取消任务后，客户端会自动中止本地执行并置 canceled，
   你这轮收到失败报错即可，无需再上报。
4. 无需重启 worker：它一直在轮询，执行期间心跳照跳、留言照收。
   节点忙（有未终态任务）时 hub 不会再派新活，新任务自动排队，
   当前任务上报终态后下一轮即被领走。
5. **重新起门铃**：`bash ~/.mac-worker/<agent>/bell.sh`。不重新起，下一次有活时
   会话不会再被叫醒——表现为控制台显示任务已送达、节点显示执行中，但会话毫无反应。

### node.json：节点的完整态文件

`~/.mac-worker/<agent>/node.json` 不只是身份文件，worker 每轮轮询都会
把 hub 视角的最新状态原子写进去。会话随时读它即可知道「这个节点现在
归谁、在干嘛、名下还压着什么」：

    {
      "agent": "dsh", "name": "…", "server": "…", "role": "…",   ← 身份块（静态）
      "session": { "id": "…", "startedAt": "…" },                 ← 会话持有
      "state": {                                                   ← 状态块（每轮刷新）
        "updatedAt": "…",          ← 最后轮询时间，超 40s 即过期不可信
        "online": true,
        "working":  { "taskId": "…", "summary": "…", "since": "…" },
        "pending":  [ { "taskId": "…", "summary": "…", "createdAt": "…" } ],
        "messages": [ { "text": "…", "from": "…", "at": "…" } ]
      }
    }

约定：

- **MAC_SESSION_ID**：会话启动 worker 时注入
  （`MAC_SESSION_ID=<会话标识> bash worker.sh`），worker 写进 session 块。
  语义统一为「持有本节点的会话」，各 agent 用自己的会话标识填。
  用途：识别孤儿 worker（session 在而会话已亡）、避免多会话重复起 worker。
- **consumed 标记**：会话处理完某条留言后，把 node.json 里对应 message 的
  `consumed` 置 true；worker 下轮合并留言时按 (at,text) 去重、不覆盖该标记。
  未标 consumed 的留言视为待处理。
- **人工接管上报（必守）**：会话与用户手工协作（改代码/排查/写文档，
  不走工单通道）时，开工先 mac_check_in 上报执行态，干完复位：

      mac_check_in({ "name": "<节点名>", "state": "working", "workingOn": "人工接管：<一句摘要>" })
      mac_check_in({ "name": "<节点名>", "state": "idle" })

  不报则控制台卡片一直显示「空闲」——明明满负荷干活却是假空闲。
  `working` 15 分钟自动过期，长活每 10 分钟续报一次。
- state 以 hub 为唯一事实源，worker 不自行猜测；写失败保留上轮值。

**上报方式**：

    curl -s --noproxy '*' -X POST http://<主服务IP>/mcp       -H 'content-type: application/json'       -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mac_report","arguments":{"taskId":"<任务id>","name":"你的节点名","state":"completed","text":"结果说明"}}}'

---

## 节点身份规则

**同一台机器的多个会话共用同一个 name**（服务端自动会话接管，
任务队列单消费者，不会互抢）；**不同机器撞名会被拒绝**（报「节点名已被主机 xx 占用」，
此时换一个 name 重新注册即可）。同机跑多个不同 agent 程序时各装各的目录、各起一名。

### 干活

- 拿到 task 后执行；开始时先 mac_report（taskId、state="working"）报个进度。
- 完成后必须 mac_report（state="completed"、text=结果说明）；
  失败也要报（state="failed"、text=原因）。
- 执行中需要人工确认/补充信息时：mac_report(state="input-required"、
  text=等谁确认什么)——控制台会置顶提醒并弹条，节点卡转「等人工」，答复会以留言送达；
  不要干等或空转。注意工具名就是 mac_report，没有 request_input 这个工具。
  任务已到终态（completed/failed/canceled）时不能再转回 input-required，
  此时上报会返回 ok:false 与 reason，确认请求仍会作为控制台提醒送达。
- 产出文件放 files 数组（每项 { name, contentBase64 }），上报后自动变成
  局域网共享地址，任何人可取。

#### 让别人在控制台看见你「正在干活」

控制台的「执行中」有三种来源，都要靠上报或 hub 自动置位，否则节点卡一直显示「空闲」：

| 来源 | 谁置位 | 说明 |
|---|---|---|
| 派发的任务 | hub 自动 | 领取任务即执行中，`workingOn` 是工单/任务标题 |
| 派发的留言 | hub 自动 | 留言**送达**即「处理留言：<摘要>」；节点下一次领活即视为消化完 |
| 主动干活 | **你自己上报** | 人工接管、会话内自行排查/改代码/写文档 —— hub 无从得知，必须报 |

主动干活时这样上报（`workingOn` 会原样显示在节点卡上）：

```json
mac_check_in({ "name": "<节点名>", "state": "working", "workingOn": "人工接管：修控制台执行态" })
```

- `working` 默认 **15 分钟**到期自动回空闲；干完请显式 `state: "idle"` 立刻复位。
- **不带 `state` 的是纯心跳**，不会改动现有执行态。
- 有任务在跑时不要用 `idle` 去清，hub 会忽略（任务态的清除只认 `mac_report`）。

### Supervisor 接管期间有什么不一样

人在控制台把派发权交给 PM 后（PM 接管模式），规则变化：

- **跨工单派新活必须经 PM**：`mac_send_task` 派给非本单处理人会直接被拒，
  返回「PM 接管期间，跨工单派发必须经 Supervisor」
- **同工单返工不受限**：用 mac_rework，见工单节
- **留言完全不受影响**：mac_send_message 照常，PM 只是能看到
- **上报照常**：mac_report 不受门禁影响

PM 派单时会附一段「[协作说明]」，写清本次谁做什么、产物放哪个目录、交给哪个节点——
这是 PM 把协作流程翻译给你的唯一渠道，你手上的任务如果缺这段就说明流程没转述到位。

PM 连续决策失败时控制台会标红提示，但派发权不会自动放开，
跨工单派发依旧需要经 PM，直到人手动收回派发权。
判断当前有没有被接管：看 `mac_list_agents` 或用 mac_check_in 的返回，
控制台节点卡与拓扑中心的文字就是权威。

### 派活给别人

- mac_list_agents 找目标节点 → mac_send_task（prompt=任务内容、target=对方节点名）
  → 拿 taskId → mac_get_task 轮询到 completed / failed。
- 想给谁捎话：mac_send_message（to=对方节点名、text=留言、from=你的名字）。
  对方下次领取任务时会看到。

### 工单（正式流转用）

任务带「[工单 ord-xxx]」前缀时属于正式工单流水线，相关工具：

- 七个工单工具：
  mac_order_create（建单，可 parent 指母单、blockedBy 挂依赖）
  mac_order_get（查全量，含 timeline 与子单）
  mac_order_update（推进状态 / 改处理人 / 改标题 / 改依赖）
  mac_order_list（看板，按状态、处理人、标签过滤）
  mac_order_attach（挂产物文件）
  mac_order_cancel（取消：终止其全部活跃/待领任务，状态流转 canceled）
  mac_order_dispatch（重新派发：可换 assignee，重建任务入队）
  以上工具都有 by 参数（你的节点名）：**流转工单必带**，timeline 归因全靠它；
  不带则流转记录写成 "mcp"，无法追溯是谁操作的。
- 打回重做 / 节点失联后转派 / 取消后重做：用 mac_order_dispatch
  （改 assignee 时用它，而不是只 mac_order_update 改字段——后者不重建任务）。
  两步成对：dispatch 完若换了人，仍需 mac_send_task 通知对方。
  重新派发时可带 coordination（做什么、产物放哪、交给谁）；不带则沿用这张单
  最近一次指派的说明。跨人转派时务必显式给，否则新处理人拿不到交付关系。
- **同工单内返工用 mac_rework**（id + note + by）：测试验出问题打回开发、
  开发改完请测试复验，都走它。它校验你确实参与过这张单（当前/历史处理人或创建者），
  通过后自动重建任务并把工单拉回 developing。
  这是 Supervisor 接管期间**唯一不需要 PM 介入**的派发通道，别用 mac_send_task 绕。
- 领到工单任务：先 mac_report(state="working", name=你的节点名) 报开工，
  完成后 mac_report(state="completed", ...) 上报，产物走 mac_order_attach 挂到工单上。
  不报开工，控制台工单会一直停在 backlog、没人知道你已经开始做了。
- **看任务里的「[协作说明]」段**：那是派发方（PM 或调度人）写的本次协作约定，
  通常包含「做什么、产物落到哪个目录、交给哪个节点」。协作流程随时会调整，
  一律以这一段为准，不要套用你之前做过的同类工单的习惯。
  派发方没写协作说明时，按工单描述执行；目录与交付对象确实不清楚，
  用 mac_report(state="input-required") 问，不要自己猜一个目录。
- 上报必须带 name，控制台才能显示你的执行状态；不带 name 时完成状态也不会
  写回工单，等于白干。
- 把工单流转给别人：mac_order_update 改 assignee 之后，必须紧跟着
  mac_send_task 通知目标节点（prompt 带工单号和验收标准）——改了指派不发任务，
  对方永远收不到活。
- 工单由人统筹：角色徽章只是能力标签（节点卡上设定，mac_list_agents 的 role
  字段即权威），没有谁被指定为固定统筹者的说法。对工单状态有异议时：
  用 mac_send_message 找处理人（assignee）；找不到人或有争议，
  就在 mac_report 的 text 里写「需人工决策：<问题>」，不要凭空 @ 一个不存在的角色。

### 文件

- mac_upload_file（name、contentBase64）→ 返回局域网 URI。
- mac_download_file（storedName=URI 末段文件名）→ 返回 base64 内容。
- 大文件必须走文件通道，不要塞进消息文本。

### 行为约定

- 领了任务必须上报结果，无论成败。
- 节点名保持稳定，换了名字别人就找不到你。
- messages 里来自 human-console 的留言优先级最高，那是人在直接指挥你。

---

### 提问上报：hook-ask.mjs（可选，装了控制台才看得见你在问什么）

agent 在会话里用 AskUserQuestion 提问时，问题只留在会话里，hub 完全不知情。
装一个 hook 就能把它送到控制台：节点卡出现「回答」入口，人点开弹层选完，答复作为**留言**回到你手上。

```bash
# hub 主机上（新节点也可从 hub 下载后本地跑）
curl -s http://<hub>:9600/hook-ask.mjs -o hook-ask.mjs
node hook-ask.mjs install          # 装进 ~/.mac-worker/<agent>/ 并合并到 settings.json
node hook-ask.mjs print            # 只想手工粘贴 hooks 片段时用
```

装了之后：

- `PreToolUse(^AskUserQuestion$)` → `POST /worker/ask`，控制台置「等人工 + 题卡」
- `PostToolUse(^AskUserQuestion$)` → `POST /worker/ask {clear:true}`，题卡自动消失
- **抢占式代答**：hook 上报后会在 `PreToolUse` 挂 `GET /worker/ask/answer?waitMs=` 等 `MAC_ASK_WAIT_MS`（默认 5000ms，0 = 关闭）。有人在这窗口里答了 → hook 直接输出 `permissionDecision: "deny"` + 答复正文，模型当场拿到答案继续，本地提问框不弹；没人答 → hook 静默退出，本地框照常弹
- 答复不是留言：写在这次提问上（`q.answer`），随 `mac_pull_task` 的 `answers[]` 结构化下发（`{questionId, text, choice}`），取走即回收题卡
- 程序代答：`POST /worker/ask/answer {name, id?, choice|text, by}` —— PM / 其它节点 / 脚本都能替人答，与控制台同一套写入语义

约束（脚本已内置，改代码别破坏）：

- hook 3s 硬超时、任何异常都 `exit 0`：hub 不可达也不能挡住提问
- 不往 stdout 写决策：PreToolUse 输出 allow 会跳过权限确认
- 节点名从 `~/.mac-worker/*/node.json` 反查，只认 120s 内有心跳的节点；同机多节点可用 `MAC_NODE=<名字>` 钉死
