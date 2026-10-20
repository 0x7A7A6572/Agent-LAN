<script setup lang="ts">
import { ref, watch } from 'vue'
import { CloudUpload, Paperclip, X } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import NodeSelectItem from './NodeSelectItem.vue'
import { Textarea } from '@/components/ui/textarea'
import type { Order, OrderAttachment, OrderPriority, OrderStatus, Presence } from '@/types/console'

const props = defineProps<{ presences: Presence[] }>()
const emit = defineEmits<{
  (e: 'save', order: Order, patch: Partial<Order>, attachments?: { add: OrderAttachment[]; remove: string[] }): void
}>()

const open = defineModel<boolean>('open', { default: false })
const STATUSES: OrderStatus[] = ['backlog', 'analyzing', 'developing', 'blocked', 'testing', 'review', 'done', 'canceled']
const current = ref<Order | null>(null)
const title = ref('')
const description = ref('')
const assignee = ref('')
const priority = ref<OrderPriority>('normal')
const status = ref<OrderStatus>('backlog')

// 附件：保留已有（可标记移除）+ 新选待上传
const kept = ref<OrderAttachment[]>([])
const removed = ref<string[]>([])
const files = ref<File[]>([])
const uploading = ref(false)
const dragging = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

watch(open, v => {
  if (!v || !current.value) return
  title.value = current.value.title
  description.value = current.value.description ?? ''
  assignee.value = current.value.assignee ?? ''
  priority.value = current.value.priority
  status.value = current.value.status
  kept.value = [...(current.value.attachments ?? [])]
  removed.value = []
  files.value = []
})

function onPick(e: Event) {
  const list = (e.target as HTMLInputElement).files
  if (list) files.value = [...files.value, ...list]
  if (fileInput.value) fileInput.value.value = ''
}

function onDrop(e: DragEvent) {
  dragging.value = false
  if (e.dataTransfer?.files.length) files.value = [...files.value, ...e.dataTransfer.files]
}

function markRemove(name: string) {
  kept.value = kept.value.filter(a => a.name !== name)
  removed.value = [...removed.value, name]
}

async function submit() {
  const t = title.value.trim()
  if (!t || !current.value) return
  const add: OrderAttachment[] = []
  if (files.value.length) {
    uploading.value = true
    try {
      // 与建单同路子：先传共享文件区拿 URI，再随保存挂到工单
      for (const f of files.value) {
        const res = await fetch('/files/' + encodeURIComponent(f.name), { method: 'PUT', body: f })
        const r = (await res.json()) as { uri?: string; error?: string }
        if (!res.ok || !r.uri) throw new Error(r.error || '上传失败: ' + f.name)
        add.push({ name: f.name, uri: r.uri, by: 'human-console' })
      }
    } catch (err) {
      alert(String((err as Error).message || err))
      uploading.value = false
      return
    }
    uploading.value = false
  }
  emit('save', current.value, {
    title: t,
    description: description.value.trim() || undefined,
    assignee: assignee.value || undefined,
    priority: priority.value,
    status: status.value,
  }, add.length || removed.value.length ? { add, remove: removed.value } : undefined)
  open.value = false
}

defineExpose({ show: (o: Order) => { current.value = o; open.value = true } })
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle class="text-sm">编辑工单</DialogTitle>
        <DialogDescription class="font-mono text-xs">{{ current?.id }}</DialogDescription>
      </DialogHeader>

      <div class="grid gap-4">
        <div class="grid gap-2">
          <Label for="edit-title">标题</Label>
          <Input id="edit-title" v-model="title" @keydown.enter="submit" />
        </div>
        <div class="grid gap-2">
          <Label for="edit-desc">描述</Label>
          <Textarea id="edit-desc" v-model="description" :rows="3" />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="grid gap-2">
            <Label>指派给</Label>
            <Select v-model="assignee">
              <SelectTrigger class="w-full"><SelectValue placeholder="未指派" /></SelectTrigger>
              <SelectContent class="min-w-[260px]">
                <NodeSelectItem v-for="p in presences" :key="p.card.name" :presence="p" />
              </SelectContent>
            </Select>
          </div>
          <div class="grid gap-2">
            <Label>优先级</Label>
            <Select v-model="priority">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="normal">普通</SelectItem>
                <SelectItem value="high">高</SelectItem>
                <SelectItem value="urgent">紧急</SelectItem>
                <SelectItem value="low">低</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div class="grid gap-2">
          <Label>状态</Label>
          <Select v-model="status">
            <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="s in STATUSES" :key="s" :value="s">{{ s }}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div class="grid gap-2">
          <Label>附件</Label>
          <!-- 已有附件：点 × 标记移除，保存时生效 -->
          <ul v-if="kept.length" class="grid gap-1">
            <li
              v-for="a in kept"
              :key="a.name"
              class="flex items-center gap-2 rounded border px-2 py-1 text-xs"
            >
              <Paperclip class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <a :href="a.uri" target="_blank" class="flex-1 truncate hover:underline">{{ a.name }}</a>
              <button type="button" class="text-destructive" title="移除附件" @click="markRemove(a.name)">
                <X class="h-3.5 w-3.5" />
              </button>
            </li>
          </ul>
          <input ref="fileInput" type="file" multiple class="hidden" @change="onPick" />
          <div
            class="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm transition-colors hover:bg-accent/40"
            :class="dragging ? 'border-foreground/60 bg-accent/60' : ''"
            @click="fileInput?.click()"
            @dragover.prevent="dragging = true"
            @dragleave.prevent="dragging = false"
            @drop.prevent="onDrop"
          >
            <CloudUpload class="h-4 w-4 text-muted-foreground" />
            <span class="text-muted-foreground">点击或拖拽添加附件</span>
          </div>
          <ul v-if="files.length" class="grid gap-1 text-xs text-muted-foreground">
            <li v-for="(f, i) in files" :key="i" class="flex items-center gap-2">
              <span class="flex-1 truncate">{{ f.name }}</span>
              <button type="button" class="text-destructive hover:underline" @click="files.splice(i, 1)">移除</button>
            </li>
          </ul>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="open = false">取消</Button>
        <Button :disabled="!title.trim() || uploading" @click="submit">{{ uploading ? '上传中…' : '保存' }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
