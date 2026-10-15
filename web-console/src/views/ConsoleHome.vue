<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  Activity,
  ChevronRight,
  CircleUser,
  ListTodo,
  Menu,
  Package2,
  Search,
  Server,
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
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from '@/components/ui/sheet'

const store = useConsoleStore()
const app = useAppStore()

const rolesOpen = ref(false)
const pmOpen = ref(false)
const pickOpen = ref(false)
const pickName = ref('')
const pickCurrent = ref('')
const fabOpen = ref(false)

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
  <div class="flex min-h-screen w-full flex-col">
    <!-- header：模板同款，nav + 搜索占位 + 用户菜单 -->
    <header class="sticky top-0 z-40 flex h-16 shrink-0 items-center gap-4 border-b bg-background px-4 md:px-6">
      <Sheet>
        <SheetTrigger as-child>
          <Button variant="outline" size="icon" class="shrink-0 md:hidden">
            <Menu class="h-5 w-5" />
            <span class="sr-only">切换导航</span>
          </Button>
        </SheetTrigger>
        <SheetContent side="left">
          <SheetTitle class="sr-only">导航</SheetTitle>
          <nav class="grid gap-6 text-lg font-medium">
            <a href="#" class="flex items-center gap-2 text-lg font-semibold">
              <Package2 class="h-6 w-6" />
              <span>MAC 控制台</span>
            </a>
            <a href="#">节点</a>
            <a href="#">工单</a>
            <a href="#">日志</a>
          </nav>
        </SheetContent>
      </Sheet>
      <nav class="hidden items-center gap-5 text-sm font-medium md:flex lg:gap-6">
        <a href="#" class="flex items-center gap-2 text-lg font-semibold md:text-base">
          <Package2 class="h-6 w-6" />
          <span>Multi-Agent-Connect</span>
        </a>
        <a href="#" class="text-foreground transition-colors hover:text-foreground">节点</a>
        <a href="#" class="text-muted-foreground transition-colors hover:text-foreground">工单</a>
        <a href="#" class="text-muted-foreground transition-colors hover:text-foreground">日志</a>
      </nav>
      <div class="flex w-full items-center gap-4 md:ml-auto md:gap-2 lg:gap-4">
        <form class="ml-auto flex-1 sm:flex-initial">
          <div class="relative">
            <Search class="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input type="search" placeholder="搜索节点 / 工单…" class="pl-8 sm:w-[300px] md:w-[200px] lg:w-[300px]" />
          </div>
        </form>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="secondary" size="icon" class="rounded-full">
              <CircleUser class="h-5 w-5" />
              <span class="sr-only">菜单</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>控制台操作</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem @click="rolesOpen = true">角色库</DropdownMenuItem>
            <DropdownMenuItem @click="pmOpen = true">PM 说明书</DropdownMenuItem>
            <DropdownMenuItem @click="clearLogs(); store.logs = []">清空日志</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>

    <main class="flex flex-1 flex-col gap-4 p-4 md:gap-8 md:p-8">
      <!-- 统计卡片行 -->
      <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle class="text-sm font-medium">在线节点</CardTitle>
            <Activity class="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div class="text-2xl font-bold">{{ store.onlineNodes.length }} / {{ store.presences.length }}</div>
            <p class="text-xs text-muted-foreground">{{ store.sseStatus === 'live' ? 'SSE 实时连接中' : store.sseStatus === 'error' ? '连接中断，重连中' : '连接中…' }}</p>
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
            <ChevronRight class="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div class="text-2xl font-bold">{{ store.roles.length }}</div>
            <p class="cursor-pointer truncate text-xs text-blue-400" @click="rolesOpen = true">点击管理角色库</p>
          </CardContent>
        </Card>
      </div>

      <!-- 主内容两栏：左=节点+工单（控制台可整体收起），右=日志 -->
      <div class="grid flex-1 gap-4 lg:grid-cols-3">
        <div class="flex flex-col gap-4 lg:col-span-2">
          <!-- 工单 -->
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

          <!-- 节点名册 -->
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

        <!-- 右栏：日志 -->
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
  </div>
</template>
