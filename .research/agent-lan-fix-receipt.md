# Agent-LAN 修复回执：状态同步 / 人工确认 / 任务回收

节点 dsh-PC-hake · 2026-10-16 · 覆盖工单 ord-a89f7409、ord-d46f5738、ord-47f3dd10

## 一、人工确认（input-required）通知链路

两个症状各自独立，都是真 bug。

1. **request_input 失败场景**：hub 17 个工具里**不存在** request_input，
   人工确认唯一入口是 mac_report(state="input-required")。文档叫法与实现不符，
   照着调必然 -32602。真正的 ok:false 来自终态保护（防取消后被 completed 盖回，必要）。
2. **成功也无弹窗**：上报只写服务端日志 + pushEvent 到**任务级** SSE，
   而控制台只订阅 presence 流与 logs。web-console 全仓 grep input-required 零命中，
   /console/tasks/stream 与 /console/events 均 404——缺数据通路，非样式问题。

修法：AgentPresence 增加 waitingFor 随名册下发；控制台节点卡转「等人工」、
边框转琥珀、置顶提醒条 + 弹条、可关闭。终态任务收到确认请求不再静默 ok:false，
改为返回 reason 且把请求送达控制台。文档与工具描述对齐，明确没有 request_input。

验证：终态上报返回 {ok:false,reason:...}；presence 流带 waitingFor；控制台 200。

## 二、任务卡 working / 回收

三种丢失场景分别收口，判据互不重叠：

- **投递未送达**：响应写出前连接已断（res.destroyed）→ 立即回收重排队。
- **进程中断**：投递已发出但确认未写回，落盘 deliveredInFlight 标志，
  hub 下次启动即回收。
- **长期不回报**：同 name 新 pull 抵达且交付超 90s → 回收。
  与既有「会话接管」同语义，不误伤「领任务→上报→重启」的正常往返。

验证证据（hub 日志）：
    16:10:25 -> task a22cfdc7 pushed to reclaim-test-node
    16:10:25 [task] a22cfdc7 投递未送达（连接中断），已回收重排队
    16:10:28 -> task a22cfdc7 pulled by reclaim-test-node
    16:16:37 [task] 53b3d492 投递未送达（连接中断），已回收重排队
    16:16:38 -> task 53b3d492 pulled by dsh-PC-hake

## 三、节点执行态不同步（ord-d46f5738 / ord-47f3dd10）

根因四处，全部已修：

1. **mac_report(state=working) 不带任务描述**：setBusy 的 workingOn 被抹空，
   于是「更新一次就不更新」。修：report 时按 taskId 反查并带上 workingOn。
2. **执行态不落盘且无人重建**：state/workingOn 是纯运行态，hub 重启即丢。
   修：启动时按仍处 working 的任务重建节点执行态。
3. **终态未清 busy**：任务完成后节点会永久停在「执行中」。
   修：转终态且该节点无其他在跑任务时清 busy；任务被回收时同样清。
4. **同机多 worker 抢同一身份**：多个孤儿 worker 实例并存时互抢任务，
   任务在下发/回收间抖动、状态反复。已清理至单实例。
   相关：同机判定原先只做字符串比对，而自报 host 是主机名、
   来源是 IP，两者不可比 → 每 20 秒误报「节点名冲突」。
   修：同机判定改用来源 IP + 本机身份表（主机名与各网卡地址），归并后沿用首次绑定口径。

验证：重启后名册正确显示 workingOn=ord-2b436caf；冲突=0、回收=0（曾每 20 秒 1 条）。

## 四、部署

改动落在 packages/sdk、packages/server、web-console/src、docs。
已构建并重启 hub（端口 9600，单实例）。节点 dsh-PC-hake 常驻在线。

注：worker.sh 必须用 POSIX 路径启动（/c/Users/.../worker.sh），
传 Windows 反斜杠路径会让 BASH_SOURCE 匹配失败、退化成 default 身份。
