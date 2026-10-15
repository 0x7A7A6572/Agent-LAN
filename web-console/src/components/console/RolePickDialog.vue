<script setup lang="ts">
import { ref, watch } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const props = defineProps<{ roles: string[]; nodeName: string; current: string }>()
const emit = defineEmits<{ (e: 'pick', role: string): void }>()

const open = defineModel<boolean>('open', { default: false })
const picked = ref('')

watch(open, v => {
  if (v) picked.value = props.current
})

function confirm() {
  emit('pick', picked.value.trim().toLowerCase())
  open.value = false
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>设置 {{ nodeName }} 的角色</DialogTitle>
        <DialogDescription>点击选中，再次点击取消；留空即清除该节点角色</DialogDescription>
      </DialogHeader>
      <div class="flex flex-wrap gap-2">
        <Badge
          v-for="r in roles"
          :key="r"
          :variant="picked === r ? 'default' : 'outline'"
          class="cursor-pointer px-3 py-1 text-xs"
          @click="picked = picked === r ? '' : r"
        >
          {{ r }}
        </Badge>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="open = false">取消</Button>
        <Button @click="confirm">确定</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
