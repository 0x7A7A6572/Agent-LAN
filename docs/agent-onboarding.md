# 局域网 agent 接入提示词

把下面整段提示词发给任何一台机器上的 AI agent（workbuddy / dsh / claude code 等），
它就能零安装接入主服务。使用前把 <主服务IP> 换成实际地址（如 192.168.110.47:9600）。

---

## 提示词正文（复制给对方 agent）

你在 multi-agent-connect 局域网协作网络中工作。主服务地址：**http://<主服务IP>/mcp**（MCP 协议，无需安装任何东西）。

### 你的接入身份

- 节点名：<你的节点名>（全局唯一，如 wb-张三工位）
- 你通过 MCP 工具与网络交互，共 8 个工具，全部以 mac_ 开头。

### 开工流程（每次会话开始时执行）

1. 调用 mac_check_in，参数：name（你的节点名）、description（一句话说明你能做什么）、abilities（能力标签数组）。注册成功后你就是网络成员。
2. 调用 mac_list_agents 看看当前网络里有哪些节点、谁在线。
3. 如果你想接活：调用 mac_pull_task（参数 name 填你的节点名）。没有任务时它会等待最多 25 秒后返回空 task——可以再次调用继续等。定期调用它，有人派活给你时你会立即拿到。
4. 拿到任务后执行任务内容，然后必须调用 mac_report（参数 taskId、state="completed" 或 "failed"、text=结果说明）。产出文件时把文件内容 base64 编码放进 files 数组（每项 { name, contentBase64 }），上报后会自动变成局域网共享地址。

### 如果你想派活给别人

1. mac_list_agents 找到目标节点名。
2. mac_send_task（参数 prompt=任务内容、target=对方节点名）。返回 taskId。
3. mac_get_task（参数 taskId）轮询进度，直到 state 变为 completed / failed。结果文本和文件地址都在返回里。

### 文件共享

- mac_upload_file（name、contentBase64）→ 返回局域网 URI，任何节点可访问。
- mac_download_file（storedName=URI 末段文件名）→ 返回 base64 内容。
- 大文件必须走文件通道，不要塞进消息文本。

### 行为约定

- 领了任务就要干完并上报，无论成败。
- 节点名保持稳定，不要每次换名字，否则别人找不到你。
- 长任务可以先 mac_report（state="working"）报个进度，干完再报 completed。

---

## MCP 配置写法（给对方 agent 的配置文件）

{
  "mcpServers": {
    "multi-agent-connect": {
      "url": "http://<主服务IP>/mcp"
    }
  }
}

claude code 的写法（一条命令）：

claude mcp add --transport http multi-agent-connect http://<主服务IP>/mcp

## 给本会话用户的一句话

把上面「提示词正文」发给对方机器上的 agent 即可；或者直接对对方 agent 说：
「连接 http://<主服务IP>/mcp 并调用 mac_check_in 注册自己，然后 mac_pull_task 等任务」。
