<script setup lang="ts">
import { computed } from 'vue'
import NodeCard from './NodeCard.vue'
import type { Presence } from '@/types/console'

const props = defineProps<{ presences: Presence[]; class?: string }>()
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
  <div class="flex flex-col gap-4 overflow-y-auto" :class="props.class">
    <div v-for="g in groups" :key="g.host" class="flex flex-col">
      <div
        class="flex items-center gap-2 rounded-t-md border border-b-0 px-3 py-2"
        :class="g.onlineCount ? 'border-green-600/60 bg-card' : 'border-border bg-card/60'"
      >
        <span class="h-2.5 w-2.5 rounded-sm" :class="g.onlineCount ? 'bg-green-400 shadow-[0_0_6px_#3fb950]' : 'bg-muted-foreground/40'" />
        <span class="text-sm font-semibold text-foreground">{{ g.host }}</span>
        <Badge variant="outline" class="ml-auto">{{ g.onlineCount }}/{{ g.members.length }} 在线</Badge>
      </div>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2.5 border px-3 py-3" :class="g.onlineCount ? 'border-green-600/60' : 'border-border'">
        <NodeCard v-for="p in g.members" :key="p.card.name" :presence="p" @pick-role="(n, r) => $emit('pick-role', n, r)" />
      </div>
    </div>
    <div v-if="!presences.length" class="py-10 text-center text-xs text-muted-foreground">暂无节点接入</div>
  </div>
</template>
