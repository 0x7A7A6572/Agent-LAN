<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowUp } from 'lucide-vue-next'
import Select from '@/components/ui/Select.vue'
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

const targetOptions = computed(() => {
  const list = [...props.presences]
    .map(p => ({ name: p.card.name, online: p.online }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
  return list.map(x => ({ value: x.name, label: x.name + (x.online ? '' : '（离线）') }))
})

const modeOptions = [
  { value: 'mail', label: '留言' },
  { value: 'task', label: '派发任务' },
]

async function submit() {
  const to = target.value
  const t = text.value.trim()
  if (!to) return
  if (!t) return
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
  <!-- 展开时：底部上浮面板，codex 风格 -->
  <transition
    enter-active-class="transition duration-150 ease-out"
    enter-from-class="translate-y-2 opacity-0"
    leave-active-class="transition duration-100 ease-in"
    leave-to-class="translate-y-2 opacity-0"
  >
    <div v-if="open" class="flex flex-col gap-2 rounded-2xl border border-border bg-card p-3.5 shadow-2xl">
      <textarea
        v-model="text"
        placeholder="输入内容…"
        class="min-h-[56px] resize-none bg-transparent px-0.5 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
      />
      <div class="flex items-center gap-1">
        <Select v-model="target" :options="targetOptions" />
        <Select v-model="mode" :options="modeOptions" />
        <button
          class="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition hover:bg-blue-500 disabled:opacity-45"
          :disabled="sending"
          title="发送"
          @click="submit"
        >
          <ArrowUp class="h-4 w-4" />
        </button>
      </div>
    </div>
  </transition>
</template>
