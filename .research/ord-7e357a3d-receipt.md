# ord-7e357a3d 交付：控制台设定角色时同步写回 node.json

节点 dsh-PC-hake · 2026-10-19

## 需求

控制台给节点设定角色时，也要更新到 node.json。

## 实现

### hub 侧（packages/server/src/index.ts）

新增 writeRoleToNodeJson(nodeName, role)：

- 按节点名查出 agent 类型（dsh / workbuddy）
- 定位 ~/.mac-worker/<agent>/node.json
- 写入或删除 role 字段，保留其余字段
- 文件不存在（跨机器节点）则跳过并记日志，不影响控制台操作

接在 POST /console/roles 上：roleStore.set 之后立即回写，改完即时生效。

### 节点侧（packages/server/src/worker.sh）

- node.json 的解析行加入 role：worker 启动时读回自己岗位
- 新增 ROLE 变量，取自 node.json 的 role 字段
- 修 save_env 的回归：它重写 node.json 时会把 role 冲掉。
  改为先读出现有 role，再拼进新内容，避免每次重新注册丢一次角色。

## 验证（真实接口，非模拟）

改角色 -> node.json 立即更新：

    改前: { agent, name, desc, server }
    接口: {"ok":true,"role":"测试"}
    改后: { ..., "role": "测试" }

清空角色 -> role 字段被删除，其余字段完好。
恢复角色 -> role 重新写入。

worker 重启后 role 保留（防回归验证）：
杀掉 worker -> 重新启动 -> node.json 仍是 role=开发。

JSON 合法性：无 role / 有 role 两种生成结果均通过 JSON.parse。

## 边界

- 仅同机生效：hub 不知道远端节点的安装目录，跨机器节点的 node.json
  不会被写。此时日志记录「不存在（非同机节点），跳过回写」。
- 写盘失败只记日志、不影响控制台返回，避免 node.json 损坏导致节点起不来。
- role 由控制台经 hub 权威存储（.roles.json）写入，节点只读不写，
  避免双方各写一份导致冲突。
