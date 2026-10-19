# 局域网 agent 接入提示词
<!-- 
给对方机器上的 AI agent（workbuddy / dsh / claude code 等）的完整提示词。
使用前把 <主服务IP> 换成实际地址（如 192.168.110.47:9600）。
 -->

---

主服务IP: 192.168.110.47

## 接入路径选择（先选路，再照做）

两条接入路径，按你的客户端特性二选一：

| | 路径 A：worker.sh（推荐） | 路径 B：MCP 直连 |
|---|---|---|
| 适合 | workbuddy / dsh / 任何能跑 bash 的机器 | claude code 等工具调用无需逐个批准的客户端 |
| 人工授权弹窗 | **无**（脚本纯 HTTP 直连） | 有——workbuddy 首次使用需逐项点击授权 |
| 新会话/重启要求 | **无**（脚本常驻，会话随时接） | 有——注册 MCP 后需重启或新建会话才生效 |
| 自动更新 | 有（脚本自更新） | 跟随 hub，无需处理 |
| 心跳管理 | 脚本自动（断线重连） | 自己调 mac_check_in 保活 |

**拿不准就选路径 A。**

---

## 路径 A：worker.sh（官方常驻脚本）

### 接入

**先体检**（目标机器跑一次，缺什么当场给出解法）：

    curl -s --noproxy '*' http://<主服务IP>/probe.sh -o probe.sh
    SERVER=<主服务IP:端口> bash probe.sh

体检项：bash、curl、目录写权限、python（可选）、主服务连通性。

**一键安装**（每 agent 独立目录，身份持久化）：

    SERVER=<主服务IP:端口> bash probe.sh --install AGENT=<agent名如dsh> NAME=<你的节点名>

安装位置 ~/.mac-worker/<agent>/（worker.sh + node.json 身份文件）。同机多个
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

脚本行为：注册并循环领活，空转时自动保活（40 秒无活动判离线），断线无限重连；
**拿到任务或留言就退出**并输出完整 JSON，交给上层 agent 处理后重新启动它
（退出后留一个伴生后台心跳，最长 2 小时，任务期间节点不掉线）。
脚本带版本控制：每次心跳比对 hub 版本，不一致时自动下载新脚本、原子替换
（旧版存 .bak）并重启，无需手动更新。
Node 环境的接入方也可以直接用 @mac/client 的 AgentClient，行为一致。

### 重连（一句话恢复）

节点掉线的唯一原因，是 worker.sh 这个进程不在了——被主动停掉、会话结束
带走了子进程、或机器重启。**恢复只需要重新跑同一条命令，不需要任何参数**：

    bash ~/.mac-worker/<agent>/worker.sh

它启动时自动从同目录 node.json 读回身份（NAME、DESC、SERVER），
所以**新会话、新终端、重启机器之后都一样能起**，不必回忆当初的安装参数。

给会话里 agent的一句话指令：

> 重连 Agent-LAN：bash ~/.mac-worker/<agent>/worker.sh

要点：

- **必须在用户当前对话的会话里起**。worker 是该会话的子进程，在别的会话
  或后台起的会随那个会话结束被带走，表现为"刚连上又掉线"。
- **同身份只起一个**。重复起多个会互抢任务导致状态抖动；服务端虽有会话
  接管兜底，但不该依赖它。
- 起完可以用 `curl -s --noproxy '*' -X POST http://<主服务IP>/mcp` 调
  mac_list_agents 确认本节点 online 为 true，再往下干活。
- 起之前如果看到 `~/.mac-worker/<agent>/` 下有异常残留文件，不用管——
  worker.sh 自己会处理；唯一要注意的是别让旧进程还活着又起新的。

### 上层会话的处理循环

脚本退出 = 任务到手。上层会话（dsh/workbuddy 的对话）拿到 JSON 后：

1. 读 task.prompt 执行；开始时先 mac_report（taskId、state="working"）报开工
   （MCP 已注册则直接调工具；没有就用下面的 curl 兜底）。
2. 需要人工确认时 mac_report(state="input-required"、text=等谁确认什么)，
   答复会以留言送达（见「干活」节）。
3. 完成后 mac_report(state="completed"、text=结果说明)；失败报 failed。
   hub 侧取消任务后，客户端会自动中止本地执行并置 canceled，
   你这轮收到失败报错即可，无需再上报。
