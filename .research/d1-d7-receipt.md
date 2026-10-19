# D1-D7 缺陷修复回执

节点 dsh-PC-hake · 2026-10-16 · 母单 ord-e752931a（源自 ord-6feda974「pm角色滞空问题」）

## 逐条结论

| 单 | 缺陷 | 结论 | 修法 |
|---|---|---|---|
| D1 | 指南引用不存在的 role=pm | 属实 | 改为「编排者由人在控制台设定，以 mac_list_agents 的 role 为准」，不再指向不存在的角色 |
| D2 | 状态机缺「等人工」态 | 属实 | 任务 input-required → 工单 blocked；控制台增 blocked Tab/下拉/树形琥珀点 |
| D3 | input-required 不持久、被重投 | 属实 | 回收判据加 reportedAt：已回报的任务不再当投递丢失重投 |
| D4 | 孤儿工单无归属规则 | 属实 | 新增孤儿扫描：持有者全离线/无归属/幽灵 holder → 退回 human-console 并记 timeline |
| D5 | order_create/update 的 by 未入 schema | 属实 | 两个 schema 补 by |
| D6 | mac_report 归因固定 mcp-report | 属实 | 归因改用上报节点名 |
| D7 | order_update 无 title 且静默忽略 | 属实 | schema 补 title/parent；handler 真正透传（store 本就支持） |

## 验证证据

- **D1**：产物 install.md 已无 role=pm（正则核查 false）
- **D2+D6**：ord-c5031ec3 报 input-required 后 → 状态 blocked，timeline
  `{"by":"dsh-PC-hake","field":"status","from":"developing","to":"blocked"}`（归因带节点名）
- **D3**：自建任务→领取→报 input-required→二次 pull 返回 **null**，状态保持 input-required
- **D4**：扫描后 5 张孤儿单中 3 张（0ac024c7/e6aecf59/demo-103）+ 幽灵 owner 单
  37d0418f 已退回 human-console 并留 hub-orphan-sweep 记录；
  1337e2a0 持有者 wb-dev-pc-win11 在线，属正常在办不回收
- **D5/D7**：tools/list 实测
  `mac_order_create :: title,...,blockedBy,by`
  `mac_order_update :: id,title,status,...,parent,...,by`
  D7 实改标题成功且 timeline 归因正确

## 备注

- D2 的另一半语义：blocked 是正当停顿，答完由节点再报 working 回 developing
- 判据原则统一为「以节点在线状态与回报事实为准」，不做时间猜测
