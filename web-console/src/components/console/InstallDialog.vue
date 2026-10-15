<script setup lang="ts">
import { ref, watch } from 'vue'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const open = defineModel<boolean>('open', { default: false })
const content = ref('')
const loading = ref(false)

watch(open, async v => {
  if (v && !content.value) {
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
})
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="flex h-[80vh] max-w-3xl flex-col gap-3 overflow-hidden">
      <DialogHeader>
        <DialogTitle>安装说明</DialogTitle>
        <DialogDescription>agent 接入提示词（/mcp/install.md），可直接复制给要接入的 agent</DialogDescription>
      </DialogHeader>
      <div class="min-h-0 flex-1 overflow-y-auto rounded-lg border bg-muted/30 p-3">
        <pre v-if="!loading" class="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground">{{ content }}</pre>
        <span v-else class="text-xs text-muted-foreground">加载中…</span>
      </div>
    </DialogContent>
  </Dialog>
</template>