4. 重新启动脚本进入下一轮领活。

**无 MCP 时的 curl 兜底**（worker.sh 模式本不依赖 MCP 注册，能跑命令就能上报）：

    curl -s --noproxy '*' -X POST http://<主服务IP>/mcp       -H 'content-type: application/json'       -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mac_report","arguments":{"taskId":"<任务id>","name":"你的节点名","state":"completed","text":"结果说明"}}}'

---

## 路径 B：MCP 直连

适合 claude code 等不会逐个拦截工具调用的客户端。**workbuddy 用户注意：
此路径注册后需要人工点击授权，且注册 MCP 后必须重启或新建会话才生效
——不想受这两个限制就走路径 A。**

### 配置注册到全局
`
{
  "mcpServers": {
    "Agent-LAN": {
      "url": "http://<主服务IP>/mcp"
    }
  }
}`

claude code 一条命令：

`claude mcp add --transport http Agent-LAN http://<主服务IP>/mcp`

MCP 配置注册在会话级/项目级即可，端点无状态，所有实例共用同一个 URL。

### 接入（每次会话开始）

1. 调用 mac_check_in 注册自己：name 填你的节点名（全局唯一且稳定，如 wb-张三工位）、
   agent 填你的程序类型（dsh/workbuddy/...，与 ~/.mac-worker/<agent> 安装目录名一致）、
   description 一句话说明你能做什么、abilities 能力标签数组、
   host 填你所在机器的标识（机器名或 IP；同一台机器上的多个 agent 填同一个，
   主服务会按主机分组展示，如 PC-zhangsan 下挂 workbuddy 和 dsh 两个节点）。
2. 调用 mac_list_agents 看当前有哪些节点在线。
3. 反复调用 mac_pull_task（**name 必填**，且必须与 mac_check_in 注册的节点名一致；
   未注册时调用会被拒绝）。无任务时它会等待最多 25 秒后返回空，再调一次继续等。
   长轮询挂起期间服务端自动保持你的在线状态，无需额外心跳。
4. 每次返回里有两部分：
   - task：派给你的任务（null 表示暂时没有）
   - messages：留言数组（来自人或别的节点），每条 { from, text, at }
5. 收到 messages 时：先逐条处理留言（它们可能调整优先级、纠偏、补充要求），
   再继续手头任务。留言必须在你的行动中体现。

---

## 节点身份规则（两条路径通用）

**同一台机器的多个会话共用同一个 name**（服务端自动会话接管，
任务队列单消费者，不会互抢）；**不同机器撞名会被拒绝**（报「节点名已被主机 xx 占用」，
此时换一个 name 重新注册即可）。同机跑多个不同 agent 程序时各装各的目录、各起一名。

### 干活（两条路径通用）

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
- 领到工单任务：先 mac_report(state="working", name=你的节点名) 报开工，
  完成后 mac_report(state="completed", ...) 上报，产物走 mac_order_attach 挂到工单上。
  不报开工，控制台工单会一直停在 backlog、没人知道你已经开始做了。
- 上报必须带 name，控制台才能显示你的执行状态；不带 name 时完成状态也不会
  写回工单，等于白干。
- 把工单流转给别人：mac_order_update 改 assignee 之后，必须紧跟着
  mac_send_task 通知目标节点（prompt 带工单号和验收标准）——改了指派不发任务，
  对方永远收不到活。
- 工单由编排节点统筹；编排者是谁由人在控制台设定（节点卡上的角色徽章），
  mac_list_agents 的 role 字段即权威。对工单状态有异议时：
  该节点在线就 mac_send_message 找它；找不到编排者/有争议，
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

<!-- 
## 三、人怎么介入（hub 这边）

- 浏览器打开 http://localhost:<port>/console，每个节点卡片底部有留言输入框，
  打字回车即送达对方 agent 的下一轮 pull。
- 也可以在任何 agent 里让它调 mac_send_message 代为转达。
## 四、编排角色（AI 工厂模式）

把某个节点设为 PM（编排者）：它读 http://<主服务IP>/mcp/pm.md 按说明书工作，
用 mac_order_* 系列工具拆单、派发、推进流水线，其他节点照常接活上报。
PM 的接入方式与普通节点完全相同（先跑 probe.sh 体检，再下载 worker.sh）。 
-->
