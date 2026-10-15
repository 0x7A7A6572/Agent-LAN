<script setup lang="ts">
import { ref } from 'vue'
import { Eraser } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { clearLogs } from '@/api/console'
import { useConsoleStore } from '@/stores/console'
import { useAutoLog } from '@/composables/useAutoLog'

const props = defineProps<{ logs: string[] }>()
const store = useConsoleStore()
const box = ref<HTMLElement | null>(null)
useAutoLog(() => box.value, () => props.logs.length)

async function onClear() {
  try {
    await clearLogs()
    store.logs = []
  } catch {}
}
</script>

<template>
  <div class="relative flex min-h-[60px] flex-1 flex-col">
    <!-- 右上角悬浮清空 -->
    <Button
      variant="ghost"
      size="sm"
      class="absolute right-2 top-2 z-10 gap-1 rounded-md bg-white/10 text-xs text-foreground backdrop-blur hover:bg-white/20"
      title="清空日志"
      @click="onClear"
    >
      <Eraser class="h-3 w-3" />
      清空
    </Button>
    <div ref="box" class="min-h-[60px] flex-1 overflow-y-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
      <div v-for="(l, i) in logs" :key="i" class="whitespace-pre-wrap">{{ l }}</div>
      <div v-if="!logs.length" class="text-muted-foreground">暂无日志</div>
    </div>
  </div>
</template>
