<script setup lang="ts">
import { ChevronDown, ChevronRight, Ellipsis, GripVertical, User } from 'lucide-vue-next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
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

const expanded = defineModel<Record<string, boolean>>('expanded', { default: () => ({}) })

const childrenOf = (id: string) => props.allOrders.filter(o => o.parent === id)
const hasChildren = (id: string) => props.allOrders.some(o => o.parent === id)

function toggle(id: string) {
  expanded.value = { ...expanded.value, [id]: !expanded.value[id] }
}
</script>

<template>
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead class="w-10" />
        <TableHead class="w-10" />
        <TableHead>标题</TableHead>
        <TableHead class="w-[110px]">工单类型</TableHead>
        <TableHead class="w-[120px]">状态</TableHead>
        <TableHead class="w-[140px]">处理人 / 截止</TableHead>
        <TableHead class="w-12" />
      </TableRow>
    </TableHeader>
    <TableBody>
      <template v-for="order in orders" :key="order.id">
        <TableRow class="group">
          <TableCell class="text-muted-foreground/50">
            <GripVertical class="h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />
          </TableCell>
          <TableCell>
            <button v-if="hasChildren(order.id)" class="text-muted-foreground hover:text-foreground" aria-label="展开/收起子工单" @click="toggle(order.id)">
              <ChevronDown v-if="expanded[order.id]" class="h-4 w-4" />
              <ChevronRight v-else class="h-4 w-4" />
            </button>
            <Checkbox v-else :model-value="order.status === 'done'" disabled />
          </TableCell>
          <TableCell>
            <button class="flex items-center gap-1.5 text-left text-sm font-medium hover:underline" @click="emit('select', order.id)">
              <ChevronRight v-if="hasChildren(order.id) && !expanded[order.id]" class="h-3 w-3 text-muted-foreground" />
              {{ order.title }}
            </button>
            <span class="font-mono text-[10px] text-muted-foreground">{{ order.id }}</span>
          </TableCell>
          <TableCell>
            <Badge variant="outline" class="text-[11px]">{{ order.priority }}</Badge>
          </TableCell>
          <TableCell>
            <span class="flex items-center gap-1.5 text-sm">
              <span
                class="flex size-4 items-center justify-center rounded-full"
                :class="order.status === 'done' ? 'bg-green-600' : order.status === 'canceled' ? 'bg-destructive' : 'border border-muted-foreground/40'"
              >
                <svg v-if="order.status === 'done'" class="size-3 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5" /></svg>
              </span>
              {{ order.status }}
            </span>
          </TableCell>
          <TableCell>
            <span class="flex items-center gap-1.5 text-sm text-muted-foreground">
              <User class="h-3.5 w-3.5" />
              {{ order.assignee ?? '未指派' }}
              <span class="text-xs">· {{ order.dueDate || '—' }}</span>
            </span>
          </TableCell>
          <TableCell>
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button variant="ghost" size="icon" class="h-7 w-7">
                  <Ellipsis class="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem @click="emit('select', order.id)">查看详情</DropdownMenuItem>
                <DropdownMenuItem v-if="!order.parent" @click="emit('create-child', order)">添加子工单</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </TableCell>
        </TableRow>
        <!-- 子工单：缩进行（仅展开时渲染） -->
        <template v-if="expanded[order.id]">
        <TableRow v-for="child in childrenOf(order.id)" :key="child.id" class="bg-muted/30">
          <TableCell class="text-muted-foreground/50">
            <GripVertical class="h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />
          </TableCell>
          <TableCell>
            <Checkbox :model-value="child.status === 'done'" disabled />
          </TableCell>
          <TableCell class="pl-8">
            <span class="text-sm">{{ child.title }}</span>
            <span class="ml-2 font-mono text-[10px] text-muted-foreground">{{ child.id }}</span>
          </TableCell>
          <TableCell>
            <Badge variant="outline" class="text-[11px]">{{ child.priority }}</Badge>
          </TableCell>
          <TableCell>
            <span class="flex items-center gap-1.5 text-sm">
              <span
                class="flex size-4 items-center justify-center rounded-full"
                :class="child.status === 'done' ? 'bg-green-600' : 'border border-muted-foreground/40'"
              >
                <svg v-if="child.status === 'done'" class="size-3 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5" /></svg>
              </span>
              {{ child.status }}
            </span>
          </TableCell>
          <TableCell>
            <span class="flex items-center gap-1.5 text-sm text-muted-foreground">
              <User class="h-3.5 w-3.5" />
              {{ child.assignee ?? '未指派' }}
            </span>
          </TableCell>
          <TableCell />
        </TableRow>
        </template>
      </template>
      <TableRow v-if="!orders.length">
        <TableCell colspan="8" class="h-24 text-center text-muted-foreground">还没有工单</TableCell>
      </TableRow>
    </TableBody>
  </Table>
</template>
