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
    <DialogContent class="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>PM 说明书</DialogTitle>
        <DialogDescription>保存后双写源文档与运行时模板，立即生效</DialogDescription>
      </DialogHeader>
      <Textarea v-model="draft" :rows="14" class="font-mono text-xs" />
      <DialogFooter>
        <Button variant="outline" @click="open = false">取消</Button>
        <Button @click="save">保存</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
