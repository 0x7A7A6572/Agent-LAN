<script setup lang="ts">
// 3D 节点拓扑视图：Three.js 场景的 Vue 外壳
// 关键约束：WebGL 上下文只在挂载后创建，卸载必须 dispose，否则切视图会泄漏
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { TopoData, TopoNode } from './topology3d'
import type { Order, Presence } from '@/types/console'

const props = defineProps<{
  presences: Presence[]
  orders: Order[]
  /** 派发权状态：human / pm */
  dispatchMode?: string
  /** PM 节点名，来自 /console/pm */
  pmName?: string
}>()

const hostRef = ref<HTMLElement | null>(null)
// 场景实例类型用结构化描述，避免为静态类型而静态引入 three
interface SceneHandle {
  setData: (d: TopoData) => void
  dispose: () => void
}
const scene = shallowRef<SceneHandle | null>(null)
const threeLoading = ref(true)
const tooltip = ref<{ node: TopoNode; x: number; y: number } | null>(null)

/** 节点状态：等人工优先于执行中，离线兜底 */
function stateOf(p: Presence): TopoNode['state'] {
  if (!p.online) return 'off'
  if (p.waitingFor) return 'wait'
  if (p.state === 'working') return 'work'
  return 'idle'
}

const ACTIVE_STATUS = new Set(['analyzing', 'developing', 'testing', 'review', 'blocked'])

/** 调度层固定占中心：PM 接管时是 PM，人工模式时是人 */
const schedulerLabel = computed(() => (props.dispatchMode === 'pm' ? 'PM 调度' : '人工调度'))

const pmNode = computed<TopoNode | null>(() => {
  const name = props.pmName || 'hub-pm'
  if (props.presences.some((p) => p.card.name === name)) return null
  const active = props.dispatchMode === 'pm' || props.dispatchMode === 'degraded'
  return {
    id: name,
    role: schedulerLabel.value,
    state: active ? 'work' : 'idle',
    host: 'hub',
    taskCount: props.orders.filter((o) => o.status !== 'done' && o.status !== 'canceled' && !o.assignee).length,
  }
})

/** 从名册 + 工单推导场景数据 */
const topoData = computed<TopoData>(() => {
  const nodes: TopoNode[] = props.presences.map((p) => ({
    id: p.card.name,
    role: p.role || p.roleDesc,
    state: stateOf(p),
    host: p.groupHost || p.card.host || p.card.url || 'default',
    workingOn: p.workingOn,
    taskCount: props.orders.filter(
      (o) => o.assignee === p.card.name && o.status !== 'done' && o.status !== 'canceled',
    ).length,
  }))

  // hub 自身是局域网服务器，名册里没有它，但它必须始终占据场景中心
  const hubSeen = nodes.some((n) => n.id === 'hub')
  if (!hubSeen) {
    nodes.unshift({
      id: 'hub',
      role: '服务器',
      state: 'work',
      host: 'hub-center',
      taskCount: props.orders.filter((o) => o.status !== 'done' && o.status !== 'canceled').length,
    })
  }
  if (pmNode.value) nodes.unshift(pmNode.value)

  // 流转边：handoffs 记录 from→to，取最近一次交接；没有 handoffs 时退回归属关系
  const edgeAt = new Map<string, number>()
  for (const o of props.orders) {
    const list = o.handoffs ?? []
    for (const h of list) {
      if (!h.from || h.from === h.to) continue
      const key = h.from + '->' + h.to
      const t = new Date(h.at).getTime()
      if (!edgeAt.has(key) || (edgeAt.get(key) ?? 0) < t) edgeAt.set(key, t)
    }
  }
  const flows: TopoData['flows'] = []
  for (const [key, at] of edgeAt) {
    const [from, to] = key.split('->')
    if (from && to) flows.push({ from, to, at })
  }

  // 有活跃任务但没有任何 handoff 的节点：连一条到中心的虚拟边，避免场景空荡
  if (!flows.length) {
    const pmId = pmNode.value?.id ?? props.presences.find((p) => p.role === 'pm')?.card.name
    if (pmId) {
      for (const p of props.presences) {
        if (p.card.name === pmId) continue
        const active = props.orders.some(
          (o) => o.assignee === p.card.name && ACTIVE_STATUS.has(o.status),
        )
        if (active) flows.push({ from: pmId, to: p.card.name, at: Date.now() })
      }
    }
  }

  return { nodes, flows }
})

const onlineCount = computed(() => props.presences.filter((p) => p.online).length)
const activeTaskCount = computed(
  () => props.orders.filter((o) => ACTIVE_STATUS.has(o.status)).length,
)
const flowCount = computed(() => topoData.value.flows.length)

let cancelled = false

onMounted(async () => {
  if (!hostRef.value) return
  // Three.js 体积大，单独拆包：不切到这张视图就不下载
  const { TopoScene } = await import('./topology3d')
  if (cancelled || !hostRef.value) return
  const s = new TopoScene(hostRef.value, {
    onHover: (node, screen) => {
      tooltip.value = node && screen ? { node, x: screen.x, y: screen.y } : null
    },
  })
  s.setData(topoData.value)
  scene.value = s
  threeLoading.value = false
})

onBeforeUnmount(() => {
  cancelled = true
  scene.value?.dispose()
  scene.value = null
})

watch(
  topoData,
  (d) => scene.value?.setData(d),
  { deep: true },
)
</script>

<template>
  <div class="relative h-full w-full overflow-hidden bg-[#050914]">
    <div ref="hostRef" class="h-full w-full" />

    <!-- 首次进入要下载 3D 引擎，给个明确的等待态 -->
    <div
      v-if="threeLoading"
      class="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-[#5d7ea6]"
    >
      正在加载 3D 场景…
    </div>

    <!-- 悬浮信息 -->
    <div
      v-if="tooltip"
      class="pointer-events-none absolute z-10 max-w-[260px] rounded-md border border-[#2a7fd4]/50 bg-[#081224]/95 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-[#cfe4ff] shadow-lg backdrop-blur-sm"
      :style="{ left: tooltip.x + 14 + 'px', top: tooltip.y + 14 + 'px' }"
    >
      <div class="font-semibold text-[#eaf6ff]">{{ tooltip.node.id }}</div>
      <div class="text-[#6f93bd]">
        {{ tooltip.node.role || '未设角色' }} · {{ tooltip.node.taskCount ?? 0 }} 个任务
      </div>
      <div v-if="tooltip.node.workingOn" class="mt-0.5 text-[#54e0ff]">{{ tooltip.node.workingOn }}</div>
    </div>

    <!-- 空态 -->
    <div
      v-if="!presences.length"
      class="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-[#5d7ea6]"
    >
      暂无节点接入 · 运行 probe.sh --install 后启动 worker.sh
    </div>
  </div>
</template>