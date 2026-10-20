<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Bot, CircleAlert, Play, Square, TriangleAlert, Zap } from 'lucide-vue-next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Label } from '@/components/ui/label'
import { Search } from 'lucide-vue-next'
import {
  fetchPmConfig,
  fetchPmDecisions,
  fetchPmWorkbuddy,
  probePmModel,
  readyPmWorkbuddy,
  savePmConfig,
  setPmMode,
} from '@/api/console'
import { useConsoleStore } from '@/stores/console'
import type { PmConfigView, PmDecisionView } from '@/types/console'

const store = useConsoleStore()
// 给默认值而非 null：模板里 v-model 需要可写对象，v-if 无法收窄到 ref
const config = ref<PmConfigView>({
  enabled: false,
  provider: 'openai',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen2.5:14b',
  temperature: 0.2,
  debounceMs: 3000,
  tickMs: 300000,
  maxActionsPerDecision: 10,
  tokenBudget: 6000,
  timeoutMs: 60000,
  apiKeyConfigured: false,
})
const loaded = ref(false)
const decisions = ref<PmDecisionView[]>([])
const apiKey = ref('')
// WorkBuddy 直连的可用性探测结果
const wb = ref<{ available: boolean; reason?: string; ready: boolean; models: string[] }>({
  available: false,
  ready: false,
  models: [],
})
const wbLoading = ref(false)
const wbError = ref('')
const busy = ref(false)
const msg = ref('')
// 决策流：自动刷新 / 搜索 / timeline 懒加载
const decisionsLoading = ref(false)
let decisionsTimer: ReturnType<typeof setInterval> | undefined
/** 每次追加的条数：首屏 20 条足够看清最新决策，往下滚再要下一批 */
const PAGE_STEP = 20
const visibleCount = ref(PAGE_STEP)
const search = ref('')
/** 例行 tick（无动作）默认不显示：它们占 8 成以上，全是「没新事件→不动作」，纯噪音 */
const onlyImportant = ref(true)
/** 提示消息的严重程度：失败要显眼，别被当成切换成功 */
const msgKind = ref<'ok' | 'error'>('ok')

const mode = computed(() => store.pmState.mode)
const active = computed(() => mode.value === 'pm')
const degraded = computed(() => mode.value === 'degraded')

async function loadDecisions() {
  decisionsLoading.value = true
  try {
    decisions.value = (await fetchPmDecisions(200)).decisions ?? []
  } finally {
    decisionsLoading.value = false
  }
}

async function load() {
  const c = await fetchPmConfig()
  if (c) { config.value = c; loaded.value = true }
  await loadDecisions()
  wb.value = await fetchPmWorkbuddy()
}

async function toggle() {
  busy.value = true
  try {
    const next = active.value || degraded.value ? 'human' : 'pm'
    const r = await setPmMode(next)
    if (r.ok) {
      msgKind.value = 'ok'
      msg.value = '已切换到' + (next === 'pm' ? ' PM 接管' : '人工模式')
    } else {
      // 服务端会带回具体原因（未配模型 / 端点不可达 / HTTP 401 等），原样展示
      msgKind.value = 'error'
      msg.value = r.error || '切换失败'
    }
    await store.refreshPmState()
  } finally {
    busy.value = false
  }
}

// 单独测试模型连通性，不用先接管
/** 切到直连：首次需要解凭据拉模型表，成功后填充下拉 */
async function useWorkbuddy() {
  config.value.provider = 'workbuddy'
  if (wb.value.models.length || wbLoading.value) return
  wbLoading.value = true
  wbError.value = ''
  try {
    const r = await readyPmWorkbuddy()
    if (r.ok && r.models?.length) {
      wb.value = { ...wb.value, ready: true, models: r.models }
      // 当前模型不在列表里就选第一个，避免留着一个不存在的模型名
      if (!r.models.includes(config.value.model)) config.value.model = r.models[0] ?? ''
    } else {
      wbError.value = r.error || '无法读取模型列表'
    }
  } finally {
    wbLoading.value = false
  }
}

