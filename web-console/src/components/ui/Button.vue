<script setup lang="ts">
import { computed } from 'vue'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80 border border-border',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        outline: 'border border-border bg-transparent hover:bg-accent hover:text-accent-foreground',
        success: 'bg-green-600 text-white hover:bg-green-600/90 shadow',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
      },
      size: {
        default: 'h-8 px-3 py-1.5',
        sm: 'h-7 rounded-md px-2.5 text-xs',
        xs: 'h-6 rounded-md px-2 text-[11px]',
        lg: 'h-9 rounded-md px-4',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

type Variants = VariantProps<typeof buttonVariants>

const props = withDefaults(
  defineProps<{
    variant?: Variants['variant']
    size?: Variants['size']
    class?: string
    type?: 'button' | 'submit'
    disabled?: boolean
    title?: string
  }>(),
  { type: 'button' },
)

const delegated = computed(() => {
  const { class: _, ...rest } = props
  return rest
})
</script>

<template>
  <button :class="cn(buttonVariants({ variant: props.variant, size: props.size }), props.class)" v-bind="delegated">
    <slot />
  </button>
</template>
