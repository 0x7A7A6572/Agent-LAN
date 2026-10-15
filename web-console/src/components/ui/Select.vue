<script setup lang="ts">
import { cn } from '@/lib/utils'

const model = defineModel<string>({ default: '' })
const props = defineProps<{ class?: string; options: { value: string; label: string }[] }>()
</script>

<template>
  <select
    v-model="model"
    :class="
      cn(
        'flex h-8 rounded-md border border-border bg-input px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        props.class,
      )
    "
  >
    <option v-for="o in props.options" :key="o.value" :value="o.value">{{ o.label }}</option>
  </select>
</template>
