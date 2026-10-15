<script setup lang="ts">
import { ref, watch } from 'vue'
import Dialog from '@/components/ui/Dialog.vue'
import Button from '@/components/ui/Button.vue'
import Textarea from '@/components/ui/Textarea.vue'

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
  <Dialog v-model:open="open" title="PM 说明书" description="保存后双写源文档与运行时模板，立即生效">
    <Textarea v-model="draft" :rows="14" class="font-mono text-xs" />
    <div class="mt-4 flex justify-end gap-2">
      <Button variant="ghost" size="sm" @click="open = false">取消</Button>
      <Button size="sm" @click="save">保存</Button>
    </div>
  </Dialog>
</template>