async function probe() {
  busy.value = true
  try {
    const r = await probePmModel()
    msgKind.value = r.ok ? 'ok' : 'error'
    msg.value = r.ok ? '模型连通，可以接管' : r.error || '模型不可用'
  } finally {
    busy.value = false
  }
}

async function save() {
  busy.value = true
  try {
    const r = await savePmConfig({ ...config.value, apiKey: apiKey.value || undefined })
    if (r.ok && r.config) {
      config.value = r.config
      apiKey.value = ''
      msg.value = '配置已保存（立即生效）'
      await store.refreshPmState()
    } else {
      msg.value = r.error || '保存失败'
    }
  } finally {
    busy.value = false
  }
}

function fmtTime(ms: number) {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
}

/** 日期分隔用的「几月几日」与跨天判定（时间轴按天分组） */
function fmtDay(ms: number) {
  const d = new Date(ms)
  return d.getMonth() + 1 + ' 月 ' + d.getDate() + ' 日'
}
function dayKey(ms: number) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate()
}

/**
 * 决策分级：PM 绝大多数 tick 是「没新事件 → 不动作」，这类是噪音，必须和
 * 「真的动了手 / 失败 / 被驳回」区分开，否则时间轴看下来全是同样的段落。
 */
type DecisionKind = 'error' | 'rejected' | 'action' | 'noop'

/** 真实动作：PM 无事可做时会回一个 kind=noop 的动作占位，applied 照样 +1，不能拿 applied 判断 */
function realActions(d: PmDecisionView) {
  return d.actions.filter(a => a.kind !== 'noop')
}

function kindOf(d: PmDecisionView): DecisionKind {
  if (d.error) return 'error'
  if (d.rejected?.length) return 'rejected'
  if (realActions(d).length) return 'action'
  return 'noop'
}

/** 重要 = 失败了 / 有动作被驳回 / 真的执行了动作；其余都算「无动作的例行 tick」 */
function isImportant(d: PmDecisionView) {
  return kindOf(d) !== 'noop'
}

/** 节点颜色：失败琥珀 / 被驳回天蓝 / 有动作翡翠 / 无动作灰（弱化） */
function dotClass(d: PmDecisionView) {
  const k = kindOf(d)
  if (k === 'error') return 'bg-amber-500'
  if (k === 'rejected') return 'bg-sky-500'
  if (k === 'action') return 'bg-emerald-500'
  return 'bg-muted-foreground/35'
}

/** 行内小标签：只给「重要」的行加，noop 不加标签保持安静 */
function kindLabel(d: PmDecisionView) {
  const k = kindOf(d)
  if (k === 'error') return { text: '失败', cls: 'bg-amber-500/15 text-amber-600' }
  if (k === 'rejected') return { text: '有驳回', cls: 'bg-sky-500/15 text-sky-600' }
  if (k === 'action') return { text: '已动作', cls: 'bg-emerald-500/15 text-emerald-600' }
  return null
}

/** 轴线只在节点之间延伸：首个节点不向上、末个节点不向下画线头 */
function axisClass(i: number, total: number) {
  const first = i === 0
  const last = i === total - 1
  if (first && last) return 'hidden'
  if (first) return 'top-[5px] bottom-0'
  if (last) return 'top-0 h-[9px]'
  return 'top-0 bottom-0'
}

// 搜索命中集：匹配推理、错误、驳回原因与事件数（「只看重要」不参与，供计数复用）
const matched = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return decisions.value
  return decisions.value.filter(d =>
    (d.reasoning ?? '').toLowerCase().includes(q) ||
    (d.error ?? '').toLowerCase().includes(q) ||
    d.rejected?.some(r => r.reason.toLowerCase().includes(q)) ||
    String(d.eventCount) === q,
  )
})

