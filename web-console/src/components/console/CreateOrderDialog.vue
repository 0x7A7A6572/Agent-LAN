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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { OrderPriority } from '@/types/console'

const props = defineProps<{ nodeNames: string[]; parent?: { id: string; title: string } | null }>()
const emit = defineEmits<{
  (e: 'create', body: { title: string; assignee?: string; priority: OrderPriority; parent?: string; description?: string }): void
}>()

const open = defineModel<boolean>('open', { default: false })
const title = ref('')
const description = ref('')
const assignee = ref('')
const priority = ref<OrderPriority>('normal')

watch(open, v => {
  if (v) {
    title.value = ''
    description.value = ''
    assignee.value = ''
    priority.value = 'normal'
  }
})

function submit() {
  const t = title.value.trim()
  if (!t) return
  emit('create', {
    title: t,
    assignee: assignee.value || undefined,
    priority: priority.value,
    parent: props.parent?.id,
    description: description.value.trim() || undefined,
  })
  open.value = false
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ parent ? '创建子工单' : '创建工单' }}</DialogTitle>
        <DialogDescription>
          {{ parent ? '父工单：' + parent.id + ' ' + parent.title : '建单后立即派发给所选节点' }}
        </DialogDescription>
      </DialogHeader>

      <div class="grid gap-4">
        <div class="grid gap-2">
          <Label for="order-title">标题</Label>
          <Input id="order-title" v-model="title" placeholder="工单标题…" @keydown.enter="submit" />
        </div>
        <div class="grid gap-2">
          <Label for="order-desc">描述</Label>
          <Textarea id="order-desc" v-model="description" :rows="3" placeholder="补充说明（可空）" />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="grid gap-2">
            <Label>指派给</Label>
            <Select v-model="assignee">
              <SelectTrigger class="w-full"><SelectValue placeholder="选择节点…" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="n in nodeNames" :key="n" :value="n">{{ n }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="grid gap-2">
            <Label>优先级</Label>
            <Select v-model="priority">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="normal">普通</SelectItem>
                <SelectItem value="high">高</SelectItem>
                <SelectItem value="urgent">紧急</SelectItem>
                <SelectItem value="low">低</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="open = false">取消</Button>
        <Button :disabled="!title.trim()" @click="submit">创建并派发</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
