<script setup lang="ts">
import { cn } from '@/lib/utils'

const model = defineModel<string>({ default: '' })
const props = defineProps<{ class?: string; placeholder?: string; rows?: number }>()
</script>

<template>
  <textarea
    v-model="model"
    :rows="props.rows ?? 3"
    :placeholder="props.placeholder"
    :class="
      cn(
        'flex w-full rounded-md border border-border bg-input px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        props.class,
      )
    "
  />
</template>
