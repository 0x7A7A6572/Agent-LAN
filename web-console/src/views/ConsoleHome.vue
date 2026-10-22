<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ChevronRight, FolderOpen, MessageCircleQuestion, Network, ScrollText, Plus, SlidersHorizontal, Ticket, TriangleAlert, X } from 'lucide-vue-next'
import { useConsoleStore } from '@/stores/console'
import { setNodeRole, saveRoles } from '@/api/console'
import CreateOrderDialog from '@/components/console/CreateOrderDialog.vue'
import NodeCard from '@/components/console/NodeCard.vue'
import NodeTopology3D from '@/components/console/NodeTopology3D.vue'
import PmPanel from '@/components/console/PmPanel.vue'
import RedispatchDialog from '@/components/console/RedispatchDialog.vue'
import FloatingTabs from '@/components/console/FloatingTabs.vue'
import type { FloatingTab } from '@/components/console/floating-tabs'
import OrderPanel from '@/components/console/OrderPanel.vue'
import LogPanel from '@/components/console/LogPanel.vue'
import RoleLibrary from '@/components/console/RoleLibrary.vue'
import RolePickDialog from '@/components/console/RolePickDialog.vue'
import FilesDialog from '@/components/console/FilesDialog.vue'
import InstallPanel from '@/components/console/InstallPanel.vue'
import QuestionPrompt from '@/components/console/QuestionPrompt.vue'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { Order, OrderAttachment, OrderStatus, RoleDef } from '@/types/console'

const store = useConsoleStore()

const filesOpen = ref(false)
const pickOpen = ref(false)
const pickName = ref('')
const pickCurrent = ref('')
const sidebarCreateOpen = ref(false)
const nodesOpen = ref(false)

// 左侧节点卡点击 → 3D 视点导航到该节点。activeNode 只用于卡片高亮，
// 与「派发权/角色」无关，不落库。
const topoRef = ref<{ focus: (id: string | null) => void } | null>(null)
const activeNode = ref<string | null>(null)
function onNodeSelect(name: string) {
  activeNode.value = name
  topoRef.value?.focus(name)
}

// 待选答的节点提问：首页统一托管一个弹层，节点卡与 banner 都只是入口
// （节点卡只有 300px 宽，题卡塞进去题干和选项都会截断，所以放弹层）
const askedNodes = computed(() => store.presences.filter(p => p.question && !p.question.answer))
const askName = ref<string | null>(null)
const askPresence = computed(() => store.presences.find(p => p.card.name === askName.value))
function openAsk(name: string) {
  askName.value = name
}

// 悬浮 tab：节点 / 工单 / 日志 / 设置
type ViewKey = 'nodes' | 'orders' | 'logs' | 'settings'
const view = ref<ViewKey>('nodes')
const tabs = computed<FloatingTab[]>(() => [
  { key: 'nodes', label: '节点', icon: Network, badge: store.onlineNodes.length, alert: store.waitingAlert.length > 0 },
  { key: 'orders', label: '工单', icon: Ticket, badge: store.orders.filter(o => o.status !== 'done' && o.status !== 'canceled').length },
  { key: 'logs', label: '日志', icon: ScrollText },
  { key: 'settings', label: '设置', icon: SlidersHorizontal },
])

function log(line: string) {
  store.logs = [...store.logs, line]
}

onMounted(() => {
  store.connectSse()
  store.pollLogs()
  setInterval(store.pollLogs, 2000)
  store.loadRoles()
  store.refreshOrders()
  store.refreshPmState()
  setInterval(store.refreshPmState, 5000)
})

// 工单状态 Tab：blocked 单列，等人工的工单需要人立刻看见
const ORDER_STATUSES = ['backlog', 'developing', 'blocked', 'testing', 'done'] as const
const statusTabs = computed(() => [
  { key: 'all', label: '全部', count: store.orders.length },
  ...ORDER_STATUSES.map(s => ({
    key: s,
    label: s,
    count: store.orders.filter(o => o.status === s).length,
  })),
])
const tabOrders = computed(() =>
  activeTab.value === 'all'
    ? store.orders
    : store.orders.filter(o => o.status === activeTab.value),
)
const activeTab = ref('all')

function onCreateFromSidebar() {
  sidebarCreateOpen.value = true
}

async function onPickRole(name: string, role: string) {
  await store.loadRoles()
  pickName.value = name
  pickCurrent.value = role
  pickOpen.value = true
}

async function onPickConfirm(role: string) {
  const r = await setNodeRole(pickName.value, role)
  if (r.ok) log('[role] ' + pickName.value + ' -> ' + (r.role || '（无）'))
  else log('[role] 修改失败: ' + r.error)
}

async function onRolesSave(roles: RoleDef[]) {
  const r = await saveRoles(roles)
  if (r.ok) {
    await store.refreshRoles()
    log('[role] 角色库 -> ' + ((r.allowed ?? []).map(x => x.name).join(', ') || '（空）'))
  } else log('[role] 角色库保存失败')
}

