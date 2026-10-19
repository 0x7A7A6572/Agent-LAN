<script setup lang="ts">
import { ref, watch } from 'vue'
import { CloudUpload } from 'lucide-vue-next'
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
import { Select, SelectContent, SelectTrigger, SelectValue } from '@/components/ui/select'
import NodeSelectItem from './NodeSelectItem.vue'
import { Textarea } from '@/components/ui/textarea'
import type { OrderAttachment, OrderPriority, Presence } from '@/types/console'

const props = defineProps<{ presences: Presence[]; parent?: { id: string; title: string } | null }>()
const emit = defineEmits<{
  (e: 'create', body: { title: string; assignee?: string; priority: OrderPriority; parent?: string; description?: string; attachments?: OrderAttachment[] }): void
}>()

const open = defineModel<boolean>('open', { default: false })
const title = ref('')
const description = ref('')
const assignee = ref('')
const priority = ref<OrderPriority>('normal')
const files = ref<File[]>([])
const uploading = ref(false)
const dragging = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

watch(open, v => {
  if (v) {
    title.value = ''
    description.value = ''
    assignee.value = ''
    priority.value = 'normal'
    files.value = []
  }
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

function removeFile(i: number) {
  files.value.splice(i, 1)
}

async function submit() {
  const t = title.value.trim()
  if (!t) return
  uploading.value = true
  const attachments: OrderAttachment[] = []
  try {
    // 先传共享文件区拿 URI，再随建单挂到工单
    for (const f of files.value) {
      const res = await fetch('/files/' + encodeURIComponent(f.name), { method: 'PUT', body: f })
      const r = (await res.json()) as { uri?: string; error?: string }
      if (!res.ok || !r.uri) throw new Error(r.error || '上传失败: ' + f.name)
      attachments.push({ name: f.name, uri: r.uri, by: 'human-console' })
    }
  } catch (err) {
    alert(String((err as Error).message || err))
    uploading.value = false
    return
  }
  uploading.value = false
  emit('create', {
    title: t,
    assignee: assignee.value || undefined,
    priority: priority.value,
    parent: props.parent?.id,
    description: description.value.trim() || undefined,
    attachments: attachments.length ? attachments : undefined,
  })
  open.value = false
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ parent ? '创建子工单' : '创建工单' }}</DialogTitle>
        <DialogDescription>
          {{ parent ? '父工单：' + parent.id + ' ' + parent.title : '建单后立即派发给所选节点' }}
        </DialogDescription>
      </DialogHeader>

      <div class="grid gap-4">
        <div class="grid gap-2">
          <Label for="order-title">标题</Label>
          <Input id="order-title" v-model="title" placeholder="工单标题…" @keydown.enter="submit" />
        </div>
        <div class="grid gap-2">
          <Label for="order-desc">描述</Label>
          <Textarea id="order-desc" v-model="description" :rows="3" placeholder="补充说明（可空）" />
        </div>
        <div class="grid gap-2">
          <Label>附件（可多选）</Label>
          <input ref="fileInput" type="file" multiple class="hidden" @change="onPick" />
          <div
            class="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center transition-colors hover:bg-accent/40"
            :class="dragging ? 'border-foreground/60 bg-accent/60' : ''"
            @click="fileInput?.click()"
            @dragover.prevent="dragging = true"
            @dragleave.prevent="dragging = false"
            @drop.prevent="onDrop"
          >
            <span class="flex size-10 items-center justify-center rounded-lg bg-muted">
              <CloudUpload class="h-5 w-5" />
            </span>
            <span class="text-sm font-medium">上传文件</span>
            <span class="text-xs text-muted-foreground">拖拽到此处或点击选择，单个不超过 200MB</span>
            <Button type="button" variant="secondary" size="sm" class="mt-1" @click.stop="fileInput?.click()">
              浏览文件
            </Button>
          </div>
          <ul v-if="files.length" class="text-xs text-muted-foreground">
            <li v-for="(f, i) in files" :key="i" class="flex items-center gap-2">
              <span class="truncate">{{ f.name }}（{{ (f.size / 1024).toFixed(1) }} KB）</span>
              <button type="button" class="text-destructive hover:underline" @click="removeFile(i)">移除</button>
            </li>
          </ul>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="grid gap-2">
            <Label>指派给</Label>
            <Select v-model="assignee">
              <SelectTrigger class="w-full"><SelectValue placeholder="选择节点…" /></SelectTrigger>
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
      </div>

      <DialogFooter>
        <Button variant="outline" @click="open = false">取消</Button>
        <Button :disabled="!title.trim() || uploading" @click="submit">{{ uploading ? '上传中…' : '创建并派发' }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
