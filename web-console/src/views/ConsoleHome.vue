<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useConsoleStore } from '@/stores/console'
import { sendMail, dispatchTask, setNodeRole, saveRoles, savePmDoc } from '@/api/console'
import CreateOrderDialog from '@/components/console/CreateOrderDialog.vue'
import NodeCard from '@/components/console/NodeCard.vue'
import OrderPanel from '@/components/console/OrderPanel.vue'
import LogPanel from '@/components/console/LogPanel.vue'
import FabPanel from '@/components/console/FabPanel.vue'
import RolesDialog from '@/components/console/RolesDialog.vue'
import RolePickDialog from '@/components/console/RolePickDialog.vue'
import PmDialog from '@/components/console/PmDialog.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { OrderStatus } from '@/types/console'

const store = useConsoleStore()

const rolesOpen = ref(false)
const pmOpen = ref(false)
const pickOpen = ref(false)
const pickName = ref('')
const pickCurrent = ref('')
const fabOpen = ref(false)
const sidebarCreateOpen = ref(false)

function log(line: string) {
  store.logs = [...store.logs, line]
}

onMounted(() => {
  store.connectSse()
  store.pollLogs()
  setInterval(store.pollLogs, 2000)
  store.loadRoles()
  store.refreshOrders()
})

// 工单状态 Tab：按状态分组计数
const statusTabs = computed(() => {
  const active = store.orders.filter(o => !['done', 'canceled'].includes(o.status))
  const done = store.orders.filter(o => o.status === 'done')
  const others = store.orders.filter(o => o.status === 'canceled')
  return [
    { key: 'active', label: '工单状态', count: active.length },
    { key: 'done', label: '已完成', count: done.length },
    { key: 'all', label: '全部', count: store.orders.length },
  ]
})
const tabOrders = computed(() => {
  switch (activeTab.value) {
    case 'done': return store.orders.filter(o => o.status === 'done')
    case 'all': return store.orders
    default: return store.orders.filter(o => !['done', 'canceled'].includes(o.status))
  }
})
const activeTab = ref('active')

function onCreateFromSidebar() {
  sidebarCreateOpen.value = true
}

function onSend(to: string, text: string, mode: 'mail' | 'task') {
  if (mode === 'task') {
    dispatchTask(to, text).then(r => {
      if (r.error) log('[task] 派发失败: ' + r.error.message)
      else log('[task] 已派发 -> ' + to + ': ' + text.slice(0, 80))
    })
  } else {
    sendMail(to, text).then(r => {
      if (r.error) log('[mail] 发送失败: ' + r.error.message)
      else log('[mail] 我 -> ' + to + ': ' + text)
    })
  }
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

async function onRolesSave(roles: string[]) {
  const r = await saveRoles(roles)
  if (r.ok) {
    await store.refreshRoles()
    log('[role] 角色库 -> ' + ((r.allowed ?? []).join(', ') || '（空）'))
  } else log('[role] 角色库保存失败')
}

async function onPmSave(text: string) {
  const r = await savePmDoc(text)
  if (r.ok) log('[pm] 说明书已保存（立即生效）')
  else log('[pm] 保存失败: ' + (r.error || '未知错误'))
}

async function onOrderCreate(body: { title: string; assignee?: string; priority: string; parent?: string }) {
  const r = await store.createOrder(body)
  if (r.error) log('[order] 建单失败: ' + r.error)
  else log('[order] 已建 ' + r.order!.id + ' ' + body.title + (body.assignee ? ' 并派发 -> ' + body.assignee : ''))
}

function onStatusChange(id: string, status: OrderStatus) {
  store.updateOrderStatus(id, status)
}
</script>

<template>
  <div class="flex min-h-screen w-full flex-col">
    <!-- 顶栏：品牌 + 创建工单CTA + 标题 + 摘要 -->
    <header class="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-4 border-b bg-background px-4 md:px-6">
      <div class="flex items-center gap-3">
        <span class="flex size-6 items-center justify-center rounded-full border-2 border-foreground" />
        <span class="hidden text-sm font-semibold sm:inline">Multi-Agent-LAN.</span>
      </div>
      <!-- <span class="text-sm font-medium">Documents</span> -->
      <span class="hidden text-xs text-muted-foreground lg:inline">{{ store.summary }}</span>
      <span class="ml-auto flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="secondary" size="icon" class="rounded-full" title="设置">
              <Settings class="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-44">
            <DropdownMenuLabel>设置</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem @click="rolesOpen = true">角色库</DropdownMenuItem>
            <DropdownMenuItem @click="pmOpen = true">PM 设定</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </header>

      <main class="flex flex-1 flex-col gap-4 p-4 md:gap-6 md:p-6">
        <!-- 节点卡行：横向滚动，截图同款 -->
        <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <NodeCard
            v-for="p in store.presences.slice(0, 8)"
            :key="p.card.name"
            :presence="p"
            @pick-role="onPickRole"
          />
        </div>
        <div v-if="store.presences.length > 8" class="text-xs text-muted-foreground">
          还有 {{ store.presences.length - 8 }} 个节点未展示
        </div>

        <!-- 工单区：状态 Tab + 面板 -->
        <div id="sec-orders">
          <Tabs v-model="activeTab" class="gap-4">
            <div class="flex items-center gap-2">
              <TabsList>
                <TabsTrigger v-for="t in statusTabs" :key="t.key" :value="t.key" class="gap-1.5">
                  {{ t.label }}
                  <Badge variant="outline" class="text-[10px]">{{ t.count }}</Badge>
                </TabsTrigger>
              </TabsList>
              <Button size="sm" class="ml-auto" @click="onCreateFromSidebar">
                <Plus class="h-4 w-4" />
                创建工单
              </Button>
              <Button variant="outline" size="sm" @click="rolesOpen = true">角色库</Button>
              <Button variant="outline" size="sm" @click="pmOpen = true">PM 说明书</Button>
            </div>
            <TabsContent v-for="t in statusTabs" :key="t.key" :value="t.key">
              <Card>
                <CardContent class="p-4">
                  <OrderPanel
                    ref="orderPanel"
                    :orders="tabOrders"
                    :node-names="store.nodeNames"
                    @create="onOrderCreate"
                    @status-change="onStatusChange"
                  />
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        <!-- 日志区：锚点目标 -->
        <div id="sec-logs" class="flex min-h-[200px] flex-col">
          <LogPanel :logs="store.logs" class="min-h-[200px] flex-1" />
        </div>
      </main>
    <!-- 右下角悬浮发送 -->
    <div class="fixed bottom-6 right-6 z-40 flex flex-col items-end gap-3">
      <FabPanel v-model:open="fabOpen" :presences="store.presences" @send="onSend" />
      <Button class="h-12 w-12 rounded-full shadow-lg" title="发送留言 / 派发任务" @click="fabOpen = !fabOpen">
        <img :src="'/console/logos/' + 'chat.svg'" alt="" class="h-5 w-5" />
      </Button>
    </div>

    <RolesDialog v-model:open="rolesOpen" :roles="store.roles" @save="onRolesSave" />
    <CreateOrderDialog
      v-model:open="sidebarCreateOpen"
      :node-names="store.nodeNames"
      @create="onOrderCreate"
    />
    <PmDialog v-model:open="pmOpen" @save="onPmSave" />
    <RolePickDialog v-model:open="pickOpen" :roles="store.roles" :node-name="pickName" :current="pickCurrent" @pick="onPickConfirm" />
  </div>
</template>