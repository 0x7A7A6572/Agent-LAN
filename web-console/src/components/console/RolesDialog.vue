<script setup lang="ts">
import { ref, watch } from 'vue'
import { Plus, X } from 'lucide-vue-next'
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

const props = defineProps<{ roles: string[] }>()
const emit = defineEmits<{ (e: 'save', roles: string[]): void }>()

const open = defineModel<boolean>('open', { default: false })
const rows = ref<{ value: string }[]>([])

watch(open, v => {
  if (v) rows.value = props.roles.map(r => ({ value: r }))
})

function addRow() {
  rows.value.push({ value: '' })
}

function removeRow(i: number) {
  rows.value.splice(i, 1)
}

function save() {
  const roles = rows.value.map(r => r.value.trim()).filter(Boolean)
  emit('save', [...new Set(roles)])
  open.value = false
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>角色库</DialogTitle>
        <DialogDescription>保存后全量替换，节点无需重连</DialogDescription>
      </DialogHeader>

      <div class="grid gap-2">
        <div v-for="(row, i) in rows" :key="i" class="flex items-center gap-2">
          <Input v-model="row.value" :placeholder="'角色名，如 frontend / dev'" class="h-8" @keydown.enter="save" />
          <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive" @click="removeRow(i)">
            <X class="h-4 w-4" />
          </Button>
        </div>
        <Button variant="outline" size="sm" class="w-fit" @click="addRow">
          <Plus class="h-3.5 w-3.5" />
          添加角色
        </Button>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="open = false">取消</Button>
        <Button @click="save">保存</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
