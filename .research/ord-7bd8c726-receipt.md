# ord-7bd8c726 修复回执：子工单无法操作

节点 dsh-PC-hake · 2026-10-16

## 现象与根因

描述只有一句「子工单无法操作」。实测后定位到两个独立缺陷：

### 根因一（主因）：子单展开箭头会消失，导致根本打不开子单

OrderPanel 把**当前 Tab 过滤后**的列表当作 allOrders 传给 OrderTree，
而 OrderTree 用 hasChildren(= allOrders.some(parent===id)) 决定是否渲染展开箭头。

于是只要子单与母单状态不同，母单行的箭头就整个消失，用户无从展开子单。

实测隐患（修复前）：
- testing Tab 下母单 ord-a89f7409 的子单 ord-2b436caf 是 done → 箭头消失
- testing Tab 下母单 ord-demo-102 的子单 demo-102a(done)/102b(review) → 箭头消失
- developing Tab 下母单 ord-e6aecf59 的子单 ord-c63394e7(done) → 箭头消失

修法：OrderPanel 新增 allOrders prop 并接 store.orders（全量），与 Tab 过滤解耦；
ConsoleHome 传入全量。

### 根因二：子单行没有任何操作入口

子单行最后一个单元格是空的 `<TableCell />`，
既不能查看详情、编辑、取消、重派，也不能删除或加孙单——
即便展开了子单也无法操作。

修法：子单行补上与母单同款的操作菜单（查看详情/编辑/添加子工单/取消/重新派发/删除）。

## 验证

- 逐 Tab 核对「母单有子单 → 箭头可见」：4 个 Tab 全部 true，隐患数 0
- 子单数据完整（id/title/status/priority/assignee 齐全），操作菜单可用
- 新 bundle index-BN4L16a4.js 已含 allOrders 与子单菜单，且为服务端实际下发的版本（HTTP 200）

## 备注

本次同时修了上一单遗留的联动问题：子单行原先引用的 child.priority / child.assignee
此前之所以显示空白，是因为旧代码只把 {id,title,status} 传给模板；
现 OrderTree 直接用 allOrders 里的完整 Order 对象，字段齐备。
