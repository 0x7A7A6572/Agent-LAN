<script setup lang="ts">
import {
  DialogRoot,
  DialogTrigger,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from 'reka-ui'
import { X } from 'lucide-vue-next'

defineProps<{ title?: string; description?: string }>()
const open = defineModel<boolean>('open', { default: false })
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogTrigger v-if="$slots.trigger" as-child>
      <slot name="trigger" />
    </DialogTrigger>
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/70 data-[state=open]:animate-in data-[state=closed]:animate-out" />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 shadow-2xl focus:outline-none data-[state=open]:animate-in"
      >
        <DialogTitle class="text-base font-semibold text-foreground">{{ title }}</DialogTitle>
        <DialogDescription v-if="description" class="mt-1 text-xs text-muted-foreground">{{ description }}</DialogDescription>
        <div class="mt-4">
          <slot />
        </div>
        <DialogClose
          class="absolute right-3 top-3 rounded-sm text-muted-foreground opacity-70 transition hover:opacity-100 focus:outline-none"
        >
          <X class="h-4 w-4" />
        </DialogClose>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
