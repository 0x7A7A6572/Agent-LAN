<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Check, Copy, FileText, RefreshCw } from 'lucide-vue-next'
import { ScrollArea } from '@/components/ui/scroll-area'

const content = ref('')
const loading = ref(false)
const copied = ref(false)

async function load() {
  loading.value = true
  try {
    const r = await fetch('/mcp/install.md')
    content.value = r.ok ? await r.text() : '加载失败：' + r.status
  } catch (e) {
    content.value = '加载失败：' + (e as Error).message
  } finally {
    loading.value = false
  }
}

async function copy() {
  try {
    await navigator.clipboard.writeText(content.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 1600)
  } catch {
    copied.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="flex h-[22rem] flex-col">
    <div class="flex items-center gap-2 pb-2">
      <div class="flex size-7 shrink-0 items-center justify-center rounded-lg border bg-foreground/[0.05]">
        <FileText class="h-4 w-4" />
      </div>
      <div class="min-w-0 flex-1 leading-tight">
        <p class="text-sm font-semibold">安装说明</p>
        <p class="truncate text-[11px] text-muted-foreground">/mcp/install.md · 可直接复制</p>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <button
          class="rounded-md border p-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          title="重新加载"
          :disabled="loading"
          @click="load"
        >
          <RefreshCw class="h-3.5 w-3.5" :class="loading ? 'animate-spin' : ''" />
        </button>
        <button
          class="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-foreground/5"
          :disabled="!content"
          @click="copy"
        >
          <Check v-if="copied" class="h-3.5 w-3.5" />
          <Copy v-else class="h-3.5 w-3.5" />
          {{ copied ? '已复制' : '复制全文' }}
        </button>
      </div>
    </div>
    <!-- 用 ScrollArea 替掉原生滚动条：无边框、悬停才显形 -->
    <ScrollArea type="hover" class="min-h-0 flex-1 rounded-lg border bg-muted/30">
      <div class="py-3 pr-3 pl-3">
        <pre v-if="!loading" class="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground">{{ content }}</pre>
        <span v-else class="text-xs text-muted-foreground">加载中…</span>
      </div>
    </ScrollArea>
  </div>
</template>
