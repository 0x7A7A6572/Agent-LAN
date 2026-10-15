<script setup lang="ts">
import type { AcceptableValue } from 'reka-ui'
import { ChevronDown, ChevronRight, User } from 'lucide-vue-next'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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

const expanded = defineModel<Record<string, boolean>>('expanded', { default: () => ({}) })

const childrenOf = (id: string) => props.allOrders.filter(o => o.parent === id)
const hasChildren = (id: string) => props.allOrders.some(o => o.parent === id)

const statusVariant: Record<OrderStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  backlog: 'secondary',
  analyzing: 'outline',
  developing: 'default',
  testing: 'outline',
  review: 'outline',
  done: 'secondary',
  canceled: 'destructive',
}

function toggle(id: string) {
  expanded.value = { ...expanded.value, [id]: !expanded.value[id] }
}
</script>

<template>
  <div class="flex flex-col">
    <template v-for="order in orders" :key="order.id">
      <div class="flex items-center gap-3 rounded-lg px-1 py-1.5 transition-colors hover:bg-accent/50">
        <button
          v-if="hasChildren(order.id)"
          class="shrink-0 text-muted-foreground hover:text-foreground"
          @click="toggle(order.id)"
        >
          <ChevronDown v-if="expanded[order.id]" class="h-4 w-4" />
          <ChevronRight v-else class="h-4 w-4" />
        </button>
        <span v-else class="w-4 shrink-0" />
        <span class="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline">{{ order.id }}</span>
        <span class="min-w-0 flex-1 cursor-pointer truncate text-sm font-medium hover:underline" @click="emit('select', order.id)">
          {{ order.title }}
          <Badge variant="outline" class="ml-1.5 text-[10px]">{{ order.priority }}</Badge>
        </span>
        <span class="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground md:flex">
          <User class="h-3.5 w-3.5" />
          {{ order.assignee ?? '未指派' }} · 截止 {{ order.dueDate || '—' }}
        </span>
        <Badge :variant="statusVariant[order.status]" class="shrink-0 text-[10px]">{{ order.status }}</Badge>
        <Select
          :model-value="order.status"
          @update:model-value="(v: AcceptableValue) => emit('status-change', order.id, String(v) as OrderStatus)"
        >
          <SelectTrigger class="h-7 w-[110px] shrink-0 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="s in STATUSES" :key="s" :value="s" class="text-xs">{{ s }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <!-- 子订单：递归缩进 -->
      <div v-if="expanded[order.id] && hasChildren(order.id)" class="ml-8 flex flex-col gap-0.5 border-l py-1 pl-3">
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
        class="mb-1 ml-8 w-fit rounded-md border border-dashed px-2 py-0.5 text-[11px] text-muted-foreground hover:border-blue-500 hover:text-blue-500"
        @click="emit('create-child', order)"
      >
        + 子工单
      </button>
    </template>
  </div>
</template>
