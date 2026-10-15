<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  Activity,
  ChevronsUpDown,
  Cog,
  LayoutDashboard,
  ListTodo,
  Logs,
  Server,
  Sparkles,
} from 'lucide-vue-next'
import { useConsoleStore } from '@/stores/console'
import { useAppStore } from '@/stores/app'
import { sendMail, dispatchTask, setNodeRole, saveRoles, savePmDoc, clearLogs } from '@/api/console'
import NodeGrid from '@/components/console/NodeGrid.vue'
import OrderPanel from '@/components/console/OrderPanel.vue'
import LogPanel from '@/components/console/LogPanel.vue'
import FabPanel from '@/components/console/FabPanel.vue'
import RolesDialog from '@/components/console/RolesDialog.vue'
import RolePickDialog from '@/components/console/RolePickDialog.vue'
import PmDialog from '@/components/console/PmDialog.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar'

const store = useConsoleStore()
const app = useAppStore()

const rolesOpen = ref(false)
const pmOpen = ref(false)
const pickOpen = ref(false)
const pickName = ref('')
const pickCurrent = ref('')
const fabOpen = ref(false)
const activeMenu = ref('dashboard')

// 左侧菜单：先占位，后续按需接路由
const menuMain = [
  { key: 'dashboard', label: '总览', icon: LayoutDashboard, active: true },
  { key: 'nodes', label: '节点', icon: Server },
  { key: 'orders', label: '工单', icon: ListTodo },
  { key: 'logs', label: '日志', icon: Logs },
]
const menuTools = [
  { key: 'roles', label: '角色库', icon: Cog, action: 'roles' },
  { key: 'pm', label: 'PM 说明书', icon: Sparkles, action: 'pm' },
]

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

