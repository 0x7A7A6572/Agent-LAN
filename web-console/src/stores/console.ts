import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '@/api/console'
import type { Order, OrderStatus, Presence } from '@/types/console'

export const useConsoleStore = defineStore('console', () => {
  // 名册：SSE 全量推送，直接整表替换
  const presences = ref<Presence[]>([])
  const sseStatus = ref<'connecting' | 'live' | 'error'>('connecting')

  // 日志：服务端只留 200 条，轮询全量重绘
  const logs = ref<string[]>([])

  // 角色库
  const roles = ref<string[]>([])

  // 工单
  const orders = ref<Order[]>([])
  const ordersLoading = ref(false)

  const onlineNodes = computed(() => presences.value.filter(p => p.online))
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
        presences.value = JSON.parse(e.data).presences ?? []
        sseStatus.value = 'live'
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

  async function createOrder(body: { title: string; assignee?: string; priority: string }) {
    const r = await api.createOrder(body)
    await refreshOrders()
    return r
  }

  async function deleteOrder(id: string) {
    const r = await api.deleteOrder(id)
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
    createOrder,
    deleteOrder,
    deleteNode,
  }
})
