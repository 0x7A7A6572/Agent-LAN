<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import CreateOrderDialog from './CreateOrderDialog.vue'
import EditOrderDialog from './EditOrderDialog.vue'
import OrderTree from './OrderTree.vue'
import { useConsoleStore } from '@/stores/console'
import type { Order, OrderDetail, OrderPriority, OrderStatus, Presence } from '@/types/console'

const props = defineProps<{
  orders: Order[]
  /** 全量工单：判断有无子单必须用它。用 orders(Tab 过滤后) 会让异状态子单的展开箭头消失 */
  allOrders: Order[]
  presences: Presence[]
}>()
const emit = defineEmits<{
  (e: 'create', body: { title: string; assignee?: string; priority: OrderPriority; parent?: string; description?: string }): void
  (e: 'status-change', id: string, status: OrderStatus): void
  (e: 'cancel', order: Order): void
  (e: 'redispatch', order: Order): void
  (e: 'edit', order: Order, patch: Partial<Order>): void
}>()
const store = useConsoleStore()

// 未完成工单删除前确认；done/canceled 直接删
function onDelete(order: Order) {
  const finished = order.status === 'done' || order.status === 'canceled'
  if (!finished && !confirm('工单「' + order.title + '」尚未完成，确定删除？')) return
  store.deleteOrder(order.id)
}

const createOpen = ref(false)
const editOpen = ref(false)
const editDialog = ref<InstanceType<typeof EditOrderDialog> | null>(null)
const childParent = ref<{ id: string; title: string } | null>(null)
const expanded = ref<Record<string, boolean>>({})

// 详情弹窗：标题=工单号，正文=格式化文本
const detailOpen = ref(false)
const detailTitle = ref('')
const detailText = ref('')
const detailAttachments = ref<{ name: string; uri?: string }[]>([])

const roots = computed(() => props.orders.filter(o => !o.parent))

// 分页：只对根工单计数，子工单跟随父单一起展开，不单独占页
const page = ref(1)
const pageSize = ref(6)
const pageCount = computed(() => Math.max(1, Math.ceil(roots.value.length / pageSize.value)))
const pagedRoots = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return roots.value.slice(start, start + pageSize.value)
})
// 工单增删或每页条数变化后把页码夹回有效范围，避免停在空白页
watch(pageCount, n => { if (page.value > n) page.value = n })

async function showDetail(id: string) {
  const r = await fetch('/console/orders/' + id).then(x => x.json() as Promise<OrderDetail | { error: string }>)
  if ('error' in r) {
    detailTitle.value = id
    detailText.value = r.error
  } else {
    const o = r.order
    detailTitle.value = o.id + ' ' + o.title
    detailAttachments.value = o.attachments.map(a => ({ name: a.name, uri: a.uri }))
    detailText.value = [
      '状态: ' + o.status + ' · 优先级: ' + o.priority + ' · 处理人: ' + (o.assignee || '未指派'),
      '描述: ' + (o.description || '—'),
      '来源: ' + o.source + ' · 创建: ' + o.createdAt.slice(0, 16) + ' · 截止: ' + (o.dueDate || '—'),
      '子单: ' + (r.children.length ? r.children.map(c => c.id + ' ' + c.title + ' (' + c.status + ')').join('; ') : '无'),
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
        :orders="pagedRoots"
        :all-orders="allOrders"
        @select="showDetail"
        @status-change="(id, s) => emit('status-change', id, s)"
        @create-child="o => (childParent = { id: o.id, title: o.title }, createOpen = true)"
        @delete="onDelete"
        @cancel="o => emit('cancel', o)"
        @redispatch="o => emit('redispatch', o)"
        @edit="o => editDialog?.show(o)"
      />
      <div v-if="!orders.length" class="py-8 text-center text-sm text-muted-foreground">还没有工单</div>
      <!-- 分页条：默认每页 6 条，仅对根工单分页 -->
      <div
        v-if="roots.length"
        class="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground"
      >
        <span>共 {{ roots.length }} 条工单 · 第 {{ page }} / {{ pageCount }} 页</span>
        <div class="flex items-center gap-2">
          <Select v-model="pageSize">
            <SelectTrigger class="h-7 w-[110px] text-xs" aria-label="每页条数">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="6">每页 6 条</SelectItem>
              <SelectItem :value="12">每页 12 条</SelectItem>
              <SelectItem :value="24">每页 24 条</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" class="h-7 px-2" :disabled="page <= 1" @click="page--">
            <ChevronLeft class="h-4 w-4" />
            上一页
          </Button>
          <Button variant="outline" size="sm" class="h-7 px-2" :disabled="page >= pageCount" @click="page++">
            下一页
            <ChevronRight class="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>

    <!-- 工单详情弹窗 -->
    <Dialog v-model:open="detailOpen">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle class="text-sm">{{ detailTitle }}</DialogTitle>
          <DialogDescription class="sr-only">工单详情</DialogDescription>
        </DialogHeader>
        <div v-if="detailAttachments.length" class="flex flex-wrap gap-2 border-b pb-3">
          <a
            v-for="a in detailAttachments"
            :key="a.name"
            :href="a.uri"
            :download="a.name"
            class="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent"
          >
            📎 {{ a.name }}
          </a>
        </div>
        <pre class="max-h-[55vh] overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-foreground">{{ detailText }}</pre>
      </DialogContent>
    </Dialog>

    <CreateOrderDialog
      v-model:open="createOpen"
      :presences="presences"
      :parent="childParent"
      @create="b => (emit('create', b), (childParent = null))"
    />

    <EditOrderDialog ref="editDialog" v-model:open="editOpen" :presences="presences" @save="(o, p) => emit('edit', o, p)" />
  </div>
</template>
