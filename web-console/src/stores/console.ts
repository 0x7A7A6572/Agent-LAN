import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '@/api/console'
import type { Order, OrderAttachment, OrderStatus, PmState, Presence, RoleDef } from '@/types/console'

export const useConsoleStore = defineStore('console', () => {
  // 名册：SSE 全量推送，直接整表替换
  const presences = ref<Presence[]>([])
  // polling = SSE 长时间没消息，已降级成轮询（代理/中间设备掐长连接的常见情况）
  const sseStatus = ref<'connecting' | 'live' | 'polling' | 'error'>('connecting')

  // 等待人工确认：名册里任一节点带 waitingFor 即弹提示（已提醒过的节点不重复弹）
  const waitingNodes = computed(() => presences.value.filter(p => p.waitingFor))
  const waitingSig = ref('')
  const waitingAlert = ref<{ name: string; text: string }[]>([])

  // 日志：服务端只留 200 条，轮询全量重绘
  const logs = ref<string[]>([])

  // 角色库
  const roles = ref<RoleDef[]>([])

  // 工单
  const orders = ref<Order[]>([])
  const ordersLoading = ref(false)

  const onlineNodes = computed(() => presences.value.filter(p => p.online))
  function dismissWaitingAlert() {
    waitingAlert.value = []
  }
  const nodeNames = computed(() => presences.value.map(p => p.card.name).sort())
  const summary = computed(() => {
    const g = (p: Presence) => p.groupHost || p.card.host || p.card.url
    const hosts = new Set(presences.value.map(g))
    const onlineHosts = new Set(onlineNodes.value.map(g))
    return (
      onlineNodes.value.length +
      ' 在线 / ' +
      presences.value.length +
      ' 节点 · ' +
      onlineHosts.size +
      '/' +
      hosts.size +
      ' 台主机 · 40s 无活动判离线'
    )
  })

  function connectSse() {
    sseStatus.value = 'connecting'
    const es = new EventSource('/console/presence/stream')
    es.onopen = () => {
      sseStatus.value = 'live'
    }
    es.onerror = () => {
      sseStatus.value = 'error'
      startFallbackPoll()
    }
    es.onmessage = e => {
      try {
        lastSseAt = Date.now()
        applyPresences(JSON.parse(e.data).presences ?? [])
        sseStatus.value = 'live'
      } catch {}
    }
    startFallbackPoll()
  }

  // 收到一份名册就整表替换，并只在「新进入等待」时弹一次，签名不变不重复打扰
  function applyPresences(list: Presence[]) {
    presences.value = list
    const pending = list.filter(p => p.waitingFor)
    const sig = pending.map(p => p.card.name + '|' + p.waitingFor).sort().join(';')
    if (sig !== waitingSig.value) {
      waitingSig.value = sig
      waitingAlert.value = pending.map(p => ({ name: p.card.name, text: p.waitingFor! }))
    }
  }

  /**
   * SSE 兜底：长连接超过 8s 没有消息就改用 3s 轮询快照。
   * 不这么兜的话，中间设备悄悄掐断长连接时页面会「冻」在断开那一刻 ——
   * 节点等人、题卡在服务端一直在，但人完全看不到，只能等下一次偶然的刷新。
   */
  let lastSseAt = 0
  let fallbackTimer: ReturnType<typeof setInterval> | undefined
  function startFallbackPoll() {
    if (fallbackTimer) return
    fallbackTimer = setInterval(async () => {
      if (Date.now() - lastSseAt < 8000) return
      try {
        const d = await api.fetchPresenceSnapshot()
        if (Array.isArray(d?.presences)) {
          applyPresences(d.presences)
          if (sseStatus.value !== 'live') sseStatus.value = 'polling'
        }
      } catch {}
    }, 3000)
  }

  async function pollLogs() {
    try {
      const d = await api.fetchLogs()
      logs.value = d.logs ?? []
    } catch {}
  }

  async function loadRoles() {
    if (roles.value.length) return roles.value
    roles.value = await api.fetchRoles().catch(() => [])
    return roles.value
  }

  async function refreshRoles() {
    roles.value = await api.fetchRoles().catch(() => [])
    return roles.value
  }

  // PM 派发权状态：轮询轻量接口，拓扑中心据此显示 Supervisor / 人工 / 降级
  const pmState = ref<PmState>({ mode: 'human', enabled: false })

  async function refreshPmState() {
    pmState.value = await api.fetchPmState()
    return pmState.value
  }

  async function refreshOrders() {
    ordersLoading.value = true
    try {
      const d = await api.fetchOrders()
      orders.value = d.orders ?? []
    } finally {
      ordersLoading.value = false
    }
  }

  async function updateOrderStatus(id: string, status: OrderStatus) {
    await api.updateOrder(id, { status })
    await refreshOrders()
  }

  async function editOrder(
    id: string,
    patch: Partial<Order>,
    attachments?: { add: OrderAttachment[]; remove: string[] },
  ) {
    const r = await api.updateOrder(id, {
      ...patch,
      addAttachments: attachments?.add,
      removeAttachments: attachments?.remove,
    })
    await refreshOrders()
    return r
  }

  async function createOrder(body: { title: string; assignee?: string; priority: string; parent?: string; description?: string; attachments?: OrderAttachment[] }) {
    const r = await api.createOrder(body)
    await refreshOrders()
    return r
  }

  async function deleteOrder(id: string) {
    const r = await api.deleteOrder(id)
    await refreshOrders()
    return r
  }

  async function cancelOrder(id: string) {
    const r = await api.cancelOrder(id)
    await refreshOrders()
    return r
  }

  async function redispatchOrder(id: string, assignee?: string) {
    const r = await api.redispatchOrder(id, assignee)
    await refreshOrders()
    return r
  }

  async function deleteNode(name: string) {
    const r = await api.deleteNode(name)
    return r
  }

  // 工单状态由 agent 侧更新：轮询保持列表与详情实时
  setInterval(refreshOrders, 2000)

  return {
    presences,
    sseStatus,
    waitingNodes,
    waitingAlert,
    logs,
    roles,
    orders,
    ordersLoading,
    onlineNodes,
    nodeNames,
    summary,
    connectSse,
    pollLogs,
    loadRoles,
    refreshRoles,
    refreshOrders,
    updateOrderStatus,
    editOrder,
    pmState,
    refreshPmState,
    createOrder,
    deleteOrder,
    cancelOrder,
    redispatchOrder,
    deleteNode,
    dismissWaitingAlert,
  }
})
