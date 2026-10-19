<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { logoOf } from '@/composables/useLogo'
import type { Presence } from '@/types/console'

const props = defineProps<{
  presences: Presence[]
  /** 派发权状态：human / pm / degraded，来自 /console/pm */
  dispatchMode?: string
  /** PM 节点名；pm 模式下只有它是调度中枢 */
  pmName?: string
  /** 是否在展示演示节点 */
  demo?: boolean
}>()

const emit = defineEmits<{
  (e: 'pick-role', name: string, role: string): void
  (e: 'mail', name: string): void
  (e: 'toggle-demo'): void
}>()

// 视图尺寸跟随容器实测比例：分栏后拓扑变宽，固定 900x520 会让环形显得空
const W = ref(900)
const H = ref(520)
const CENTER = computed(() => ({ x: W.value / 2, y: H.value / 2 }))
const LEAF_R = computed(() => Math.min(W.value, H.value * 1.35) * 0.31)

const hostRef = ref<HTMLElement | null>(null)
let ro: ResizeObserver | undefined

function measure() {
  const el = hostRef.value
  if (!el) return
  const r = el.getBoundingClientRect()
  if (r.width > 0) W.value = Math.round(r.width)
  if (r.height > 0) H.value = Math.round(r.height)
}

onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined' && hostRef.value) {
    ro = new ResizeObserver(() => measure())
    ro.observe(hostRef.value)
  }
})
onUnmounted(() => ro?.disconnect())
watch(() => props.presences.length, () => nextTick(measure))

