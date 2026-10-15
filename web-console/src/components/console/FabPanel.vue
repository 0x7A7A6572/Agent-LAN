<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowUp } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { Presence } from '@/types/console'

const props = defineProps<{ presences: Presence[] }>()
const emit = defineEmits<{
  (e: 'send', to: string, text: string, mode: 'mail' | 'task'): void
}>()

const open = defineModel<boolean>('open', { default: false })
const target = ref('')
const mode = ref<'mail' | 'task'>('mail')
const text = ref('')
const sending = ref(false)

const targetOptions = computed(() =>
  [...props.presences]
    .map(p => ({ name: p.card.name, online: p.online }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
)

const MODES = [
  { value: 'mail', label: '留言' },
  { value: 'task', label: '派发任务' },
]

function submit() {
  const to = target.value
  const t = text.value.trim()
  if (!to || !t) return
  sending.value = true
  try {
    emit('send', to, t, mode.value)
    text.value = ''
    open.value = false
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <transition
    enter-active-class="transition duration-150 ease-out"
    enter-from-class="translate-y-2 opacity-0"
    leave-active-class="transition duration-100 ease-in"
    leave-to-class="translate-y-2 opacity-0"
  >
    <div v-if="open" class="w-[420px] max-w-[calc(100vw-3rem)] rounded-xl border bg-card p-3 shadow-2xl">
      <Textarea v-model="text" :rows="3" placeholder="输入内容…" class="border-0 bg-transparent shadow-none focus-visible:ring-0" @keydown.enter.exact.prevent="submit" />
      <div class="mt-1 flex items-center gap-2">
        <Select v-model="target">
          <SelectTrigger class="h-7 w-[150px] text-xs"><SelectValue placeholder="选择节点…" /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="o in targetOptions" :key="o.name" :value="o.name" class="text-xs">
              {{ o.name }}{{ o.online ? '' : '（离线）' }}
            </SelectItem>
          </SelectContent>
        </Select>
        <Select v-model="mode">
          <SelectTrigger class="h-7 w-[100px] text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="m in MODES" :key="m.value" :value="m.value" class="text-xs">{{ m.label }}</SelectItem>
          </SelectContent>
        </Select>
        <Button size="icon" class="ml-auto h-8 w-8 rounded-full" :disabled="sending" title="发送" @click="submit">
          <ArrowUp class="h-4 w-4" />
        </Button>
      </div>
    </div>
  </transition>
</template>
