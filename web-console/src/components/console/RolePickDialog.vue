<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { faceDataUrl, roleVisual } from './role-catalog'
import type { RoleDef } from '@/types/console'

const props = defineProps<{ roles: RoleDef[]; nodeName: string; current: string }>()
const emit = defineEmits<{ (e: 'pick', role: string): void }>()

const open = defineModel<boolean>('open', { default: false })
const picked = ref('')

watch(open, v => {
  if (v) picked.value = props.current
})

const items = computed(() =>
  props.roles.map(r => ({
    name: r.name,
    desc: r.desc || '',
    img: faceDataUrl(roleVisual(r.name), r.name),
  })),
)

function confirm() {
  emit('pick', picked.value.trim().toLowerCase())
  open.value = false
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>设置 {{ nodeName }} 的角色</DialogTitle>
        <DialogDescription>点击选中，再次点击取消；留空即清除该节点角色</DialogDescription>
      </DialogHeader>

      <div class="grid max-h-[50vh] grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
        <button
          v-for="r in items"
          :key="r.name"
          class="flex items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors"
          :class="picked === r.name ? 'bg-foreground/[0.08] ring-1 ring-inset ring-foreground/20' : 'hover:bg-foreground/[0.045]'"
          @click="picked = picked === r.name ? '' : r.name"
        >
          <img :src="r.img" alt="" class="size-9 shrink-0 rounded-xl object-cover" />
          <div class="min-w-0 leading-tight">
            <p class="truncate text-sm font-semibold">{{ r.name }}</p>
            <p class="truncate text-xs text-muted-foreground">{{ r.desc || '未填职责' }}</p>
          </div>
          <Check v-if="picked === r.name" class="ml-auto h-4 w-4 shrink-0" />
        </button>
        <p v-if="!items.length" class="col-span-full py-6 text-center text-xs text-muted-foreground">角色库为空</p>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="open = false">取消</Button>
        <Button @click="confirm">确定</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
