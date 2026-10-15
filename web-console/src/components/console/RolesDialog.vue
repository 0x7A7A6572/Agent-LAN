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
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>角色库</DialogTitle>
        <DialogDescription>逗号或空格分隔，保存后全量替换，节点无需重连</DialogDescription>
      </DialogHeader>
      <Textarea v-model="draft" :rows="6" placeholder="pm / dev / qa …" />
      <DialogFooter>
        <Button variant="outline" @click="open = false">取消</Button>
        <Button @click="save">保存</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
