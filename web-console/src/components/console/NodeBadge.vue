<script setup lang="ts">
import { computed } from 'vue'
import { logoOf } from '@/composables/useLogo'
import type { Presence } from '@/types/console'

// 节点的一行式展示：下拉项与工单表格共用，保证两处视觉一致
const props = withDefaults(
  defineProps<{
    presence?: Presence
    /** 找不到节点（已删除/未注册）时只显示名字 */
    fallbackName?: string
    /** 紧凑模式：表格单元格用，隐藏角色徽章只留状态点 */
    compact?: boolean
    size?: 'sm' | 'md'
    /** 撑满父容器并把状态推到行尾（下拉项用） */
    fill?: boolean
  }>(),
  { size: 'md', compact: false, fill: false },
)

const name = computed(() => props.presence?.card.name ?? props.fallbackName ?? '未指派')
const logo = computed(() =>
  props.presence ? logoOf(props.presence.card.name, props.presence.agent) : null,
)
const online = computed(() => props.presence?.online === true)
const working = computed(() => online.value && props.presence?.state === 'working')
const waiting = computed(() => !!props.presence?.waitingFor)
const queued = computed(() => props.presence?.queuedCount ?? 0)

/** 状态色与拓扑、节点卡、下拉全部共用一套：绿空闲 蓝执行 琥珀等人工 灰离线 */
const dotClass = computed(() =>
  waiting.value
    ? 'bg-amber-500'
    : working.value
      ? 'bg-blue-500'
      : online.value
        ? 'bg-emerald-500'
        : 'bg-muted-foreground/40',
)

const statusText = computed(() =>
  waiting.value ? '等人工' : working.value ? '执行中' : online.value ? '空闲' : '离线',
)

const unknown = computed(() => !props.presence && !!props.fallbackName)
const avatarSize = computed(() => (props.size === 'sm' ? 'size-3.5' : 'size-4'))
</script>

<template>
  <span class="flex min-w-0 items-center gap-1.5" :class="fill ? 'w-full' : ''">
    <!-- 已删除/未注册的节点：只留一个灰点，不装作在线 -->
    <template v-if="unknown">
      <i class="size-1.5 shrink-0 rounded-full bg-muted-foreground/30" />
      <span class="truncate text-muted-foreground">{{ name }}</span>
    </template>

    <template v-else>
      <img v-if="logo" :src="logo" alt="" :class="[avatarSize, 'shrink-0 rounded object-contain']" />
      <span
        v-else
        :class="[avatarSize, 'flex shrink-0 items-center justify-center rounded bg-muted text-[9px] font-semibold']"
      >
        {{ name.slice(0, 2).toUpperCase() }}
      </span>

      <span class="truncate font-medium">{{ name }}</span>

      <span
        v-if="!compact && presence?.role"
        class="shrink-0 rounded bg-foreground/[0.07] px-1.5 py-0.5 text-[10px] text-muted-foreground"
      >
        {{ presence.role }}
      </span>

      <span v-if="queued > 0" class="shrink-0 text-[10px] text-amber-600">排队 {{ queued }}</span>

      <span class="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground" :class="fill ? 'ml-auto' : ''">
        <i class="size-1.5 rounded-full" :class="dotClass" />
        <span :class="compact ? 'hidden xl:inline' : ''">{{ statusText }}</span>
      </span>
    </template>
  </span>
</template>
