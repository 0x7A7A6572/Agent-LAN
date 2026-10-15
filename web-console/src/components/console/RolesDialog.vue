<script setup lang="ts">
import { ref, watch } from 'vue'
import Dialog from '@/components/ui/Dialog.vue'
import Button from '@/components/ui/Button.vue'
import Textarea from '@/components/ui/Textarea.vue'

const props = defineProps<{ roles: string[] }>()
const emit = defineEmits<{ (e: 'save', roles: string[]): void }>()

const open = defineModel<boolean>('open', { default: false })
const draft = ref('')

watch(open, v => {
  if (v) draft.value = props.roles.join(', ')
})

function save() {
  const roles = draft.value.split(/[\s,，]+/).map(s => s.trim()).filter(Boolean)
  emit('save', roles)
  open.value = false
}
</script>

<template>
  <Dialog v-model:open="open" title="角色库" description="逗号或空格分隔，保存后全量替换，节点无需重连">
    <Textarea v-model="draft" :rows="6" placeholder="pm / dev / qa …" />
    <div class="mt-4 flex justify-end gap-2">
      <Button variant="ghost" size="sm" @click="open = false">取消</Button>
      <Button size="sm" @click="save">保存</Button>
    </div>
  </Dialog>
</template>
