<script setup lang="ts">
import { computed, ref } from 'vue'
import { Mail, Monitor, TrendingUp } from 'lucide-vue-next'
import { Badge } from '@/components/ui/badge'
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

const props = defineProps<{ presence: Presence }>()
const emit = defineEmits<{ (e: 'pick-role', name: string, role: string): void }>()

const store = useConsoleStore()
const logo = computed(() => logoOf(props.presence.card.name))
const working = computed(() => props.presence.online && props.presence.state === 'working')
const time = computed(() => new Date(props.presence.lastSeen).toLocaleTimeString('zh-CN', { hour12: false }))
// 设备分组：服务端算好的 groupHost（卡片 host > 来源 IP > url 兜底）
const group = computed(() => props.presence.groupHost || props.presence.card.host || props.presence.card.url)

// 留言弹窗：目标即本卡节点
const mailOpen = ref(false)
const mailText = ref('')
const sending = ref(false)

function log(line: string) {
  store.logs = [...store.logs, line]
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
    class="flex flex-col gap-3 py-4 transition-colors"
    :class="working ? 'border-blue-600/60' : presence.online ? '' : 'opacity-55'"
  >
    <CardHeader class="px-4">
      <div class="flex items-center gap-2">
        <img v-if="logo" :src="logo" alt="" class="size-5 rounded object-contain" />
        <CardTitle class="text-sm font-medium">{{ presence.card.name }}</CardTitle>
        <Badge variant="outline" class="ml-auto gap-1">
          <span class="size-1.5 rounded-full" :class="presence.online ? 'bg-green-500' : 'bg-muted-foreground/40'" />
          {{ presence.online ? '在线' : '离线' }}
        </Badge>
      </div>
      <div class="mt-2 flex items-center text-xl font-semibold leading-none">
        {{ presence.role || '设定角色' }}
      </div>
      <p class="flex items-center gap-1 text-sm text-muted-foreground">
        <TrendingUp v-if="working" class="h-4 w-4 text-blue-500" />
        {{ working ? '执行中 · ' + (presence.workingOn || '') : presence.online ? '空闲' : '离线' }}
      </p>
      <p class="text-xs text-muted-foreground/70">心跳 {{ time }}</p>
    </CardHeader>
    <!-- 底部：设备分组 + 留言入口 -->
    <CardContent class="mt-auto border-t px-4 pt-3">
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

    <!-- 留言弹窗 -->
    <Dialog v-model:open="mailOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>发留言给 {{ presence.card.name }}</DialogTitle>
          <DialogDescription>以 human-console 身份投递到节点邮箱，节点下次领任务时收取</DialogDescription>
        </DialogHeader>
        <Textarea v-model="mailText" :rows="4" placeholder="留言内容…" @keydown.enter.ctrl="send" />
        <DialogFooter>
          <Button variant="outline" @click="mailOpen = false">取消</Button>
          <Button :disabled="!mailText.trim() || sending" @click="send">发送</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </Card>
</template>
