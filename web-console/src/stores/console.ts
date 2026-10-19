import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '@/api/console'
import type { Order, OrderAttachment, OrderStatus, PmState, Presence } from '@/types/console'

export const useConsoleStore = defineStore('console', () => {
  // 名册：SSE 全量推送，直接整表替换
  const rawPresences = ref<Presence[]>([])
  const sseStatus = ref<'connecting' | 'live' | 'error'>('connecting')

  // 演示节点开关：默认开。开时若真实节点不足 6 个，用演示节点补位（演示的排在前面且不重复）
  const showDemo = ref(true)

  const DEMO_PRESENCES: Presence[] = [
    { card: { name: 'demo-fe', url: 'inbound', version: '0.0.1' }, online: true, state: 'idle', role: 'frontend', groupHost: '10.0.0.21', lastSeen: 0, agent: 'dsh' },
    { card: { name: 'demo-be', url: 'inbound', version: '0.0.1' }, online: true, state: 'working', role: 'backend', workingOn: '订单接口', groupHost: '10.0.0.22', lastSeen: 0, agent: 'dsh' },
    { card: { name: 'demo-qa', url: 'inbound', version: '0.0.1' }, online: true, state: 'idle', role: 'test', groupHost: '10.0.0.22', lastSeen: 0, agent: 'workbuddy' },
    { card: { name: 'demo-ops', url: 'inbound', version: '0.0.1' }, online: false, role: 'devops', groupHost: '10.0.0.30', lastSeen: 0, agent: 'dsh' },
    { card: { name: 'demo-docs', url: 'inbound', version: '0.0.1' }, online: true, state: 'idle', role: 'docs', groupHost: '10.0.0.30', lastSeen: 0, agent: 'workbuddy' },
    { card: { name: 'demo-pm', url: 'inbound', version: '0.0.1' }, online: false, role: 'requirement', groupHost: '10.0.0.40', lastSeen: 0, agent: 'dsh' },
  ]

  /**
   * 对外名册：真实节点在前，演示节点在后补位。
   * 之前是"有真实节点就整体替换掉演示节点"，导致真实节点一上线演示数据就消失；
   * 现在改成补位：演示节点只补到阈值，且打 demo 标记便于区分。
   */
  const DEMO_FILL_TO = 6
  const presences = computed<Presence[]>(() => {
    const real = rawPresences.value
    if (!showDemo.value) return real
    const need = Math.max(0, DEMO_FILL_TO - real.length)
    if (!need) return real
    // 真实节点可能恰好重名，按名字去重
    const taken = new Set(real.map(p => p.card.name))
    const fill = DEMO_PRESENCES.filter(p => !taken.has(p.card.name)).slice(0, need)
    return [...real, ...fill.map(p => ({ ...p, demo: true }))]
  })
  /** 当前视图里是否混有演示节点 */
  const demoMode = computed(() => presences.value.some(p => p.demo))

  function toggleDemo() {
    showDemo.value = !showDemo.value
  }

  // 等待人工确认：名册里任一节点带 waitingFor 即弹提示（已提醒过的节点不重复弹）
  const waitingNodes = computed(() => presences.value.filter(p => p.waitingFor))
  const waitingSig = ref('')
  const waitingAlert = ref<{ name: string; text: string }[]>([])

  // 日志：服务端只留 200 条，轮询全量重绘
  const logs = ref<string[]>([])

  // 角色库
  const roles = ref<string[]>([])

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
    }
    es.onmessage = e => {
      try {
        rawPresences.value = JSON.parse(e.data).presences ?? []
        sseStatus.value = 'live'
        // 只对「新进入等待」的节点弹一次，签名不变不重复打扰
        const pending = rawPresences.value.filter(p => p.waitingFor)
        const sig = pending.map(p => p.card.name + '|' + p.waitingFor).sort().join(';')
        if (sig !== waitingSig.value) {
          waitingSig.value = sig
          waitingAlert.value = pending.map(p => ({ name: p.card.name, text: p.waitingFor! }))
        }
      } catch {}
    }
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
    demoMode,
    showDemo,
    toggleDemo,
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
