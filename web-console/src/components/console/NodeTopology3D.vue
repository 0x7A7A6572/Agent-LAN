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

/**
 * 主服务本体的真实地址。
 * 取 location.host（浏览器此刻正在连的那个 server），而不是某个节点名——
 * 服务器是「当前启动的这个 server」，不是名册里的成员。
 */
const serverAddr = ref(
  typeof window === 'undefined'
    ? ''
    : window.location.host || window.location.hostname || '',
)
/** 服务端卡片补充信息（主机名 / 版本），拿不到就只显示地址 */
const serverCard = ref<{ host?: string; version?: string } | null>(null)

onMounted(async () => {
  try {
    const r = await fetch('/.well-known/agent-card.json', { cache: 'no-store' })
    if (r.ok) serverCard.value = await r.json()
  } catch {
    /* 取不到不影响拓扑渲染 */
  }
})

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

/** 主服务本体：固定 id，永远占中心，不参与名册 */
const SERVER_ID = 'server'

const serverSubtitle = computed(() => {
  const host = serverCard.value?.host
  const ver = serverCard.value?.version
  const bits = ['主服务']
  if (host) bits.push('主机 ' + host)
  if (ver) bits.push('v' + ver)
  return bits.join(' · ')
})

const pmNode = computed<TopoNode | null>(() => {
  const name = props.pmName || 'hub-pm'
  if (props.presences.some((p) => p.card.name === name)) return null
  const active = props.dispatchMode === 'pm' || props.dispatchMode === 'degraded'
  return {
    id: name,
    kind: 'pm',
    label: name,
    role: schedulerLabel.value,
    subtitle: schedulerLabel.value + (active ? ' · 接管中' : ' · 空闲'),
    state: active ? 'work' : 'idle',
    host: 'hub',
    taskCount: props.orders.filter((o) => o.status !== 'done' && o.status !== 'canceled' && !o.assignee).length,
  }
})

/** 从名册 + 工单推导场景数据 */
const topoData = computed<TopoData>(() => {
  const nodes: TopoNode[] = props.presences.map((p) => ({
    id: p.card.name,
    kind: 'agent',
    label: p.card.name,
    role: p.role || p.roleDesc,
    state: stateOf(p),
    host: p.groupHost || p.card.host || p.card.url || 'default',
    workingOn: p.workingOn,
    taskCount: props.orders.filter(
      (o) => o.assignee === p.card.name && o.status !== 'done' && o.status !== 'canceled',
    ).length,
  }))

  // 主服务本体：常驻中心。它是 server，不是节点，所以不统计"挂了多少工单"
  nodes.unshift({
    id: SERVER_ID,
    kind: 'server',
    label: serverAddr.value || '主服务',
    subtitle: serverSubtitle.value,
    role: '主服务',
    state: 'work',
    host: 'hub-center',
  })
  if (pmNode.value) nodes.unshift(pmNode.value)

  const known = new Set(nodes.map((n) => n.id))

  /**
   * 连接边：主服务 ↔ 每个在线节点（含 PM）。
   * 这是「通不通」的实时状态，跟有没有发生过任务交接无关——
   * 以前只画 handoff，于是"在线但没有交接记录"的节点看起来是断连的。
   */
  const links: TopoData['flows'] = []
  for (const n of nodes) {
    if (n.id === SERVER_ID) continue
    if (n.state === 'off') continue
    links.push({ from: SERVER_ID, to: n.id, kind: 'link' })
  }

  // 流转边：handoffs 记录 from→to，取最近一次交接。
  // 只保留两端都在场景里的边：human-console / mcp / lead / dsh-worker 这些是服务器侧的身份，
  // 不是图上节点，画不出来——以前这些边全部被静默丢弃，还顺带把兜底逻辑也跳过了。
  const edgeAt = new Map<string, number>()
  for (const o of props.orders) {
    for (const h of o.handoffs ?? []) {
      if (!h.from || h.from === h.to) continue
      if (!known.has(h.from) || !known.has(h.to)) continue
      const key = h.from + '->' + h.to
      const t = new Date(h.at).getTime()
      if (!edgeAt.has(key) || (edgeAt.get(key) ?? 0) < t) edgeAt.set(key, t)
    }
  }
  const linked = new Set(links.map((f) => f.from + '->' + f.to))
  const flows: TopoData['flows'] = []
  for (const [key, at] of edgeAt) {
    const [from, to] = key.split('->')
    if (!from || !to) continue
    if (linked.has(key)) continue // 已经画成连接线的，不再叠一条流转线
    flows.push({ from, to, at, kind: 'flow' })
  }

  return { nodes, flows: [...links, ...flows] }
})

const onlineCount = computed(() => props.presences.filter((p) => p.online).length)
const activeTaskCount = computed(
  () => props.orders.filter((o) => ACTIVE_STATUS.has(o.status)).length,
)
/** 连接数 = 在线且已连到主服务的对象（含 PM） */
const linkCount = computed(() => topoData.value.flows.filter((f) => f.kind === 'link').length)
const flowCount = computed(() => topoData.value.flows.filter((f) => f.kind !== 'link').length)

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
      class="pointer-events-none absolute z-10 max-w-[280px] rounded-md border border-[#2a7fd4]/50 bg-[#081224]/95 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-[#cfe4ff] shadow-lg backdrop-blur-sm"
      :style="{ left: tooltip.x + 14 + 'px', top: tooltip.y + 14 + 'px' }"
    >
      <div class="font-semibold text-[#eaf6ff]">{{ tooltip.node.label || tooltip.node.id }}</div>
      <!-- 主服务：地址即身份，不显示"挂了多少工单"（工单不属于服务器） -->
      <div v-if="tooltip.node.kind === 'server'" class="text-[#6f93bd]">
        {{ tooltip.node.subtitle }}
      </div>
      <template v-else>
        <div class="text-[#6f93bd]">
          {{ tooltip.node.subtitle || tooltip.node.role || '未设角色' }}
          <span v-if="tooltip.node.kind !== 'pm'"> · {{ tooltip.node.taskCount ?? 0 }} 个任务</span>
        </div>
        <div v-if="tooltip.node.workingOn" class="mt-0.5 text-[#54e0ff]">{{ tooltip.node.workingOn }}</div>
      </template>
    </div>

    <!-- 图例：两种线语义不同，不标出来会被当成同一件事 -->
    <div
      class="pointer-events-none absolute bottom-2 left-2 flex items-center gap-3 rounded-md bg-[#081224]/70 px-2 py-1 text-[10.5px] text-[#7d9cbf] backdrop-blur-sm"
    >
      <span class="flex items-center gap-1">
        <i class="inline-block h-[3px] w-4 rounded-full bg-[#2fd6a6]" />
        已连接 {{ linkCount }}
      </span>
      <span class="flex items-center gap-1">
        <i class="inline-block h-[3px] w-4 rounded-full bg-[#2b8fe0]" />
        任务流转 {{ flowCount }}
      </span>
      <span>在线 {{ onlineCount }} · 活跃工单 {{ activeTaskCount }}</span>
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