function onMenuClick(key: string, action?: string) {
  activeMenu.value = key
  if (action === 'roles') rolesOpen.value = true
  if (action === 'pm') pmOpen.value = true
  if (key === 'logs') app.toggleLogs(true)
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
</script>

<template>
  <SidebarProvider>
    <!-- 左侧菜单：布拉出来占位，样式后续再调 -->
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" as-child>
              <a href="#">
                <div class="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <Activity class="size-4" />
                </div>
                <div class="grid flex-1 text-left text-sm leading-tight">
                  <span class="truncate font-semibold">MAC 控制台</span>
                  <span class="truncate text-xs text-muted-foreground">multi-agent-connect</span>
                </div>
                <ChevronsUpDown class="ml-auto size-4" />
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>平台</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem v-for="item in menuMain" :key="item.key">
                <SidebarMenuButton :is-active="activeMenu === item.key" @click="onMenuClick(item.key)">
                  <component :is="item.icon" />
                  <span>{{ item.label }}</span>
                  <Badge v-if="item.key === 'orders' && store.orders.length" variant="outline" class="ml-auto">{{ store.orders.length }}</Badge>
                  <Badge v-else-if="item.key === 'nodes' && store.presences.length" variant="outline" class="ml-auto">{{ store.onlineNodes.length }}/{{ store.presences.length }}</Badge>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>工具</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem v-for="item in menuTools" :key="item.key">
                <SidebarMenuButton @click="onMenuClick(item.key, item.action)">
                  <component :is="item.icon" />
                  <span>{{ item.label }}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div class="px-2 py-1 text-xs text-muted-foreground">{{ store.sseStatus === 'live' ? 'SSE 已连接' : '连接中…' }}</div>
      </SidebarFooter>
    </Sidebar>

    <SidebarInset>
      <!-- 顶栏：折叠按钮 + 摘要 -->
      <header class="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <SidebarTrigger class="-ml-1" />
        <span class="text-sm text-muted-foreground">{{ store.summary }}</span>
        <Button variant="outline" size="sm" class="ml-auto" @click="clearLogs(); store.logs = []">清空日志</Button>
      </header>

      <main class="flex flex-1 flex-col gap-4 p-4 md:gap-6 md:p-6">
        <!-- 统计卡行 -->
        <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle class="text-sm font-medium">在线节点</CardTitle>
              <Activity class="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div class="text-2xl font-bold">{{ store.onlineNodes.length }} / {{ store.presences.length }}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle class="text-sm font-medium">活跃工单</CardTitle>
              <ListTodo class="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div class="text-2xl font-bold">{{ store.orders.filter(o => !['done', 'canceled'].includes(o.status)).length }}</div>
              <p class="text-xs text-muted-foreground">共 {{ store.orders.length }} 个工单</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle class="text-sm font-medium">执行中</CardTitle>
              <Server class="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div class="text-2xl font-bold">{{ store.presences.filter(p => p.online && p.state === 'working').length }}</div>
              <p class="text-xs text-muted-foreground">40s 无活动判离线</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle class="text-sm font-medium">角色库</CardTitle>
              <Cog class="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div class="text-2xl font-bold">{{ store.roles.length }}</div>
              <p class="cursor-pointer text-xs text-blue-400" @click="rolesOpen = true">点击管理角色库</p>
            </CardContent>
          </Card>
        </div>

        <!-- 主内容两栏 -->
        <div class="grid flex-1 gap-4 lg:grid-cols-3">
          <div class="flex flex-col gap-4 lg:col-span-2">
            <Card>
              <CardHeader class="flex flex-row items-center">
                <div class="grid gap-1">
                  <CardTitle>工单</CardTitle>
                  <CardDescription>树形查看与派发，支持子工单</CardDescription>
                </div>
                <Badge variant="outline" class="ml-auto">{{ store.orders.length }}</Badge>
              </CardHeader>
              <CardContent>
                <OrderPanel
                  :orders="store.orders"
                  :node-names="store.nodeNames"
                  @create="onOrderCreate"
                  @status-change="(id, s) => store.updateOrderStatus(id, s)"
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader class="flex flex-row items-center">
                <div class="grid gap-1">
                  <CardTitle>节点</CardTitle>
                  <CardDescription>按主机分组的实时名册</CardDescription>
                </div>
                <Button variant="outline" size="sm" class="ml-auto" @click="app.toggleConsole()">
                  {{ app.consoleExpanded ? '收起' : '展开' }}
                </Button>
              </CardHeader>
              <CardContent v-if="app.consoleExpanded">
                <NodeGrid :presences="store.presences" @pick-role="onPickRole" />
              </CardContent>
              <CardContent v-else>
                <div
                  class="flex cursor-pointer items-center justify-center rounded-md border border-dashed py-8 text-xs text-muted-foreground hover:border-blue-500/50 hover:text-blue-400"
                  @click="app.toggleConsole(true)"
                >
                  节点名册已收起，点击展开
                </div>
              </CardContent>
            </Card>
          </div>

          <Card class="flex flex-col">
            <CardHeader class="flex flex-row items-center">
              <div class="grid gap-1">
                <CardTitle>日志</CardTitle>
                <CardDescription>运行与操作记录（200 条滚动）</CardDescription>
              </div>
            </CardHeader>
            <CardContent class="flex min-h-0 flex-1 flex-col">
              <LogPanel :logs="store.logs" class="min-h-[240px] flex-1" />
            </CardContent>
          </Card>
        </div>
      </main>
    </SidebarInset>

    <!-- 右下角悬浮发送 -->
    <div class="fixed bottom-6 right-6 z-40 flex flex-col items-end gap-3">
      <FabPanel v-model:open="fabOpen" :presences="store.presences" @send="onSend" />
      <Button class="h-12 w-12 rounded-full shadow-lg" title="发送留言 / 派发任务" @click="fabOpen = !fabOpen">
        <img :src="'/console/logos/' + 'chat.svg'" alt="" class="h-5 w-5" />
      </Button>
    </div>

    <RolesDialog v-model:open="rolesOpen" :roles="store.roles" @save="onRolesSave" />
    <PmDialog v-model:open="pmOpen" @save="onPmSave" />
    <RolePickDialog v-model:open="pickOpen" :roles="store.roles" :node-name="pickName" :current="pickCurrent" @pick="onPickConfirm" />
  </SidebarProvider>
</template>
