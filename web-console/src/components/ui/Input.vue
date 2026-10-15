<script setup lang="ts">
import { cn } from '@/lib/utils'

const model = defineModel<string>({ default: '' })
const props = defineProps<{ class?: string; placeholder?: string; type?: string }>()
</script>

<template>
  <input
    v-model="model"
    :type="props.type ?? 'text'"
    :placeholder="props.placeholder"
    :class="
      cn(
        'flex h-8 w-full rounded-md border border-border bg-input px-2.5 py-1 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
        props.class,
      )
    "
  />
</template>
