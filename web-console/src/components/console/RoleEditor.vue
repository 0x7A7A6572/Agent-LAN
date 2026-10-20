<script setup lang="ts">
import { ref, watch } from 'vue'
import { Plus, X } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const props = defineProps<{ roles: string[] }>()
const emit = defineEmits<{ (e: 'save', roles: string[]): void }>()

const rows = ref<{ value: string }[]>(props.roles.map(r => ({ value: r })))

watch(() => props.roles, v => {
  rows.value = v.map(r => ({ value: r }))
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
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div v-for="(row, i) in rows" :key="i" class="flex items-center gap-2">
      <Input v-model="row.value" :placeholder="'角色名，如 frontend / dev'" class="h-8" @keydown.enter="save" />
      <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive" @click="removeRow(i)">
        <X class="h-4 w-4" />
      </Button>
    </div>
    <div class="flex items-center gap-2">
      <Button variant="outline" size="sm" class="w-fit" @click="addRow">
        <Plus class="h-3.5 w-3.5" />
        添加角色
      </Button>
      <Button size="sm" class="ml-auto" @click="save">保存</Button>
    </div>
  </div>
</template>
