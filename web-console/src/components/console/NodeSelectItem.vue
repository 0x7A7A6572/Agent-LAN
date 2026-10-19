<script setup lang="ts">
import { computed } from 'vue'
import { SelectItem } from '@/components/ui/select'
import NodeBadge from './NodeBadge.vue'
import type { Presence } from '@/types/console'

const props = defineProps<{
  presence: Presence
  /** 是否要求在线才能选（默认允许离线，方便提前排单） */
  onlineOnly?: boolean
}>()

// 演示节点是本地占位，派给它服务端会报「目标不在线或未知」，选它就等于选了个坑
const disabled = computed(
  () => props.presence.demo === true || (props.onlineOnly === true && !props.presence.online),
)
</script>

<template>
  <SelectItem :value="presence.card.name" :disabled="disabled" class="py-1.5">
    <!-- 与工单表格的处理人列共用同一个展示组件，两处永远一致 -->
    <NodeBadge :presence="presence" fill />
  </SelectItem>
</template>
