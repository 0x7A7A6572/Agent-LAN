<script setup lang="ts">
import { ref } from 'vue'
import { useAutoLog } from '@/composables/useAutoLog'

const props = defineProps<{ logs: string[] }>()
const box = ref<HTMLElement | null>(null)
useAutoLog(() => box.value, () => props.logs.length)
</script>

<template>
  <div ref="box" class="min-h-[60px] flex-1 overflow-y-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
    <div v-for="(l, i) in logs" :key="i" class="whitespace-pre-wrap">{{ l }}</div>
    <div v-if="!logs.length" class="text-muted-foreground">暂无日志</div>
  </div>
</template>
