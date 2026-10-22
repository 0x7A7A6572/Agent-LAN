<script setup lang="ts">
import { computed, ref } from 'vue'
import { Mail, MessageCircleQuestion, Check, Monitor, Pencil, TrendingUp, TriangleAlert } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { sendMail } from '@/api/console'
import { useConsoleStore } from '@/stores/console'
import { logoOf } from '@/composables/useLogo'
import type { Presence } from '@/types/console'

const props = defineProps<{ presence: Presence; active?: boolean }>()
const emit = defineEmits<{
  (e: 'pick-role', name: string, role: string): void
  (e: 'delete-node', name: string): void
  /** 卡片整体被点击：请求把 3D 视点导航到该节点 */
  (e: 'select', name: string): void
  /** 打开提问弹层（题卡空间由首页统一提供，卡片只做入口） */
  (e: 'answer', name: string): void
}>()

const store = useConsoleStore()
const logo = computed(() => logoOf(props.presence.card.name, props.presence.agent))
const working = computed(() => props.presence.online && props.presence.state === 'working')
// 等待人工确认：优先于执行中显示，是需要人介入的信号
const waiting = computed(() => props.presence.waitingFor || '')
// 只有心跳、没有长轮询：节点看着在线但收不到任务（worker.sh 已退出，只剩伴生心跳）
const staleOnly = computed(() => props.presence.online && !props.presence.mcpActive && !props.presence.state)
// 待处理留言：送达不等于在忙，只作提示，状态仍按真实执行态显示
const pendingMail = computed(() => props.presence.pendingMail || '')
const time = computed(() => new Date(props.presence.lastSeen).toLocaleTimeString('zh-CN', { hour12: false }))
// 设备分组：服务端算好的 groupHost（卡片 host > 来源 IP > url 兜底）
const group = computed(() => props.presence.groupHost || props.presence.card.host || props.presence.card.url)
// 状态只用圆点+文字表达，与拓扑图例同一套色：绿空闲 蓝执行 琥珀等人工 灰离线
const dotClass = computed(() =>
  waiting.value
    ? 'bg-amber-500'
    : working.value
      ? 'bg-blue-500'
      : staleOnly.value
        ? 'bg-orange-500'
        : pendingMail.value
          ? 'bg-sky-500'
          : props.presence.online
            ? 'bg-emerald-500'
            : 'bg-muted-foreground/40',
)
const statusText = computed(() => {
  if (waiting.value) return '等人工'
  if (working.value) return '执行中'
  if (staleOnly.value) return '仅心跳·不领活'
  if (pendingMail.value) return '待看留言'
  return props.presence.online ? '空闲' : '离线'
})

// 留言弹窗：目标即本卡节点
const mailOpen = ref(false)
const mailText = ref('')
const sending = ref(false)

function log(line: string) {
  store.logs = [...store.logs, line]
}

// 右键菜单：定位显示，含删除项；确认后才真正删除
const menuOpen = ref(false)
const menuPos = ref({ x: 0, y: 0 })

function onContextmenu(e: MouseEvent) {
  e.preventDefault()
  menuPos.value = { x: e.clientX, y: e.clientY }
  menuOpen.value = true
}

function requestDelete() {
  menuOpen.value = false
  if (!confirm('删除节点记录 ' + props.presence.card.name + ' ？\n仍在线的节点会在下次心跳重新出现。')) return
  emit('delete-node', props.presence.card.name)
}

