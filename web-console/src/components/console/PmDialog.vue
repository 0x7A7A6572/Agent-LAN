<script setup lang="ts">
import { ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

const emit = defineEmits<{ (e: 'save', text: string): void }>()
const open = defineModel<boolean>('open', { default: false })
const draft = ref('')
const loaded = ref(false)

watch(open, async v => {
  if (v && !loaded.value) {
    try {
      draft.value = await fetch('/console/pm').then(r => {
        if (!r.ok) throw 0
        return r.text()
      })
      loaded.value = true
    } catch {
      draft.value = ''
    }
  }
})

function save() {
  emit('save', draft.value)
  open.value = false
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="flex h-[85vh] max-w-3xl flex-col gap-4 overflow-hidden">
      <DialogHeader>
        <DialogTitle>PM 设定</DialogTitle>
        <DialogDescription>保存后双写源文档与运行时模板，立即生效</DialogDescription>
      </DialogHeader>
      <Textarea v-model="draft" class="min-h-0 flex-1 resize-none font-mono text-xs" />
      <DialogFooter>
        <Button variant="outline" @click="open = false">取消</Button>
        <Button @click="save">保存</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