async function onDeleteNode(name: string) {
  const r = await store.deleteNode(name)
  if (!r.ok) log('[node] 删除失败: ' + (r.error || '节点不存在'))
}

async function onOrderCreate(body: { title: string; assignee?: string; priority: string; parent?: string; description?: string; attachments?: OrderAttachment[] }) {
  const r = await store.createOrder(body)
  if (r.error) log('[order] 建单失败: ' + r.error)
  else log('[order] 已建 ' + r.order!.id + ' ' + body.title + (body.assignee ? ' 并派发 -> ' + body.assignee : ''))
}

function onStatusChange(id: string, status: OrderStatus) {
  store.updateOrderStatus(id, status)
}

async function onOrderEdit(
  order: Order,
  patch: Partial<Order>,
  attachments?: { add: OrderAttachment[]; remove: string[] },
) {
  const r = await store.editOrder(order.id, patch, attachments)
  if (r.error) log('[order] 编辑失败: ' + r.error)
  else {
    const a = attachments?.add.length ?? 0
    const d = attachments?.remove.length ?? 0
    log('[order] 已更新 ' + order.id + (a || d ? '（附件 +' + a + ' -' + d + '）' : ''))
  }
}

async function onOrderCancel(order: Order) {
  if (!confirm('取消工单「' + order.title + '」？正在执行的任务将被终止。')) return
  const r = await store.cancelOrder(order.id)
  if (r.ok) log('[order] 已取消 ' + order.id + '，终止任务 ' + (r.canceled?.length ?? 0) + ' 个')
  else log('[order] 取消失败: ' + (r.error || '未知错误'))
}

async function onOrderRedispatch(order: Order, assignee?: string) {
  const r = await store.redispatchOrder(order.id, assignee)
  if (r.ok) log('[order] 已重新派发 ' + order.id + ' -> ' + (assignee || order.assignee || '当前处理人'))
  else log('[order] 派发失败: ' + (r.error || '未知错误'))
}

// 重新派发：先选人再确认，避免只能沿用原处理人
const redispatchOpen = ref(false)
const redispatchDialog = ref<InstanceType<typeof RedispatchDialog> | null>(null)
function openRedispatch(order: Order) {
  redispatchDialog.value?.show(order)
}


</script>