/** 主机分组：同一 groupHost 的节点归成一条枝干，拓扑才有「局域网」的层级感 */
const groups = computed(() => {
  const map = new Map<string, Presence[]>()
  for (const p of props.presences) {
    const k = p.groupHost || p.card.host || p.card.url || 'unknown'
    if (!map.has(k)) map.set(k, [])
    map.get(k)!.push(p)
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
})

/** PM 节点：优先按名字匹配，其次按 role=pm 找 */
const pmNode = computed(
  () =>
    props.presences.find(p => props.pmName && p.card.name === props.pmName) ??
    props.presences.find(p => p.role === 'pm'),
)

const mode = computed(() => props.dispatchMode ?? 'human')
/** PM 接管中：内置 PM 跑在 hub 进程里，不一定有名册实体；有名册实体时还要求它在线 */
const pmActive = computed(() => {
  if (mode.value !== 'pm') return false
  const external = props.presences.find(p => p.role === 'pm')
  return external ? !!external.online : true
})

/**
 * 叶子绕中心排布。容器变宽时横轴半径同步放大，保持环形贴合画布而不是堆在中间。
 * 超过 8 个分内外两环，外环收窄一点避免贴边。
 */
const layout = computed(() => {
  const leaves = props.presences.filter(p => p !== pmNode.value)
  const total = leaves.length
  if (!total) return []
  const rx = Math.min(W.value * 0.36, LEAF_R.value * 1.55)
  const ry = Math.min(H.value * 0.34, LEAF_R.value * 1.1)
  const perRing = total > 8 ? Math.ceil(total / 2) : total
  return leaves.map((p, i) => {
    const ring = total > 8 && i >= perRing ? 1 : 0
    const idx = ring === 0 ? i : i - perRing
    const count = ring === 0 ? perRing : total - perRing
    // 整圈均分，从正上方开始，避免起点偏左造成的视觉不平衡
    const angle = -Math.PI / 2 + (idx / Math.max(1, count)) * Math.PI * 2
    const k = ring === 0 ? 1 : 0.62
    return {
      p,
      x: CENTER.value.x + Math.cos(angle) * rx * k,
      y: CENTER.value.y + Math.sin(angle) * ry * k,
    }
  })
})

function statusOf(p: Presence): { label: string; dot: string; text: string } {
  if (!p.online) return { label: '离线', dot: 'bg-muted-foreground/40', text: 'text-muted-foreground' }
  if (p.waitingFor) return { label: '等人工', dot: 'bg-amber-500', text: 'text-amber-600' }
  if (p.state === 'working') return { label: '执行中', dot: 'bg-blue-500', text: 'text-blue-500' }
  return { label: '空闲', dot: 'bg-emerald-500', text: 'text-emerald-600' }
}

function logo(name: string, agent?: string) {
  return logoOf(name, agent)
}

// 连线：PM 启用时所有派发都走中心，画成指向中心的实线
const links = computed(() =>
  layout.value.map(n => ({
    key: n.p.card.name,
    x1: CENTER.value.x,
    y1: CENTER.value.y,
    x2: n.x,
    y2: n.y,
    active: pmActive.value && n.p.online,
  })),
)
</script>

<template>
  <div ref="hostRef" class="relative w-full flex-1 overflow-hidden rounded-lg border bg-gradient-to-br from-card to-muted/30">
    <svg
      :viewBox="`0 0 ${W} ${H}`"
      preserveAspectRatio="xMidYMid meet"
      class="h-full w-full"
      role="img"
      aria-label="局域网节点拓扑"
    >
      <defs>
        <radialGradient id="pmGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="rgb(59 130 246 / 0.28)" />
          <stop offset="100%" stop-color="rgb(59 130 246 / 0)" />
        </radialGradient>
        <pattern id="lanGrid" width="28" height="28" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" fill="currentColor" class="text-muted-foreground/20" />
        </pattern>
      </defs>

      <rect :width="W" :height="H" fill="url(#lanGrid)" />

      <!-- 派发链路：PM 接管时高亮，人工模式虚线 -->
      <g>
        <line
          v-for="l in links"
          :key="l.key"
          :x1="l.x1"
          :y1="l.y1"
          :x2="l.x2"
          :y2="l.y2"
          :stroke="l.active ? 'rgb(59 130 246 / 0.5)' : 'currentColor'"
          :stroke-width="l.active ? 1.6 : 1"
          :stroke-dasharray="l.active ? '0' : '4 4'"
          :class="l.active ? '' : 'text-muted-foreground/25'"
        />
      </g>

      <!-- 中心：Supervisor / 人工调度，任何模式都显示，这是拓扑的主角 -->
      <g>
        <circle v-if="pmActive" :cx="CENTER.x" :cy="CENTER.y" :r="Math.round(LEAF_R * 0.62)" fill="url(#pmGlow)" />
        <circle
          :cx="CENTER.x"
          :cy="CENTER.y"
          r="52"
          :class="pmActive ? 'fill-blue-500/10 stroke-blue-500' : mode === 'degraded' ? 'fill-amber-500/10 stroke-amber-500' : 'fill-muted stroke-muted-foreground/40'"
          stroke-width="1.5"
          :stroke-dasharray="pmActive ? '0' : '5 4'"
        />
        <text
          :x="CENTER.x"
          :y="CENTER.y - 6"
          text-anchor="middle"
          class="fill-foreground text-[13px] font-semibold"
        >
          {{ mode === 'human' ? '人工调度' : mode === 'degraded' ? 'PM 降级' : 'Supervisor' }}
        </text>
        <text
          :x="CENTER.x"
          :y="CENTER.y + 12"
          text-anchor="middle"
          class="fill-muted-foreground text-[10px]"
        >
          {{ pmActive ? (pmNode?.card.name || '内置 PM') : mode === 'human' ? '派发权：人' : '派发权：已放行' }}
        </text>
      </g>

      <!-- 叶子节点 -->
      <g v-for="n in layout" :key="n.p.card.name" class="cursor-pointer" @click="emit('pick-role', n.p.card.name, n.p.role || '')">
        <circle
          :cx="n.x"
          :cy="n.y"
          r="30"
          :class="[
            'transition-all',
            n.p.waitingFor ? 'fill-amber-500/15 stroke-amber-500' : n.p.state === 'working' && n.p.online ? 'fill-blue-500/15 stroke-blue-500' : n.p.online ? 'fill-card stroke-border' : 'fill-muted/40 stroke-muted-foreground/30',
          ]"
          stroke-width="1.5"
        />
        <image v-if="logo(n.p.card.name, n.p.agent)" :href="logo(n.p.card.name, n.p.agent)!" :x="n.x - 13" :y="n.y - 13" width="26" height="26" />
        <text v-else :x="n.x" :y="n.y + 4" text-anchor="middle" class="fill-foreground text-[11px] font-semibold">
          {{ n.p.card.name.slice(0, 2).toUpperCase() }}
        </text>
        <!-- 状态点 -->
        <circle :cx="n.x + 22" :cy="n.y - 22" r="5" :class="statusOf(n.p).dot" stroke="white" stroke-width="1.5" />
        <!-- 名字与角色 -->
        <text :x="n.x" :y="n.y + 46" text-anchor="middle" class="fill-foreground text-[11px] font-medium">
          {{ n.p.card.name }}
        </text>
        <text :x="n.x" :y="n.y + 60" text-anchor="middle" class="fill-muted-foreground text-[10px]">
          {{ n.p.role || '未设角色' }}
        </text>
      </g>

      <text v-if="!presences.length" :x="CENTER.x" :y="CENTER.y" text-anchor="middle" class="fill-muted-foreground text-sm">
        暂无节点接入
      </text>
    </svg>

    <!-- 演示数据提示：这些是本地占位，不参与真实派发 -->
    <div
      v-if="demo"
      class="absolute right-3 top-2.5 flex items-center gap-1.5 rounded-full border border-dashed border-muted-foreground/40 bg-background/80 px-2.5 py-1 text-[11px] text-muted-foreground backdrop-blur"
    >
      <span>含演示节点（不可指派）</span>
      <button class="underline-offset-2 hover:text-foreground hover:underline" @click="emit('toggle-demo')">
        隐藏
      </button>
    </div>

    <!-- 图例 -->
    <div class="absolute bottom-2 left-3 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
      <span class="flex items-center gap-1"><i class="size-2 rounded-full bg-emerald-500" />空闲</span>
      <span class="flex items-center gap-1"><i class="size-2 rounded-full bg-blue-500" />执行中</span>
      <span class="flex items-center gap-1"><i class="size-2 rounded-full bg-amber-500" />等人工</span>
      <span class="flex items-center gap-1"><i class="size-2 rounded-full bg-muted-foreground/40" />离线</span>
      <span v-if="pmActive" class="flex items-center gap-1"><i class="h-px w-4 bg-blue-500" />PM 调度链路</span>
      <span v-else class="flex items-center gap-1"><i class="h-px w-4 border-t border-dashed border-muted-foreground/50" />未接管</span>
    </div>
  </div>
</template>
