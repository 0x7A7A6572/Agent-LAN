<script setup lang="ts">
import { computed } from 'vue'
import { CircleHelp, LifeBuoy, Mail, Plus, Settings } from 'lucide-vue-next'
import { useConsoleStore } from '@/stores/console'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'

const emit = defineEmits<{ (e: 'create-order'): void }>()
const store = useConsoleStore()

// 锚点菜单：点击平滑滚到对应区块
const anchors = [
  { key: 'logs', label: '日志（同导航）' },
  { key: 'orders', label: '工单（首页锚点导航到工单面板）' },
  { key: 'roles', label: '角色库' },
]

const groups = computed(() => {
  const map = new Map<string, { name: string; online: boolean }[]>()
  for (const p of store.presences) {
    const h = p.groupHost || p.card.host || p.card.url
    if (!map.has(h)) map.set(h, [])
    map.get(h)!.push({ name: p.card.name, online: p.online })
  }
  return [...map.entries()].map(([host, members]) => ({ host, members, onlineCount: members.filter(m => m.online).length }))
})

function scrollTo(key: string) {
  if (key === 'roles') {
    store.loadRoles()
    document.getElementById('sec-roles-card')?.scrollIntoView({ behavior: 'smooth' })
    return
  }
  document.getElementById('sec-' + key)?.scrollIntoView({ behavior: 'smooth' })
}
</script>

<template>
  <Sidebar>
    <SidebarHeader>
      <!-- 品牌头：截图同款圆点 logo + 名称 -->
      <div class="flex items-center gap-2 px-2 py-1.5">
        <div class="flex size-6 items-center justify-center rounded-full border-2 border-foreground" />
        <span class="text-sm font-semibold">Acme Inc.</span>
      </div>
      <!-- 绿色建单 CTA + 邮件 -->
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton class="bg-primary text-primary-foreground hover:bg-primary/90" @click="emit('create-order')">
            <Plus />
            <span>创建工单</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem class="hidden">
          <SidebarMenuButton>
            <Mail />
            <span>留言</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>

    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem v-for="a in anchors" :key="a.key">
              <SidebarMenuButton @click="scrollTo(a.key)">
                <span>{{ a.label }}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <!-- 节点区：实时名册按主机分组 -->
      <SidebarGroup>
        <SidebarGroupLabel>节点</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <template v-for="g in groups" :key="g.host">
              <SidebarMenuItem v-for="m in g.members" :key="m.name">
                <SidebarMenuButton>
                  <span class="size-2 shrink-0 rounded-sm" :class="m.online ? 'bg-green-500' : 'bg-muted-foreground/40'" />
                  <span class="truncate">{{ m.name }}</span>
                </SidebarMenuButton>
                <SidebarMenuBadge>{{ m.online ? '在线' : '离线' }}</SidebarMenuBadge>
              </SidebarMenuItem>
            </template>
            <div v-if="!store.presences.length" class="px-2 py-1 text-xs text-muted-foreground">暂无节点</div>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>

    <SidebarFooter>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton>
            <Settings />
            <span>Settings</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton>
            <LifeBuoy />
            <span>Get Help</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem class="hidden">
          <SidebarMenuButton>
            <CircleHelp />
            <span>Search</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
    <SidebarRail />
  </Sidebar>
</template>
