<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { SplitterGroup, SplitterPanel, SplitterResizeHandle } from 'reka-ui'
import { ChevronsDownUp, ChevronsUpDown, Eraser, ScrollText, Users, FileText } from 'lucide-vue-next'
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
import Button from '@/components/ui/Button.vue'
import Badge from '@/components/ui/Badge.vue'

const store = useConsoleStore()
const app = useAppStore()

const rolesOpen = ref(false)
const pmOpen = ref(false)
const pickOpen = ref(false)
const pickName = ref('')
const pickCurrent = ref('')
const fabOpen = ref(false)
const orderPanel = ref<InstanceType<typeof OrderPanel> | null>(null)

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
  <div class="flex h-full flex-col gap-2.5">
    <!-- 顶栏：标题 + 摘要 + 操作 -->
    <div class="flex flex-wrap items-center gap-2">
      <h1 class="text-base font-bold text-foreground">Multi-Agent-Connect</h1>
      <span class="text-xs" :class="store.sseStatus === 'live' ? 'text-muted-foreground' : 'text-yellow-500'">
        {{ store.sseStatus === 'live' ? store.summary : store.sseStatus === 'error' ? '连接中断，重连中…' : '连接中…' }}
      </span>
      <span class="ml-auto flex items-center gap-1.5">
        <Button variant="secondary" size="xs" @click="rolesOpen = true"><Users class="h-3 w-3" />角色库</Button>
        <Button variant="secondary" size="xs" @click="pmOpen = true"><FileText class="h-3 w-3" />PM 说明书</Button>
        <Button variant="secondary" size="xs" @click="app.toggleLogs()"><ScrollText class="h-3 w-3" />日志</Button>
        <Button variant="secondary" size="xs" @click="clearLogs(); store.logs = []"><Eraser class="h-3 w-3" />清空</Button>
        <Button variant="secondary" size="xs" @click="app.toggleConsole()">
          <ChevronsUpDown v-if="!app.consoleExpanded" class="h-3 w-3" />
          <ChevronsDownUp v-else class="h-3 w-3" />
          {{ app.consoleExpanded ? '收起控制台' : '展开控制台' }}
        </Button>
      </span>
    </div>

    <!-- 可拉调主布局：上=控制台区（可整体收起），下=日志区，中间拖拽分割 -->
    <SplitterGroup direction="vertical" class="min-h-0 flex-1">
      <SplitterPanel :min-size="20" class="flex min-h-0 flex-col">
        <!-- 控制台主体：默认收起，点开才渲染 -->
        <template v-if="app.consoleExpanded">
          <!-- 工单区：移到首页，树形查看 -->
          <section class="rounded-md border border-border bg-card/40 p-2.5">
            <div class="mb-2 flex items-center gap-2">
              <h2 class="text-[13px] font-semibold text-foreground">工单</h2>
              <Badge variant="outline">{{ store.orders.length }}</Badge>
            </div>
            <OrderPanel
              ref="orderPanel"
              :orders="store.orders"
              :node-names="store.nodeNames"
              @create="onOrderCreate"
              @status-change="(id, s) => store.updateOrderStatus(id, s)"
            />
          </section>

          <!-- 节点名册：按主机分组 -->
          <NodeGrid :presences="store.presences" class="mt-2.5" @pick-role="onPickRole" />
        </template>

        <!-- 收起时的引导条 -->
        <div
          v-else
          class="flex flex-1 cursor-pointer items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground hover:border-blue-600/50 hover:text-blue-400"
          @click="app.toggleConsole(true)"
        >
          控制台已收起，点击展开（节点名册 + 工单）
        </div>
      </SplitterPanel>

      <!-- 日志面板：关闭时不渲染，分割条随之消失 -->
      <template v-if="app.showLogs">
        <SplitterResizeHandle class="group relative h-1.5 rounded-sm bg-transparent transition-colors hover:bg-blue-600/40 data-[state=drag]:bg-blue-600/60" />
        <SplitterPanel :min-size="10" :default-size="25" class="flex min-h-0 flex-col">
          <LogPanel :logs="store.logs" />
        </SplitterPanel>
      </template>
    </SplitterGroup>

    <!-- 右下角悬浮发送 -->
    <div class="fixed bottom-5 right-5 z-40 flex flex-col items-end gap-3">
      <FabPanel v-model:open="fabOpen" :presences="store.presences" @send="onSend" />
      <button
        class="flex h-11 w-11 items-center justify-center rounded-full border border-green-500 bg-green-500 text-white shadow-lg transition hover:scale-105"
        title="发送留言 / 派发任务"
        @click="fabOpen = !fabOpen"
      >
        <img :src="'/console/logos/' + 'chat.svg'" alt="" class="h-5 w-5" />
      </button>
    </div>

    <RolesDialog v-model:open="rolesOpen" :roles="store.roles" @save="onRolesSave" />
    <PmDialog v-model:open="pmOpen" @save="onPmSave" />
    <RolePickDialog v-model:open="pickOpen" :roles="store.roles" :node-name="pickName" :current="pickCurrent" @pick="onPickConfirm" />
  </div>
</template>