async function send() {
  const t = mailText.value.trim()
  if (!t) return
  sending.value = true
  try {
    const r = await sendMail(props.presence.card.name, t)
    if (r.error) log('[mail] 发送失败: ' + r.error.message)
    else log('[mail] 我 -> ' + props.presence.card.name + ': ' + t)
    mailText.value = ''
    mailOpen.value = false
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <Card
    class="flex cursor-pointer flex-col gap-3 py-4 pb-1 transition-colors"
    :class="active ? 'ring-2 ring-blue-500/50' : ''"
    title="点击在 3D 拓扑中定位该节点"
    @click="emit('select', presence.card.name)"
    @contextmenu="onContextmenu"
  >
    <CardHeader class="px-4">
      <div class="flex items-center gap-2">
        <img v-if="logo" :src="logo" alt="" class="size-5 rounded object-contain" />
        <CardTitle class="text-sm font-medium">{{ presence.card.name }}</CardTitle>
        <span
          class="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
          :title="waiting ? '等待人工确认：' + waiting : working ? '执行中' : staleOnly ? '只有心跳、没有长轮询：看着在线但收不到任务，需重启 worker.sh' : presence.online ? '空闲' : '离线'"
        >
          <i class="size-2 rounded-full" :class="[dotClass, working && !waiting ? 'animate-pulse' : '']" />
          {{ statusText }}
        </span>
      </div>
      <button
        class="mt-2 flex items-center gap-1 text-left text-xl font-semibold leading-none hover:text-blue-500"
        :class="presence.role ? '' : 'text-muted-foreground/60'"
        title="点击设定角色"
        @click.stop="emit('pick-role', presence.card.name, presence.role || '')"
      >
        {{ presence.role || '设定角色' }}
        <Pencil class="h-3.5 w-3.5 opacity-50" />
      </button>
      <p v-if="waiting" class="flex items-start gap-1 text-sm font-medium text-amber-600">
        <TriangleAlert class="mt-0.5 h-4 w-4 shrink-0" />
        <span class="line-clamp-2">等待人工：{{ waiting }}</span>
      </p>
      <!-- 结构化提问只给入口：卡片太窄，题卡放不下，实答在弹层里（ConsoleHome 统一托管） -->
      <Button
        v-if="presence.question && !presence.question.answer"
        size="xs"
        variant="outline"
        class="mt-1 w-fit gap-1 border-amber-500/50 text-amber-600 hover:bg-amber-500/10"
        @click.stop="emit('answer', presence.card.name)"
      >
        <MessageCircleQuestion class="size-3.5" />
        回答{{ presence.question.questions.length > 1 ? `（${presence.question.questions.length} 问）` : '' }}
      </Button>
      <p v-else-if="presence.question?.answer" class="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
        <Check class="h-3.5 w-3.5 text-emerald-500" />
        已答复 {{ new Date(presence.question.answer.at).toLocaleTimeString('zh-CN', { hour12: false }) }} · 待节点确认
      </p>
      <p class="flex items-center gap-1 line-clamp-1 text-sm text-muted-foreground">
        <TrendingUp v-if="working" class="h-4 w-4 text-blue-500" />
        {{ working ? (presence.workingOn || '执行中') : presence.online ? '可领取任务' : '不在线' }}
        <span v-if="(presence.queuedCount ?? 0) > 0" class="rounded bg-yellow-500/15 px-1.5 text-xs text-yellow-600">
          排队 {{ presence.queuedCount }}
        </span>
      </p>
      <!-- 待处理留言：不置执行态，只作提示 -->
      <p v-if="presence.pendingMail" class="flex items-center gap-1 line-clamp-1 text-sm text-sky-500">
        <Mail class="h-4 w-4 shrink-0" />
        <span class="truncate" :title="presence.pendingMail">{{ presence.pendingMail }}</span>
      </p>
      <p class="text-xs text-muted-foreground/70">心跳 {{ time }}</p>
    </CardHeader>
    <!-- 底部：设备分组 + 留言入口 -->
    <CardContent class="mt-auto border-t px-3 pt-1">
      <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Monitor class="h-3.5 w-3.5 shrink-0" />
        <span class="truncate" :title="group">{{ group }}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          class="ml-auto text-muted-foreground"
          :title="presence.online ? '发留言' : '节点离线，也可留言'"
          @click.stop="mailOpen = true"
        >
          <Mail class="h-3.5 w-3.5" />
        </Button>
      </div>
    </CardContent>

    <!-- 右键菜单：fixed 定位，点别处/Escape 关闭 -->
    <Teleport to="body">
      <div v-if="menuOpen" class="fixed inset-0 z-50" @click="menuOpen = false" @contextmenu.prevent="menuOpen = false" />
      <div
        v-if="menuOpen"
        class="fixed z-50 min-w-40 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        :style="{ left: menuPos.x + 'px', top: menuPos.y + 'px' }"
      >
        <button
          class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
          @click="menuOpen = false, mailOpen = true"
        >
          <Mail class="h-3.5 w-3.5" /> 发留言
        </button>
        <button
          class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive hover:bg-accent"
          @click="requestDelete"
        >
          删除节点记录
        </button>
      </div>
    </Teleport>

    <!-- 留言弹窗 -->
    <Dialog v-model:open="mailOpen">
      <DialogContent class="gap-3 sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>发留言给 {{ presence.card.name }}</DialogTitle>
          <DialogDescription>以 human-console 身份投递到节点邮箱，节点下次领任务时收取</DialogDescription>
        </DialogHeader>
        <Textarea v-model="mailText" :rows="3" class="min-h-0 resize-none" placeholder="留言内容…" @keydown.enter.ctrl="send" />
        <DialogFooter>
          <Button variant="outline" @click="mailOpen = false">取消</Button>
          <Button :disabled="!mailText.trim() || sending" @click="send">发送</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </Card>
</template>