<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Download, FolderOpen, RefreshCw } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { fetchFiles, openInExplorer } from '@/api/console'
import type { FileInfo } from '@/types/console'

const open = defineModel<boolean>('open', { default: false })
const files = ref<FileInfo[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  const r = await fetchFiles()
  files.value = r.files ?? []
  loading.value = false
}

onMounted(load)

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return (n / 1024).toFixed(1) + ' KB'
}

async function reveal(f: FileInfo) {
  const r = await openInExplorer(f.name)
  if (!r.ok) alert(r.error || '打开失败（控制台与 hub 不在同一台机器时不可用）')
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>资料库</DialogTitle>
        <DialogDescription>共享文件区的全部文件，点击下载</DialogDescription>
      </DialogHeader>
      <div class="flex items-center justify-between">
        <span class="text-xs text-muted-foreground">共 {{ files.length }} 个文件</span>
        <Button variant="outline" size="sm" :disabled="loading" @click="load">
          <RefreshCw class="h-4 w-4" />
          刷新
        </Button>
      </div>
      <div class="max-h-[50vh] overflow-y-auto rounded-md border">
        <div v-if="!files.length" class="py-8 text-center text-sm text-muted-foreground">
          {{ loading ? '加载中…' : '文件区还是空的' }}
        </div>
        <ul v-else class="divide-y text-sm">
          <li v-for="f in files" :key="f.uri" class="flex items-center gap-3 px-3 py-2">
            <div class="min-w-0 flex-1">
              <div class="truncate">{{ f.name }}</div>
              <div class="text-xs text-muted-foreground">
                {{ fmtSize(f.size) }} · {{ f.mtime.slice(0, 16).replace('T', ' ') }}
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <button
                type="button"
                class="text-muted-foreground hover:text-foreground"
                title="在资源管理器中打开（仅 hub 本机生效）"
                @click="reveal(f)"
              >
                <FolderOpen class="h-4 w-4" />
              </button>
              <a :href="f.uri" :download="f.name" class="text-muted-foreground hover:text-foreground" title="下载">
                <Download class="h-4 w-4" />
              </a>
            </div>
          </li>
        </ul>
      </div>
    </DialogContent>
  </Dialog>
</template>