<template>
  <div class="flex min-h-screen w-full flex-col">
    <!-- 顶栏：品牌 + 创建工单CTA + 标题 + 摘要 -->
    <header class="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-4 border-b bg-background px-4 md:px-6">
      <div class="flex items-center gap-3">
        <span class="flex size-6 items-center justify-center rounded-full border-2 border-foreground" />
        <span class="hidden text-sm font-semibold sm:inline">Agent-LAN.</span>
      </div>
      <!-- <span class="text-sm font-medium">Documents</span> -->
      <span class="hidden text-xs text-muted-foreground lg:inline">{{ store.summary }}</span>

    </header>

      <main class="flex min-h-0 flex-1 flex-col gap-4 p-4 pb-24 md:gap-6 md:p-6 md:pb-24">
        <!-- 人工确认提醒：单行紧凑条，内容多自动折行，不铺满整行 -->
        <div
          v-if="store.waitingAlert.length"
          class="flex w-fit max-w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-amber-500/60 bg-amber-500/10 px-2.5 py-1.5 text-xs"
        >
          <TriangleAlert class="size-3.5 shrink-0 text-amber-500" />
          <span class="shrink-0 font-medium text-amber-600 dark:text-amber-400">
            {{ store.waitingAlert.length }} 个节点等人工
          </span>
          <span
            v-if="askedNodes.length"
            class="shrink-0 rounded bg-amber-500/20 px-1.5 text-[11px] text-amber-600 dark:text-amber-400"
          >
            {{ askedNodes.length }} 个待选答
          </span>
          <ul class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-amber-700/90 dark:text-amber-300/80">
            <li v-for="w in store.waitingAlert" :key="w.name" class="flex min-w-0 items-center gap-1.5">
              <span class="max-w-[240px] truncate" :title="w.name + '：' + w.text">
                <span class="font-medium">{{ w.name }}</span>：{{ w.text }}
              </span>
              <button
                v-if="askedNodes.some(a => a.card.name === w.name)"
                class="shrink-0 rounded border border-amber-500/50 px-1.5 text-[11px] leading-4 text-amber-600 hover:bg-amber-500/15 dark:text-amber-400"
                @click="openAsk(w.name)"
              >
                回答
              </button>
            </li>
          </ul>
          <Button
            variant="ghost"
            size="icon-xs"
            class="ml-1 shrink-0 text-amber-600 hover:bg-amber-500/15"
            title="收起提醒"
            @click="store.dismissWaitingAlert()"
          >
            <X class="size-3.5" />
          </Button>
        </div>

        <!-- 节点视图：详情 1 / 拓扑 4，两栏同高，超出各自滚动 -->
        <div
          v-show="view === 'nodes'"
          class="flex flex-col gap-4 lg:h-[calc(100vh-12rem)] lg:flex-row"
        >
          <!-- 详情列：窄栏纵向滚动，承载留言/删节点等操作 -->
          <aside class="flex min-h-[280px] shrink-0 flex-col gap-3 lg:w-1/5 lg:min-w-[300px]">
            <div class="flex items-center gap-2">
              <span class="text-xs font-medium text-muted-foreground">节点详情</span>
              <Badge variant="outline" class="text-[10px]">{{ store.presences.length }}</Badge>
            </div>
            <ScrollArea class="min-h-0 flex-1 lg:h-0">
              <div class="flex flex-col gap-3 pr-3">
                <NodeCard
                  v-for="p in store.presences"
                  :key="p.card.name"
                  :presence="p"
                  :active="activeNode === p.card.name"
                  @select="onNodeSelect"
                  @pick-role="onPickRole"
                  @delete-node="onDeleteNode"
                  @answer="openAsk"
                />
                <p v-if="!store.presences.length" class="py-6 text-center text-xs text-muted-foreground">
                  暂无节点接入
                </p>
              </div>
            </ScrollArea>
          </aside>

          <!-- 拓扑：Supervisor 在中心，派发链路随接管状态高亮 -->
          <div class="flex min-h-[360px] min-w-0 flex-1 flex-col">
            <NodeTopology3D
              ref="topoRef"
              :presences="store.presences"
              :orders="store.orders"
              :dispatch-mode="store.pmState.mode"
              :pm-name="store.pmState.pmName"
            />
          </div>
        </div>

        <!-- 工单视图 -->
        <div v-show="view === 'orders'" id="sec-orders">
          <Tabs v-model="activeTab" class="gap-4">
            <div class="flex items-center gap-2">
              <TabsList>
                <TabsTrigger v-for="t in statusTabs" :key="t.key" :value="t.key" class="gap-1.5">
                  {{ t.label }}
                  <Badge variant="outline" class="text-[10px]">{{ t.count }}</Badge>
                </TabsTrigger>
              </TabsList>
              <div class="ml-auto flex items-center gap-2">
                <Button size="sm" variant="outline" @click="filesOpen = true">
                  <FolderOpen class="h-4 w-4" />
                  资料库
                </Button>
                <Button size="sm" @click="onCreateFromSidebar">
                  <Plus class="h-4 w-4" />
                  创建工单
                </Button>
              </div>
            </div>
            <TabsContent v-for="t in statusTabs" :key="t.key" :value="t.key">
              <Card>
                <CardContent class="p-4">
                  <OrderPanel
                    ref="orderPanel"
                    :orders="tabOrders"
                    :all-orders="store.orders"
                    :presences="store.presences"
                    @create="onOrderCreate"
                    @status-change="onStatusChange"
                    @cancel="onOrderCancel"
                    @redispatch="openRedispatch"
                    @edit="onOrderEdit"
                  />
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        <!-- 日志视图 -->
        <div v-show="view === 'logs'" id="sec-logs" class="flex min-h-[300px] flex-col">
          <LogPanel :logs="store.logs" class="min-h-[300px] flex-1" />
        </div>

        <!-- 设置视图：PM 接管 + 角色库 + 安装说明 -->
        <div v-show="view === 'settings'" class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <PmPanel />
          <div class="flex flex-col gap-4">
            <Card id="sec-roles-card">
              <CardContent class="p-3">
                <RoleLibrary
                  :roles="store.roles"
                  :nodes="store.presences.map(p => ({ name: p.card.name, role: p.role, online: p.online }))"
                  @save="onRolesSave"
                />
              </CardContent>
            </Card>
            <Card>
              <CardContent class="p-3">
                <InstallPanel />
              </CardContent>
            </Card>
          </div>
        </div>
      </main>

      <FloatingTabs v-model="view" :tabs="tabs" />
    <CreateOrderDialog
      v-model:open="sidebarCreateOpen"
      :presences="store.presences"
      @create="onOrderCreate"
    />
    <RedispatchDialog ref="redispatchDialog" v-model:open="redispatchOpen" :presences="store.presences" @confirm="onOrderRedispatch" />
    <FilesDialog v-model:open="filesOpen" />
    <RolePickDialog v-model:open="pickOpen" :roles="store.roles" :node-name="pickName" :current="pickCurrent" @pick="onPickConfirm" />

    <!-- 待人工确认：题卡弹层。节点卡只有 300px，题干和选项都会被截断，故统一在这里作答 -->
    <Dialog :open="!!askName" @update:open="v => { if (!v) askName = null }">
      <DialogContent class="gap-3 sm:max-w-md">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2 text-base">
            <MessageCircleQuestion class="size-4 text-amber-500" />
            {{ askPresence?.card.name }} 在等你确认
          </DialogTitle>
          <DialogDescription>
            选项与说明由 agent 提问时一并上报；提交后作为一条留言投回节点，它下次领任务时收到
          </DialogDescription>
        </DialogHeader>
        <QuestionPrompt
          v-if="askPresence?.question"
          :key="askPresence.question.id"
          :question="askPresence.question"
          :node-name="askPresence.card.name"
          @log="log"
          @answered="askName = null"
        />
      </DialogContent>
    </Dialog>
  </div>
</template>