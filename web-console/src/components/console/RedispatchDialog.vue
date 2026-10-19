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
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectTrigger, SelectValue } from '@/components/ui/select'
import NodeSelectItem from './NodeSelectItem.vue'
import type { Order, Presence } from '@/types/console'

const props = defineProps<{ presences: Presence[] }>()
const emit = defineEmits<{ (e: 'confirm', order: Order, assignee?: string): void }>()

const open = defineModel<boolean>('open', { default: false })
const order = ref<Order | null>(null)
const assignee = ref('')

watch(open, v => {
  if (v) assignee.value = order.value?.assignee ?? ''
})

function show(o: Order) {
  order.value = o
  open.value = true
}

function confirm() {
  if (order.value) emit('confirm', order.value, assignee.value || undefined)
  open.value = false
}

defineExpose({ show })
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>重新派发</DialogTitle>
        <DialogDescription>
          {{ order ? order.id + ' ' + order.title : '' }}
        </DialogDescription>
      </DialogHeader>

      <div class="grid gap-2">
        <Label>指派给</Label>
        <Select v-model="assignee">
          <SelectTrigger class="w-full"><SelectValue placeholder="选择节点…" /></SelectTrigger>
          <SelectContent class="min-w-[260px]">
            <NodeSelectItem v-for="p in presences" :key="p.card.name" :presence="p" />
          </SelectContent>
        </Select>
        <p class="text-xs text-muted-foreground">留空则沿用当前处理人。派发后工单回到 developing。</p>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="open = false">取消</Button>
        <Button @click="confirm">重新派发</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
