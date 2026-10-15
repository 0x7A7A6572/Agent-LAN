<script setup lang="ts">
import { computed, ref } from 'vue'
import { Plus } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'
import Select from '@/components/ui/Select.vue'
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
const assignee = ref('')
const priority = ref<OrderPriority>('normal')
const childParent = ref<Order | null>(null)
const expanded = ref<Record<string, boolean>>({})
const detail = ref<string>('')
const detailOpen = ref(false)

const assigneeOptions = computed(() => [
  { value: '', label: childParent.value ? '指派给…（可空）' : '指派给…' },
  ...props.nodeNames.map(n => ({ value: n, label: n })),
])
const priorityOptions: { value: OrderPriority; label: string }[] = [
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

defineExpose({ showDetail })
</script>

<template>
  <div class="flex flex-col gap-2.5">
    <!-- 建单行：父单与子单共用 -->
    <div class="flex flex-wrap items-center gap-1.5">
      <Input v-model="title" :placeholder="placeholder" class="min-w-[180px] flex-1" @keydown.enter="submit" />
      <Select v-model="assignee" :options="assigneeOptions" />
      <Select v-model="priority" :options="priorityOptions" />
      <Button size="sm" @click="submit">
        <Plus class="h-3.5 w-3.5" />
        {{ childParent ? '建子单派发' : '建单派发' }}
      </Button>
      <Button v-if="childParent" variant="ghost" size="sm" @click="childParent = null">
        取消子单（{{ childParent.id }}）
      </Button>
    </div>

    <OrderTree
      v-model:expanded="expanded"
      :orders="roots"
      :all-orders="orders"
      @select="showDetail"
      @status-change="(id, s) => emit('status-change', id, s)"
      @create-child="o => (childParent = o)"
    />
    <div v-if="!orders.length" class="py-8 text-center text-xs text-muted-foreground">还没有工单</div>

    <!-- 工单详情：文本面板 -->
    <pre v-if="detailOpen" class="max-h-[30vh] overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-background p-3 text-xs leading-relaxed text-foreground">{{ detail }}</pre>
  </div>
</template>
