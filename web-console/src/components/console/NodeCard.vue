<script setup lang="ts">
import { computed } from 'vue'
import { Cog } from 'lucide-vue-next'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { logoOf } from '@/composables/useLogo'
import type { Presence } from '@/types/console'

const props = defineProps<{ presence: Presence }>()
const emit = defineEmits<{ (e: 'pick-role', name: string, role: string): void }>()

const statusVariant = computed(() => {
  if (!props.presence.online) return 'secondary' as const
  return props.presence.state === 'working' ? ('default' as const) : ('outline' as const)
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
  <div class="flex flex-col gap-2 rounded-lg border p-3 transition-colors hover:bg-accent/40">
    <div class="flex items-center gap-2.5">
      <Avatar class="h-9 w-9 rounded-md">
        <AvatarImage v-if="logo" :src="logo" alt="" class="object-contain" />
        <AvatarFallback class="rounded-md text-xs">{{ presence.card.name.slice(0, 2).toUpperCase() }}</AvatarFallback>
      </Avatar>
      <div class="grid min-w-0 flex-1 gap-0.5">
        <span class="truncate text-sm font-medium leading-none">{{ presence.card.name }}</span>
        <span class="truncate text-xs text-muted-foreground">{{ presence.role || '未设角色' }}</span>
      </div>
      <Badge :variant="statusVariant" class="shrink-0">{{ statusText }}</Badge>
    </div>
    <div class="truncate text-xs text-muted-foreground" :title="meta">{{ meta }}</div>
    <div
      v-if="presence.online && presence.state === 'working' && presence.workingOn"
      class="truncate rounded bg-blue-500/10 px-2 py-1 text-xs text-blue-500"
    >
      ⚙ {{ presence.workingOn }}
    </div>
    <Button variant="outline" size="sm" class="w-fit" @click="emit('pick-role', presence.card.name, presence.role ?? '')">
      <Cog class="h-3.5 w-3.5" />
      设角色
    </Button>
  </div>
</template>