/** 真正渲染的集合：再看用户是否只要重要的 */
const filtered = computed(() => (onlyImportant.value ? matched.value.filter(isImportant) : matched.value))

/** 头部计数：当前搜索范围里「重要」有多少条，用来一眼看出噪音占比 */
const importantCount = computed(() => matched.value.filter(isImportant).length)
const noopCount = computed(() => matched.value.length - importantCount.value)

/** 空态文案：区分「真没有记录」「搜索没命中」「全是例行被隐藏了」 */
const emptyText = computed(() => {
  if (matched.value.length && !filtered.value.length) {
    return `这 ${matched.value.length} 条都是例行 tick（无动作），已隐藏；点右上「全部」可查看`
  }
  return search.value
    ? '没有匹配的决策记录'
    : '还没有重要决策。开启 PM 接管后，真正动了手 / 失败 / 被驳回的判断会留在这里。'
})

/** 懒加载：只渲染前 visibleCount 条，其余等用户滚到底/点按钮再追加 */
const visible = computed(() => filtered.value.slice(0, visibleCount.value))
const hasMore = computed(() => visibleCount.value < filtered.value.length)
const restCount = computed(() => Math.max(0, filtered.value.length - visibleCount.value))

/** 展开状态：按行下标记，默认全部收起（时间轴先给轮廓，细节按需展开） */
const expanded = ref<Record<number, boolean>>({})

/** 渲染行：预先算好「这条要不要插日期分隔」，模板里就不必按下标回看前一条 */
const rows = computed(() => {
  let prev = ''
  return visible.value.map(d => {
    const k = dayKey(d.at)
    const showDay = k !== prev
    prev = k
    return { d, showDay, kind: kindOf(d), label: kindLabel(d), acts: realActions(d).length }
  })
})

function loadMore() {
  if (!hasMore.value || decisionsLoading.value) return
  visibleCount.value += PAGE_STEP
}

// 搜索条件变化 → 回到第一批，避免停在「搜出 3 条却显示空了」；展开态一并复位（行下标已变）
watch(search, () => {
  visibleCount.value = PAGE_STEP
  expanded.value = {}
})

// 触底哨兵：滚到列表底部自动追加，不用手点
const sentinel = ref<HTMLElement | null>(null)
let io: IntersectionObserver | undefined
watch(sentinel, el => {
  io?.disconnect()
  io = undefined
  if (!el) return
  io = new IntersectionObserver(
    entries => { if (entries.some(e => e.isIntersecting)) loadMore() },
    { rootMargin: '160px' },
  )
  io.observe(el)
})
onUnmounted(() => { io?.disconnect(); io = undefined })

