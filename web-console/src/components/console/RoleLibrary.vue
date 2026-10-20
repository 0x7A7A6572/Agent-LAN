<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Crown, Pencil, Plus, Trash2, X } from 'lucide-vue-next'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { faceDataUrl, roleVisual } from './role-catalog'
import type { RoleDef } from '@/types/console'

const props = defineProps<{
  roles: RoleDef[]
  nodes?: { name: string; role?: string; online?: boolean }[]
}>()
const emit = defineEmits<{ (e: 'save', roles: RoleDef[]): void }>()

const draft = ref<RoleDef[]>([])
// 新增表单常驻在 popover 里，关掉即清空
const addOpen = ref(false)
const nameInput = ref('')
const descInput = ref('')
const nameInputEl = ref<InstanceType<typeof Input> | null>(null)
const editing = ref(-1)
const editName = ref('')
const editDesc = ref('')
const saving = ref(false)

watch(
  () => props.roles,
  v => {
    draft.value = (v ?? []).map(r => ({ name: r.name, desc: r.desc ?? '' }))
  },
  { immediate: true },
)

const dirty = computed(() => signature(props.roles) !== signature(draft.value))

function signature(list: RoleDef[]) {
  return list.map(r => r.name + '\u0000' + (r.desc ?? '')).sort().join('\u0001')
}

// 名册里实际在用的人数：决定角色卡上的在线标
const usage = computed(() => {
  const m = new Map<string, { total: number; online: number }>()
  for (const n of props.nodes ?? []) {
    const r = n.role
    if (!r) continue
    const u = m.get(r) ?? { total: 0, online: 0 }
    u.total++
    if (n.online) u.online++
    m.set(r, u)
  }
  return m
})

const view = computed(() =>
  draft.value.map(r => {
    const v = roleVisual(r.name)
    return {
      name: r.name,
      desc: r.desc ?? '',
      img: faceDataUrl(v, r.name),
      use: usage.value.get(r.name) ?? { total: 0, online: 0 },
    }
  }),
)

function normalize(raw: string) {
  return raw.trim().replace(/\s+/g, ' ')
}

function add() {
  const name = normalize(nameInput.value)
  if (!name) return
  if (!draft.value.some(r => r.name.toLowerCase() === name.toLowerCase())) {
    draft.value.push({ name, desc: normalize(descInput.value) })
  }
  // 加完清空但保持打开，方便连着加几个
  nameInput.value = ''
  descInput.value = ''
  nextTick(() => {
    const el = nameInputEl.value?.$el as HTMLInputElement | undefined
    el?.focus()
  })
}

function remove(i: number) {
  draft.value.splice(i, 1)
}

function startEdit(i: number) {
  const row = draft.value[i]
  if (!row) return
  editing.value = i
  editName.value = row.name
  editDesc.value = row.desc ?? ''
}

function commitEdit() {
  const i = editing.value
  if (i < 0) return
  const name = normalize(editName.value)
  if (!name) {
    editing.value = -1
    return
  }
  // 改名要避开重名；desc 允许为空
  const dup = draft.value.some((r, k) => k !== i && r.name.toLowerCase() === name.toLowerCase())
  if (!dup) draft.value.splice(i, 1, { name, desc: normalize(editDesc.value) })
  editing.value = -1
}

async function save() {
  saving.value = true
  emit('save', draft.value.map(r => ({ name: r.name, desc: r.desc ?? '' })))
  await new Promise(r => setTimeout(r, 400))
  saving.value = false
}
</script>

