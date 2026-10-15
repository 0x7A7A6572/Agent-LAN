<script setup lang="ts">
import { computed } from 'vue'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import NodeCard from './NodeCard.vue'
import type { Presence } from '@/types/console'

const props = defineProps<{ presences: Presence[] }>()
defineEmits<{ (e: 'pick-role', name: string, role: string): void }>()

const groupOf = (p: Presence) => p.groupHost || p.card.host || p.card.url

const groups = computed(() => {
  const map = new Map<string, Presence[]>()
  for (const p of [...props.presences].sort((a, b) => groupOf(a).localeCompare(groupOf(b)))) {
    const k = groupOf(p)
    if (!map.has(k)) map.set(k, [])
    map.get(k)!.push(p)
  }
  return [...map.entries()].map(([host, members]) => ({
    host,
    members,
    onlineCount: members.filter(m => m.online).length,
  }))
})
</script>

<template>
  <div class="flex flex-col gap-6">
    <div v-for="g in groups" :key="g.host" class="flex flex-col gap-3">
      <div class="flex items-center gap-2.5">
        <Avatar class="h-7 w-7">
          <AvatarFallback class="text-[10px]">{{ g.host.slice(0, 2).toUpperCase() }}</AvatarFallback>
        </Avatar>
        <span class="text-sm font-medium">{{ g.host }}</span>
        <Badge variant="outline" class="ml-auto">{{ g.onlineCount }}/{{ g.members.length }} 在线</Badge>
      </div>
      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <NodeCard v-for="p in g.members" :key="p.card.name" :presence="p" @pick-role="(n, r) => $emit('pick-role', n, r)" />
      </div>
    </div>
    <div v-if="!presences.length" class="py-10 text-center text-sm text-muted-foreground">暂无节点接入</div>
  </div>
</template>
