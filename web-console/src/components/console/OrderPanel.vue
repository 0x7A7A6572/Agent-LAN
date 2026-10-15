<script setup lang="ts">
import { computed, ref } from 'vue'
import { Plus } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import OrderTree from './OrderTree.vue'
import type { Order, OrderDetail, OrderPriority, OrderStatus } from '@/types/console'

const props = defineProps<{
  orders: Order[]
  nodeNames: string[]
}>()
const emit = defineEmits<{
  (e: 'create', body: { title: string; assignee?: string; priority: OrderPriority; parent?: string }): void
  (e: 'status-change', id: string, status: OrderStatus): void
}>()

const title = ref('')
const titleInput = ref<InstanceType<typeof Input> | null>(null)
const assignee = ref('')
const priority = ref<OrderPriority>('normal')
const childParent = ref<Order | null>(null)
const expanded = ref<Record<string, boolean>>({})
const detail = ref<string>('')
const detailOpen = ref(false)

const PRIORITIES: { value: OrderPriority; label: string }[] = [
  { value: 'normal', label: '普通' },
  { value: 'high', label: '高' },
  { value: 'urgent', label: '紧急' },
  { value: 'low', label: '低' },
]

const roots = computed(() => props.orders.filter(o => !o.parent))

const placeholder = computed(() =>
  childParent.value ? '为子工单（父：' + childParent.value.id + ' ' + childParent.value.title + '）输入标题…' : '工单标题…',
)

function submit() {
  const t = title.value.trim()
  if (!t) return
  emit('create', {
    title: t,
    assignee: assignee.value || undefined,
    priority: priority.value,
    parent: childParent.value?.id,
  })
  title.value = ''
  childParent.value = null
}

async function showDetail(id: string) {
  const r = await fetch('/console/orders/' + id).then(x => x.json() as Promise<OrderDetail | { error: string }>)
  if ('error' in r) {
    detail.value = r.error
  } else {
    const o = r.order
    detail.value = [
      '【' + o.id + '】' + o.title,
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

function focusCreate() {
  const el = (titleInput.value as unknown as { $el?: HTMLInputElement })?.$el
  el?.focus()
}

defineExpose({ showDetail, focusCreate })
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- 建单行 -->
    <div class="flex flex-wrap items-center gap-2">
      <Input ref="titleInput" v-model="title" :placeholder="placeholder" class="h-8 min-w-[160px] flex-1" @keydown.enter="submit" />
      <Select v-model="assignee">
        <SelectTrigger class="h-8 w-[130px] text-xs">
          <SelectValue placeholder="指派给…" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="n in nodeNames" :key="n" :value="n" class="text-xs">{{ n }}</SelectItem>
        </SelectContent>
      </Select>
      <Select v-model="priority">
        <SelectTrigger class="h-8 w-[90px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="p in PRIORITIES" :key="p.value" :value="p.value" class="text-xs">{{ p.label }}</SelectItem>
        </SelectContent>
      </Select>
      <Button size="sm" class="h-8" @click="submit">
        <Plus class="h-4 w-4" />
        {{ childParent ? '建子单' : '建单派发' }}
      </Button>
      <Button v-if="childParent" variant="ghost" size="sm" class="h-8" @click="childParent = null">
        取消（{{ childParent.id }}）
      </Button>
    </div>

    <!-- 树形列表 -->
    <div class="rounded-lg border">
      <div class="flex items-center gap-3 border-b px-3 py-2 text-xs font-medium text-muted-foreground">
        <span class="w-4" />
        <span class="hidden sm:inline">编号</span>
        <span class="flex-1">标题</span>
        <span class="hidden md:inline">处理人 / 截止</span>
        <span>状态</span>
        <span class="w-[110px]">流转</span>
      </div>
      <div class="p-2">
        <OrderTree
          v-model:expanded="expanded"
          :orders="roots"
          :all-orders="orders"
          @select="showDetail"
          @status-change="(id, s) => emit('status-change', id, s)"
          @create-child="o => (childParent = o)"
        />
        <div v-if="!orders.length" class="py-8 text-center text-sm text-muted-foreground">还没有工单</div>
      </div>
    </div>

    <!-- 工单详情 -->
    <pre v-if="detailOpen" class="max-h-[30vh] overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed">{{ detail }}</pre>
  </div>
</template>
