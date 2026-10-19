<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Bot, CircleAlert, Play, Square, TriangleAlert, Zap } from 'lucide-vue-next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Label } from '@/components/ui/label'
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
/** 提示消息的严重程度：失败要显眼，别被当成切换成功 */
const msgKind = ref<'ok' | 'error'>('ok')

const mode = computed(() => store.pmState.mode)
const active = computed(() => mode.value === 'pm')
const degraded = computed(() => mode.value === 'degraded')

async function load() {
  const c = await fetchPmConfig()
  if (c) { config.value = c; loaded.value = true }
  decisions.value = (await fetchPmDecisions(20)).decisions ?? []
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

onMounted(load)
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
          <Badge variant="outline" class="ml-auto text-[10px]">{{ decisions.length }}</Badge>
          <Button size="sm" variant="ghost" class="h-7" @click="load">刷新</Button>
        </div>
        <CardDescription>每次事件批处理的推理、动作与驳回原因</CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-2">
        <div
          v-for="(d, i) in decisions"
          :key="d.at + '-' + i"
          class="rounded-md border p-2.5 text-xs"
          :class="d.error ? 'border-amber-500/50 bg-amber-500/5' : ''"
        >
          <div class="flex items-center gap-2">
            <span class="font-mono text-muted-foreground">{{ fmtTime(d.at) }}</span>
            <Badge v-if="d.error" variant="outline" class="border-amber-500/60 text-[10px] text-amber-600">失败</Badge>
            <Badge v-else variant="outline" class="text-[10px]">执行 {{ d.applied }}/{{ d.actions.length }}</Badge>
            <span class="text-muted-foreground">{{ d.eventCount }} 事件 · {{ d.durationMs }}ms</span>
          </div>
          <p v-if="d.reasoning" class="mt-1 line-clamp-2">{{ d.reasoning }}</p>
          <p v-if="d.error" class="mt-1 flex items-start gap-1 text-amber-600">
            <CircleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" />{{ d.error }}
          </p>
          <ul v-if="d.rejected?.length" class="mt-1 flex flex-col gap-0.5 text-amber-600">
            <li v-for="(r, j) in d.rejected" :key="j" class="flex items-start gap-1">
              <TriangleAlert class="mt-0.5 h-3 w-3 shrink-0" />{{ r.reason }}
            </li>
          </ul>
        </div>
        <p v-if="!decisions.length" class="py-6 text-center text-muted-foreground">
          还没有决策记录。开启 PM 接管后，事件批次会在这里留下推理与执行结果。
        </p>
      </CardContent>
    </Card>
  </div>
</template>
