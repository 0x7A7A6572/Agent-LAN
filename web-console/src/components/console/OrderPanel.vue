<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import CreateOrderDialog from './CreateOrderDialog.vue'
import OrderTree from './OrderTree.vue'
import { useConsoleStore } from '@/stores/console'
import type { Order, OrderDetail, OrderPriority, OrderStatus } from '@/types/console'

const props = defineProps<{
  orders: Order[]
  nodeNames: string[]
}>()
const emit = defineEmits<{
  (e: 'create', body: { title: string; assignee?: string; priority: OrderPriority; parent?: string; description?: string }): void
  (e: 'status-change', id: string, status: OrderStatus): void
}>()
const store = useConsoleStore()

// 未完成工单删除前确认；done/canceled 直接删
function onDelete(order: Order) {
  const finished = order.status === 'done' || order.status === 'canceled'
  if (!finished && !confirm('工单「' + order.title + '」尚未完成，确定删除？')) return
  store.deleteOrder(order.id)
}

const createOpen = ref(false)
const childParent = ref<{ id: string; title: string } | null>(null)
const expanded = ref<Record<string, boolean>>({})

// 详情弹窗：标题=工单号，正文=格式化文本
const detailOpen = ref(false)
const detailTitle = ref('')
const detailText = ref('')

const roots = computed(() => props.orders.filter(o => !o.parent))

async function showDetail(id: string) {
  const r = await fetch('/console/orders/' + id).then(x => x.json() as Promise<OrderDetail | { error: string }>)
  if ('error' in r) {
    detailTitle.value = id
    detailText.value = r.error
  } else {
    const o = r.order
    detailTitle.value = o.id + ' ' + o.title
    detailText.value = [
      '状态: ' + o.status + ' · 优先级: ' + o.priority + ' · 处理人: ' + (o.assignee || '未指派'),
      '描述: ' + (o.description || '—'),
      '来源: ' + o.source + ' · 创建: ' + o.createdAt.slice(0, 16) + ' · 截止: ' + (o.dueDate || '—'),
      '子单: ' + (r.children.length ? r.children.map(c => c.id + ' ' + c.title + ' (' + c.status + ')').join('; ') : '无'),
      '附件: ' + (o.attachments.length ? o.attachments.map(a => a.name).join(', ') : '无'),
      '—— 流转记录 ——',
      ...o.timeline.map(e => e.at.slice(11, 19) + ' ' + e.by + ': ' + e.field + (e.to ? ' → ' + e.to : '') + (e.note ? ' [' + e.note + ']' : '')),
    ].join('\n')
  }
  detailOpen.value = true
}

defineExpose({ showDetail })
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- 树形表 -->
    <div class="rounded-lg border">
      <OrderTree
        v-model:expanded="expanded"
        :orders="roots"
        :all-orders="orders"
        @select="showDetail"
        @status-change="(id, s) => emit('status-change', id, s)"
        @create-child="o => (childParent = { id: o.id, title: o.title }, createOpen = true)"
        @delete="onDelete"
      />
      <div v-if="!orders.length" class="py-8 text-center text-sm text-muted-foreground">还没有工单</div>
    </div>

    <!-- 工单详情弹窗 -->
    <Dialog v-model:open="detailOpen">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle class="text-sm">{{ detailTitle }}</DialogTitle>
          <DialogDescription class="sr-only">工单详情</DialogDescription>
        </DialogHeader>
        <pre class="max-h-[55vh] overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-foreground">{{ detailText }}</pre>
      </DialogContent>
    </Dialog>

    <CreateOrderDialog
      v-model:open="createOpen"
      :node-names="nodeNames"
      :parent="childParent"
      @create="b => (emit('create', b), (childParent = null))"
    />
  </div>
</template>
