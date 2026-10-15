<script setup lang="ts">
import { ref, watch } from 'vue'
import Dialog from '@/components/ui/Dialog.vue'
import Button from '@/components/ui/Button.vue'

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
  <Dialog v-model:open="open" :title="'设置 ' + nodeName + ' 的角色'" description="留空即清除该节点角色">
    <div class="flex flex-wrap gap-1.5">
      <button
        v-for="r in roles"
        :key="r"
        class="rounded-full border px-3 py-1 text-xs transition"
        :class="picked === r ? 'border-blue-600 bg-blue-600/15 text-blue-400' : 'border-border text-muted-foreground hover:border-blue-500 hover:text-blue-400'"
        @click="picked = picked === r ? '' : r"
      >
        {{ r }}
      </button>
    </div>
    <div class="mt-4 flex justify-end gap-2">
      <Button variant="ghost" size="sm" @click="open = false">取消</Button>
      <Button size="sm" @click="confirm">确定</Button>
    </div>
  </Dialog>
</template>