// 打开页面即开始自动刷新：决策是后台发生的，不刷就看不见
onMounted(() => {
  load()
  decisionsTimer = setInterval(loadDecisions, 5000)
})
onUnmounted(() => {
  if (decisionsTimer) clearInterval(decisionsTimer)
})
defineExpose({ reload: load })
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- 状态卡：当前派发权归谁，一眼可见 -->
    <Card :class="degraded ? 'border-amber-500/60' : active ? 'border-blue-500/50' : ''">
      <CardHeader>
        <div class="flex items-center gap-2">
          <Bot class="h-4 w-4" :class="active ? 'text-blue-500' : degraded ? 'text-amber-500' : 'text-muted-foreground'" />
          <CardTitle class="text-sm">Supervisor</CardTitle>
          <Badge
            variant="outline"
            class="ml-auto"
            :class="degraded ? 'border-amber-500/70 text-amber-600' : active ? 'border-blue-500/60 text-blue-500' : ''"
          >
            {{ degraded ? 'PM 降级' : active ? 'PM 接管' : '人工模式' }}
          </Badge>
        </div>
        <CardDescription>
          {{
            degraded
              ? 'PM 超过 60s 未成功决策，派发权已自动放行。恢复需人工确认，不会自动切回。'
              : active
                ? '派发权归 PM：跨工单派发须经 Supervisor，同工单返工与留言仍放行。'
                : '派发权归人：所有派发直接放行，PM 不参与判断。'
          }}
        </CardDescription>
      </CardHeader>
      <CardContent class="flex items-center gap-2">
        <Button size="sm" :variant="active || degraded ? 'outline' : 'default'" :disabled="busy" @click="toggle">
          <Square v-if="active || degraded" class="h-3.5 w-3.5" />
          <Play v-else class="h-3.5 w-3.5" />
          {{ active || degraded ? '收回派发权' : '交给 PM 接管' }}
        </Button>
        <Button v-if="!active" size="sm" variant="ghost" :disabled="busy" @click="probe">
          <Zap class="h-3.5 w-3.5" />
          测试模型
        </Button>
        <span v-if="msg" class="text-xs" :class="msgKind === 'error' ? 'text-destructive' : 'text-muted-foreground'">
          {{ msg }}
        </span>
      </CardContent>
    </Card>

    <!-- 模型配置：本地模型直接填 ollama/vLLM 地址即可 -->
    <Card v-if="loaded">
      <CardHeader>
        <CardTitle class="text-sm">模型</CardTitle>
        <CardDescription>
          {{
            config.provider === 'workbuddy'
              ? '直连本机 WorkBuddy 桌面版：复用它的登录态，不用填地址和 key。'
              : '任意 OpenAI 兼容端点。本地模型填 http://127.0.0.1:11434/v1 这类地址，key 可留空。'
          }}
        </CardDescription>
      </CardHeader>
      <CardContent class="grid gap-3">
        <p v-if="!wb.available" class="text-xs text-muted-foreground">{{ wb.reason }}</p>

        <Tabs
          :model-value="config.provider"
          @update:model-value="(v: string | number) => v === 'workbuddy' ? useWorkbuddy() : (config.provider = 'openai')"
        >
          <TabsList class="w-fit">
            <TabsTrigger value="openai" class="text-xs">通用端点</TabsTrigger>
            <TabsTrigger
              value="workbuddy"
              class="gap-1 text-xs"
              :disabled="!wb.available"
              :title="wb.available ? '直连本机 WorkBuddy' : wb.reason"
            >
              <Zap class="h-3.5 w-3.5" />
              直连 WorkBuddy
            </TabsTrigger>
          </TabsList>

          <TabsContent value="workbuddy" class="grid gap-1.5 mt-1">
            <Label class="text-xs">模型</Label>
            <Select v-model="config.model">
              <SelectTrigger class="h-8 w-full text-xs">
                <SelectValue :placeholder="wbLoading ? '正在读取模型列表…' : '选择模型…'" />
              </SelectTrigger>
              <SelectContent class="max-h-72">
                <SelectItem v-for="m in wb.models" :key="m" :value="m" class="text-xs">
                  {{ m }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p v-if="wbLoading" class="text-[11px] text-muted-foreground">正在解凭据并读取模型列表…</p>
            <p v-else-if="wbError" class="text-[11px] text-destructive">{{ wbError }}</p>
            <p v-else-if="wb.models.length" class="text-[11px] text-muted-foreground">
              共 {{ wb.models.length }} 个可用模型，来自本机 WorkBuddy 账号
            </p>
          </TabsContent>

          <TabsContent value="openai" class="mt-1">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-1.5">
              <Label class="text-xs">baseUrl</Label>
              <Input v-model="config.baseUrl" class="h-8 text-xs" placeholder="http://127.0.0.1:11434/v1" />
            </div>
            <div class="grid gap-1.5">
              <Label class="text-xs">模型名</Label>
              <Input v-model="config.model" class="h-8 text-xs" placeholder="qwen2.5:14b" />
            </div>
          </div>
          <div class="grid gap-1.5">
            <Label class="text-xs">
              apiKey
              <span class="ml-1 text-muted-foreground">{{ config.apiKeyConfigured ? '（已配置，留空表示不修改）' : '（未配置，本地模型可留空）' }}</span>
            </Label>
            <Input v-model="apiKey" type="password" class="h-8 text-xs" placeholder="sk-..." autocomplete="off" />
          </div>
          </TabsContent>
        </Tabs>
        <div class="grid gap-3 sm:grid-cols-3">
          <div class="grid gap-1.5">
            <Label class="text-xs">温度</Label>
            <Input v-model.number="config.temperature" type="number" step="0.1" min="0" max="2" class="h-8 text-xs" />
          </div>
          <div class="grid gap-1.5">
            <Label class="text-xs">一次决策最多动作数</Label>
            <Input v-model.number="config.maxActionsPerDecision" type="number" min="1" class="h-8 text-xs" />
          </div>
          <div class="grid gap-1.5">
            <Label class="text-xs">超时 ms</Label>
            <Input v-model.number="config.timeoutMs" type="number" min="5000" step="1000" class="h-8 text-xs" />
          </div>
        </div>
        <div class="flex items-center gap-2">
          <Button size="sm" :disabled="busy" @click="save">保存配置</Button>
          <Button size="sm" variant="ghost" @click="load">重新读取</Button>
        </div>
      </CardContent>
    </Card>

    <!-- 决策流：PM 每次判断的推理与落地结果 -->
    <Card>
      <CardHeader>
        <div class="flex items-center gap-2">
          <CardTitle class="text-sm">决策流</CardTitle>
          <div class="ml-auto flex items-center gap-2">
            <span v-if="decisionsLoading" class="text-[10px] text-muted-foreground">刷新中…</span>
            <span v-else class="flex items-center gap-1 text-[10px] text-muted-foreground">
              <i class="size-1.5 animate-pulse rounded-full bg-emerald-500" />5s 自动刷新
            </span>
            <Badge variant="outline" class="text-[10px]">
              重要 {{ importantCount }}
              <span v-if="onlyImportant && noopCount" class="text-muted-foreground/70">（隐藏 {{ noopCount }} 条例行）</span>
            </Badge>
          </div>
        </div>
        <CardDescription>每次事件批处理的推理、动作与驳回原因</CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-2">
        <!-- 搜索：推理 / 错误 / 驳回原因 / 事件数 -->
        <div class="flex items-center gap-2">
          <div class="relative flex-1">
            <Search class="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input v-model="search" class="h-8 pl-8 text-xs" placeholder="搜索决策…" />
          </div>
          <!-- 一键滤掉「无动作的例行 tick」：区分重要/不重要靠这个开关 + 节点配色 -->
          <button
            type="button"
            class="h-8 shrink-0 rounded-md border px-2.5 text-[11px] transition-colors"
            :class="onlyImportant
              ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-600'
              : 'border-border text-muted-foreground hover:text-foreground'"
            :aria-pressed="onlyImportant"
            data-testid="only-important"
            @click="onlyImportant = !onlyImportant"
          >{{ onlyImportant ? '仅看重要' : `全部 ${matched.length} 条` }}</button>
        </div>
        <!-- timeline：左侧时间列 + 贯穿轴线 + 无边框内容；滚到底自动加载下一批 -->
        <div v-if="visible.length" class="flex flex-col text-xs">
          <template v-for="(row, i) in rows" :key="row.d.at + '-' + i">
            <!-- 跨天插一条日期分隔，时间轴才有「时间流逝」的感觉 -->
            <div
              v-if="row.showDay"
              class="flex items-center gap-2 pb-1 pt-1.5 text-[10px] text-muted-foreground first:pt-0"
            >
              <span class="font-medium">{{ fmtDay(row.d.at) }}</span>
              <span class="h-px flex-1 bg-border/50" />
            </div>
            <div
              data-testid="decision-item"
              class="group relative flex gap-2.5"
              :data-kind="row.kind"
            >
              <!-- 时间列：定宽右对齐，轴线才有稳定基准 -->
              <span class="w-10 shrink-0 pt-px text-right font-mono text-[10px] leading-4 text-muted-foreground">
                {{ fmtTime(row.d.at).slice(0, 5) }}
              </span>
              <!-- 轴线：只在节点上下延伸，首个节点上方 / 末个节点下方不画多余线头 -->
              <span class="relative flex w-3 shrink-0 justify-center" aria-hidden="true">
                <span class="absolute left-1/2 w-px -translate-x-1/2 bg-border/70" :class="axisClass(i, rows.length)" />
                <span class="relative z-10 mt-[5px] size-[7px] shrink-0 rounded-full ring-4 ring-background" :class="dotClass(row.d)" />
              </span>
              <!-- 内容：不加边框/底色，靠左侧轴线与间距分组；hover 才给一层淡底 -->
              <div
                class="min-w-0 flex-1 -ml-1 rounded-md px-2 pt-px transition-colors group-hover:bg-accent/40"
                :class="row.kind === 'noop' ? 'opacity-65 pb-2' : 'pb-3'"
              >
                <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <!-- 重要行给明确标签；例行 tick 只留「无动作」的淡字，不抢视线 -->
                  <span
                    v-if="row.label"
                    class="rounded px-1.5 py-px text-[10px] font-medium"
                    :class="row.label.cls"
                  >{{ row.label.text }}</span>
                  <span
                    class="text-[11px]"
                    :class="row.kind === 'noop' ? 'text-muted-foreground/70' : 'text-muted-foreground'"
                  >{{ row.kind === 'noop' ? '无动作' : `动作 ${row.acts}` }}</span>
                  <span class="text-[10px] text-muted-foreground/80">{{ row.d.eventCount }} 事件 · {{ row.d.durationMs }}ms</span>
                </div>
                <!-- 推理默认只给一行：决策流要能一眼扫完；想细看再展开 -->
                <p
                  v-if="row.d.reasoning"
                  class="mt-0.5 leading-relaxed"
                  :class="expanded[i] ? 'whitespace-pre-wrap' : 'line-clamp-1'"
                >{{ row.d.reasoning }}</p>
                <button
                  v-if="row.d.reasoning.length > 48"
                  type="button"
                  class="mt-px text-[10px] text-sky-500/80 transition-opacity hover:text-sky-500 hover:underline"
                  :class="expanded[i] ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
                  @click="expanded[i] = !expanded[i]"
                >{{ expanded[i] ? '收起' : '展开全文' }}</button>
                <p v-if="row.d.error" class="mt-1 flex items-start gap-1 text-amber-600">
                  <CircleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" />{{ row.d.error }}
                </p>
                <ul v-if="row.d.rejected?.length" class="mt-1 flex flex-col gap-0.5 text-amber-600">
                  <li v-for="(r, j) in row.d.rejected" :key="j" class="flex items-start gap-1">
                    <TriangleAlert class="mt-0.5 h-3 w-3 shrink-0" />{{ r.reason }}
                  </li>
                </ul>
              </div>
            </div>
          </template>
        </div>
        <p v-if="!filtered.length" class="py-6 text-center text-muted-foreground">
          {{ emptyText }}
        </p>

        <!-- 懒加载尾部：进视口即自动追加；按钮兜底给不滚动的场景 -->
        <div v-if="filtered.length" ref="sentinel" class="flex flex-col items-center gap-1 border-t pt-2">
          <Button
            v-if="hasMore"
            data-testid="decision-loadmore"
            variant="outline"
            size="sm"
            class="h-7 px-3 text-xs"
            :disabled="decisionsLoading"
            @click="loadMore"
          >
            {{ decisionsLoading ? '加载中…' : `加载更早的 ${Math.min(restCount, PAGE_STEP)} 条` }}
          </Button>
          <span class="text-[10px] text-muted-foreground">
            共 {{ filtered.length }} 条 · 已加载 {{ visible.length }} 条{{ hasMore ? '' : ' · 已全部加载' }}
          </span>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
