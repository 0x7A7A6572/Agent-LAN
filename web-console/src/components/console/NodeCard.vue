<script setup lang="ts">
import { computed } from 'vue'
import { Cog } from 'lucide-vue-next'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import { logoOf } from '@/composables/useLogo'
import type { Presence } from '@/types/console'

const props = defineProps<{ presence: Presence }>()
const emit = defineEmits<{ (e: 'pick-role', name: string, role: string): void }>()

const statusVariant = computed(() => {
  if (!props.presence.online) return 'offline' as const
  return props.presence.state === 'working' ? ('working' as const) : ('online' as const)
})
const statusText = computed(() =>
  !props.presence.online ? '离线' : props.presence.state === 'working' ? '执行中' : '在线',
)
const logo = computed(() => logoOf(props.presence.card.name))
const meta = computed(
  () => (props.presence.card.description ?? '') + ' · 心跳 ' + new Date(props.presence.lastSeen).toLocaleTimeString('zh-CN', { hour12: false }),
)
</script>

<template>
  <div
    class="flex flex-col gap-1.5 rounded-md border bg-card px-3 py-2.5 transition-colors"
    :class="
      presence.online
        ? presence.state === 'working'
          ? 'border-blue-600'
          : 'border-green-600/60'
        : 'border-border opacity-55'
    "
  >
    <div class="flex items-center gap-2">
      <img v-if="logo" :src="logo" alt="" class="h-[18px] w-[18px] rounded bg-background object-contain" />
      <span
        class="h-2 w-2 shrink-0 rounded-full"
        :class="
          presence.online
            ? presence.state === 'working'
              ? 'bg-blue-400 shadow-[0_0_6px_#58a6ff]'
              : 'bg-green-400 shadow-[0_0_6px_#3fb950]'
            : 'bg-muted-foreground/40'
        "
      />
      <span class="truncate text-sm font-semibold text-foreground">{{ presence.card.name }}</span>
      <Badge :variant="statusVariant" class="ml-auto">{{ statusText }}</Badge>
    </div>
    <div class="truncate text-[11px] text-muted-foreground" :title="meta">{{ meta }}</div>
    <div
      v-if="presence.online && presence.state === 'working' && presence.workingOn"
      class="truncate text-[11px] text-blue-400"
    >
      ⚙ {{ presence.workingOn }}
    </div>
    <Button variant="outline" size="xs" class="w-fit" :class="presence.role ? 'text-blue-400 border-blue-600/50' : 'text-muted-foreground border-dashed'" @click="emit('pick-role', presence.card.name, presence.role ?? '')">
      <Cog class="h-3 w-3" />
      {{ presence.role || '设角色' }}
    </Button>
  </div>
</template>
