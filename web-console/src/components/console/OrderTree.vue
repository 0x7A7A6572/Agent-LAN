<script setup lang="ts">
import { computed } from 'vue'
import { ChevronDown, ChevronRight, User } from 'lucide-vue-next'
import Badge from '@/components/ui/Badge.vue'
import Select from '@/components/ui/Select.vue'
import type { Order, OrderStatus } from '@/types/console'

const props = defineProps<{
  orders: Order[]
  allOrders: Order[]
}>()
const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'status-change', id: string, status: OrderStatus): void
  (e: 'create-child', parent: Order): void
}>()

const STATUSES: OrderStatus[] = ['backlog', 'analyzing', 'developing', 'testing', 'review', 'done', 'canceled']
const statusOptions = STATUSES.map(s => ({ value: s, label: s }))

const expanded = defineModel<Record<string, boolean>>('expanded', { default: () => ({}) })

const childrenOf = (id: string) => props.allOrders.filter(o => o.parent === id)
const hasChildren = (id: string) => props.allOrders.some(o => o.parent === id)

const statusBorder: Record<OrderStatus, string> = {
  backlog: 'border-l-muted-foreground/50',
  analyzing: 'border-l-blue-500',
  developing: 'border-l-blue-500',
  testing: 'border-l-yellow-500',
  review: 'border-l-yellow-500',
  done: 'border-l-green-500',
  canceled: 'border-l-muted-foreground/30',
}

function toggle(id: string) {
  expanded.value = { ...expanded.value, [id]: !expanded.value[id] }
}
</script>

<template>
  <div class="flex flex-col">
    <template v-for="order in orders" :key="order.id">
      <div
        class="flex items-center gap-2 rounded-md border border-border border-l-[3px] bg-card px-2.5 py-1.5"
        :class="[statusBorder[order.status], order.status === 'done' ? 'opacity-75' : '', order.status === 'canceled' ? 'opacity-50' : '']"
      >
        <button
          v-if="hasChildren(order.id)"
          class="shrink-0 text-muted-foreground hover:text-foreground"
          @click="toggle(order.id)"
        >
          <ChevronDown v-if="expanded[order.id]" class="h-3.5 w-3.5" />
          <ChevronRight v-else class="h-3.5 w-3.5" />
        </button>
        <span v-else class="w-3.5 shrink-0" />
        <span class="shrink-0 font-mono text-[10px] text-muted-foreground">{{ order.id }}</span>
        <span class="flex-1 cursor-pointer truncate text-[13px] text-foreground hover:text-blue-400" @click="emit('select', order.id)">
          {{ order.title }}（{{ order.priority }}）
        </span>
        <span class="hidden shrink-0 items-center gap-1 text-[11px] text-muted-foreground sm:flex">
          <User class="h-3 w-3" />
          {{ order.assignee ?? '未指派' }} · 截止 {{ order.dueDate || '—' }}
        </span>
        <Select
          :model-value="order.status"
          :options="statusOptions"
          class="h-6 shrink-0"
          @update:model-value="(v: string) => emit('status-change', order.id, v as OrderStatus)"
        />
      </div>
      <!-- 子订单：递归缩进展示 -->
      <div v-if="expanded[order.id] && hasChildren(order.id)" class="ml-6 flex flex-col gap-1 border-l border-border py-1 pl-2">
        <OrderTree
          :orders="childrenOf(order.id)"
          :all-orders="allOrders"
          v-model:expanded="expanded"
          @select="id => emit('select', id)"
          @status-change="(id, s) => emit('status-change', id, s)"
          @create-child="o => emit('create-child', o)"
        />
      </div>
      <button
        v-if="!order.parent"
        class="ml-6 w-fit rounded border border-dashed border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:border-blue-500 hover:text-blue-400"
        @click="emit('create-child', order)"
      >
        + 子工单
      </button>
    </template>
  </div>
</template>
