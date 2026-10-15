<script setup lang="ts">
import { computed } from 'vue'
import { ArrowUpRight, TrendingUp } from 'lucide-vue-next'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { logoOf } from '@/composables/useLogo'
import type { Presence } from '@/types/console'

const props = defineProps<{ presence: Presence }>()
const emit = defineEmits<{ (e: 'pick-role', name: string, role: string): void }>()

const logo = computed(() => logoOf(props.presence.card.name))
const working = computed(() => props.presence.online && props.presence.state === 'working')
const time = computed(() => new Date(props.presence.lastSeen).toLocaleTimeString('zh-CN', { hour12: false }))
</script>

<template>
  <Card
    class="gap-3 py-4 transition-colors"
    :class="working ? 'border-blue-600/60' : presence.online ? '' : 'opacity-55'"
    @click="emit('pick-role', presence.card.name, presence.role ?? '')"
  >
    <CardHeader class="px-4">
      <div class="flex items-center gap-2">
        <img v-if="logo" :src="logo" alt="" class="size-5 rounded object-contain" />
        <CardTitle class="text-sm font-medium">{{ presence.card.name }}</CardTitle>
        <Badge variant="outline" class="ml-auto gap-1">
          <span class="size-1.5 rounded-full" :class="presence.online ? 'bg-green-500' : 'bg-muted-foreground/40'" />
          {{ presence.online ? '在线' : '离线' }}
        </Badge>
      </div>
      <div class="mt-2 flex items-center text-xl font-semibold leading-none">
        {{ presence.role || '设定角色' }}
      </div>
      <p class="flex items-center gap-1 text-sm text-muted-foreground">
        <TrendingUp v-if="working" class="h-4 w-4 text-blue-500" />
        {{ working ? '执行中 · ' + (presence.workingOn || '') : '空闲 · 点击设定角色' }}
        <ArrowUpRight v-if="!presence.online" class="h-4 w-4" />
      </p>
      <p class="text-xs text-muted-foreground/70">{{ time }}</p>
    </CardHeader>
    <CardContent class="px-4" />
  </Card>
</template>
