# ord-ac6c7bc3 修复回执：编辑工单无法修改附件

节点 dsh-PC-hake · 2026-10-16

## 现象核实

属实。编辑弹窗**完全没有附件相关代码**（EditOrderDialog 里 attach/附件/attachment 命中数均为 0），
后端 /console/orders/:id/update 只调 orderStore.update（改字段），**不处理附件**。

根因是层间缺失，不是 bug：

- 建单链路完整：CreateOrderDialog 有上传 UI → POST /console/orders 落库时挂附件
- 编辑链路缺两段：前端无 UI、后端不接收

## 修法

1. **存储层** orders.ts
   - attach 改为同名覆盖：编辑时重复上传同一文件不再挂出两条
   - 新增 detach(id, name, by)：按名移除，不存在则静默忽略
2. **后端** /console/orders/:id/update
   接收 addAttachments / removeAttachments，在字段更新后单独 attach/detach，
   附件变更同样记入 timeline（field=attachment / detach）
3. **编辑弹窗** EditOrderDialog
   - 列出已有附件（可点 × 移除，保存时生效）
   - 支持点击/拖拽新增，复用建单页同款上传路子（PUT /files/:name 拿 URI）
   - 保存按钮上传中置灰
4. 经 store / api / ConsoleHome 透传附件变更，日志显示「附件 +N -M」

## 验证证据（真实 HTTP，非模拟）

- 上传 A、B → 建单带 A（附件数 1）
- 编辑：移除 A + 新增 B → 结果 `["attach-b.txt"]`
  timeline: `{by:"human-console",field:"attachment",to:"attach-b.txt"}`
            `{by:"human-console",field:"detach",to:"attach-a.txt"}`
- 边界四连测（全通过）：
  a) 只改字段不带附件参数 → 已有附件不丢
  b) 移除不存在的附件 → 静默忽略，不报错
  c) 同名重复添加 → 覆盖，不重复
  d) 移除全部 → 清空

## 边界说明

- 附件走文件通道（PUT /files/:name），与建单一致，大文件不会塞进 JSON
- 移除只是从工单摘除引用，共享文件区里的文件不删（别的工单可能还在用）
