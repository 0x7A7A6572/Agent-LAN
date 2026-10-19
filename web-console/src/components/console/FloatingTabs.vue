<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { FloatingTab } from './floating-tabs'

const props = defineProps<{
  tabs: FloatingTab[]
  modelValue: string
}>()

const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()

const railRef = ref<HTMLElement | null>(null)
const btnRefs = ref<HTMLElement[]>([])
const indicator = ref({ left: 0, width: 0 })

const activeIndex = computed(() => Math.max(0, props.tabs.findIndex(t => t.key === props.modelValue)))

/** 指示器跟随激活项：一次测量，避免每帧回流 */
async function syncIndicator() {
  await nextTick()
  const el = btnRefs.value[activeIndex.value]
  if (!el || !railRef.value) return
  indicator.value = { left: el.offsetLeft, width: el.offsetWidth }
}

function pick(key: string) {
  emit('update:modelValue', key)
}

watch(() => props.modelValue, syncIndicator)
watch(() => props.tabs.length, syncIndicator)
onMounted(syncIndicator)
// 字体载入/窗口缩放后宽度会变，重测一次
if (typeof window !== 'undefined') window.addEventListener('resize', syncIndicator)
</script>

<template>
  <div class="pointer-events-none fixed inset-x-0 bottom-7 z-30 flex justify-center px-4">
    <div
      ref="railRef"
      class="pointer-events-auto relative flex items-center gap-1.5 rounded-full border border-border/70 bg-background/92 p-2 shadow-2xl shadow-black/20 backdrop-blur-lg"
    >
      <!-- 滑动指示器：一个元素表达"当前在哪"，避免每颗按钮各自高亮 -->
      <span
        class="absolute inset-y-2 rounded-full bg-foreground/[0.09] transition-all duration-200 ease-out"
        :style="{ left: indicator.left + 'px', width: indicator.width + 'px' }"
      />
      <button
        v-for="(t, i) in tabs"
        :key="t.key"
        :ref="el => { if (el) btnRefs[i] = el as HTMLElement }"
        class="relative flex items-center gap-2.5 rounded-full px-7 py-3.5 text-base font-medium transition-colors"
        :class="modelValue === t.key ? 'text-foreground' : 'text-muted-foreground hover:text-foreground/80'"
        :title="t.label"
        @click="pick(t.key)"
      >
        <component :is="t.icon" class="h-5 w-5" :class="t.alert ? 'text-amber-500' : ''" />
        <span class="hidden sm:inline">{{ t.label }}</span>
        <span
          v-if="t.badge"
          class="ml-0.5 rounded-full bg-foreground/10 px-2 py-1 text-xs leading-none tabular-nums text-foreground/70"
        >
          {{ t.badge > 99 ? '99+' : t.badge }}
        </span>
        <span v-if="t.alert" class="size-2.5 animate-pulse rounded-full bg-amber-500" />
      </button>
    </div>
  </div>
</template>
