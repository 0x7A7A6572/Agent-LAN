<script setup lang="ts">
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva('inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium whitespace-nowrap', {
  variants: {
    variant: {
      default: 'bg-secondary text-secondary-foreground border border-border',
      online: 'bg-green-500/15 text-green-400 border border-green-600/40',
      working: 'bg-blue-500/15 text-blue-400 border border-blue-600/40',
      offline: 'bg-secondary/50 text-muted-foreground border border-border',
      outline: 'border border-border text-muted-foreground',
    },
  },
  defaultVariants: { variant: 'default' },
})

type Variants = VariantProps<typeof badgeVariants>
const props = defineProps<{ variant?: Variants['variant']; class?: string }>()
</script>

<template>
  <span :class="cn(badgeVariants({ variant: props.variant }), props.class)"><slot /></span>
</template>
