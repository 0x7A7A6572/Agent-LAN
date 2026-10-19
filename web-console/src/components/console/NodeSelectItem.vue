<script setup lang="ts">
import { computed } from 'vue'
import { SelectItem } from '@/components/ui/select'
import { logoOf } from '@/composables/useLogo'
import type { Presence } from '@/types/console'

const props = defineProps<{
  presence: Presence
  /** 是否要求在线才能选（默认允许离线，方便提前排单） */
  onlineOnly?: boolean
}>()

const online = computed(() => props.presence.online)
const working = computed(() => online.value && props.presence.state === 'working')
const waiting = computed(() => !!props.presence.waitingFor)
const logo = computed(() => logoOf(props.presence.card.name, props.presence.agent))
const queued = computed(() => props.presence.queuedCount ?? 0)

/** 状态点颜色与拓扑保持一致：绿空闲 / 蓝执行中 / 琥珀等人工 / 灰离线 */
const dotClass = computed(() =>
  waiting.value
    ? 'bg-amber-500'
    : working.value
      ? 'bg-blue-500'
      : online.value
        ? 'bg-emerald-500'
        : 'bg-muted-foreground/40',
)

const disabled = computed(() => props.onlineOnly === true && !online.value)
</script>

<template>
  <SelectItem :value="presence.card.name" :disabled="disabled" class="py-1.5">
    <div class="flex w-full items-center gap-2">
      <img v-if="logo" :src="logo" alt="" class="size-4 shrink-0 rounded object-contain" />
      <span v-else class="flex size-4 shrink-0 items-center justify-center rounded bg-muted text-[9px] font-semibold">
        {{ presence.card.name.slice(0, 2).toUpperCase() }}
      </span>

      <span class="truncate font-medium">{{ presence.card.name }}</span>

      <span v-if="presence.role" class="shrink-0 rounded bg-foreground/[0.07] px-1.5 py-0.5 text-[10px] text-muted-foreground">
        {{ presence.role }}
      </span>

      <span v-if="queued > 0" class="shrink-0 text-[10px] text-amber-600">排队 {{ queued }}</span>

      <!-- 状态行尾对齐，一眼扫出谁空着 -->
      <span class="ml-auto flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
        <i class="size-1.5 rounded-full" :class="dotClass" />
        {{ waiting ? '等人工' : working ? '执行中' : online ? '空闲' : '离线' }}
      </span>
    </div>
  </SelectItem>
</template>