<template>
  <div class="@container flex flex-col gap-4">
    <!-- 抬头：标题 + 统计 + 保存 -->
    <div class="flex items-center gap-2">
      <div class="flex size-7 shrink-0 items-center justify-center rounded-lg border bg-foreground/[0.05]">
        <Crown class="h-4 w-4" />
      </div>
      <div class="min-w-0 flex-1 leading-tight">
        <p class="text-sm font-semibold">角色设定</p>
        <p class="truncate text-[11px] text-muted-foreground">{{ draft.length }} 个角色 · 保存后全量替换，节点无需重连</p>
      </div>
      <span v-if="dirty" class="text-[11px] text-muted-foreground">未保存</span>
      <button
        class="shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
        :class="dirty ? 'bg-foreground text-background hover:bg-foreground/90' : 'border text-muted-foreground'"
        :disabled="saving"
        @click="save"
      >
        {{ dirty ? '保存变更' : '已同步' }}
      </button>
    </div>

    <!-- 工具行：新增按钮点开就是表单，不常驻占版面 -->
    <div class="flex items-center gap-2">
      <Popover v-model:open="addOpen">
        <PopoverTrigger as-child>
          <button
            class="inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <Plus class="h-3.5 w-3.5" />添加角色
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" side="bottom" class="w-72 p-3">
          <div class="flex flex-col gap-2">
            <div class="leading-tight">
              <p class="text-xs font-semibold">新增角色</p>
              <p class="text-[11px] text-muted-foreground">加完还在，可以连着加</p>
            </div>
            <Input
              ref="nameInputEl"
              v-model="nameInput"
              class="h-8 text-xs"
              placeholder="角色名"
              @keydown.enter="add"
            />
            <Input v-model="descInput" class="h-8 text-xs" placeholder="职责说明（选填）" @keydown.enter="add" />
            <p class="text-[11px] leading-relaxed text-muted-foreground">
              职责会显示在角色卡副标题，例如「负责需求拆解、指标定义与竞品调研」
            </p>
            <div class="flex items-center gap-2 pt-1">
              <button
                class="h-7 flex-1 rounded-md border text-xs font-medium transition-colors hover:bg-foreground/5 disabled:opacity-40"
                :disabled="!nameInput.trim()"
                @click="add"
              >
                添加
              </button>
              <button
                class="h-7 rounded-md px-2.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                @click="addOpen = false"
              >
                完成
              </button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>

    <!-- 角色网格：头像 + 名称 + 职责 -->
    <div class="grid grid-cols-1 gap-x-2 gap-y-2 @[30rem]:grid-cols-2 @[44rem]:grid-cols-3">
      <div
        v-for="(r, i) in view"
        :key="r.name + i"
        class="group relative flex items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-foreground/[0.045]"
      >
        <img :src="r.img" alt="" class="size-10 shrink-0 rounded-xl object-cover" />
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <template v-if="editing !== i">
            <div class="flex items-center gap-2">
              <p class="truncate text-sm font-semibold">{{ r.name }}</p>
              <!-- 主理人徽标：按名字里带不带「主理」判定 -->
              <span
                v-if="r.name.includes('主理')"
                class="inline-flex shrink-0 items-center gap-1 rounded-full bg-foreground/10 px-2 py-0.5 text-[11px] text-muted-foreground"
              >
                <Crown class="h-2.5 w-2.5" />主理人
              </span>
            </div>
            <p class="truncate text-xs text-muted-foreground">
              {{ r.desc || '未填职责' }}<span v-if="r.use.total" class="text-muted-foreground/60"> · {{ r.use.total }} 人</span>
            </p>
          </template>
          <!-- 行内编辑：名字与职责都能改 -->
          <template v-else>
            <Input v-model="editName" class="h-7 text-xs" placeholder="角色名" @keydown.enter="commitEdit" @keydown.esc="editing = -1" />
            <Input v-model="editDesc" class="h-7 text-xs" placeholder="职责说明（选填）" @keydown.enter="commitEdit" @keydown.esc="editing = -1" />
          </template>
        </div>
        <div class="flex shrink-0 items-center gap-0.5" :class="editing === i ? '' : 'opacity-0 transition-opacity group-hover:opacity-100'">
          <button
            class="rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            :title="editing === i ? '完成编辑' : '改名称与职责'"
            @click="editing === i ? commitEdit() : startEdit(i)"
          >
            <Pencil v-if="editing !== i" class="h-3.5 w-3.5" />
            <X v-else class="h-3.5 w-3.5" />
          </button>
          <button
            class="rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-destructive"
            title="从角色库移除"
            @click="remove(i)"
          >
            <Trash2 class="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>

    <p v-if="!view.length" class="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
      角色库是空的，点「添加角色」开始
    </p>
    <p v-else class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      悬停卡片可改名或改职责；职责留空时显示「未填职责」
    </p>
  </div>
</template>
