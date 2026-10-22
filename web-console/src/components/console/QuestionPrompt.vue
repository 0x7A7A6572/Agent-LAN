<script setup lang="ts">
// 节点提问卡：把 agent 的 AskUserQuestion 渲染成可点选的题（shadcn-vue 风格）。
// 单选用圆点、多选用方角；答完直接在卡片内显示选择结果，不再弹窗。
import { computed, ref, watch } from 'vue'
import { Check, Clock, MessageCircleQuestion, TriangleAlert } from 'lucide-vue-next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { answerQuestion } from '@/api/console'
import type { NodeQuestion } from '@/types/console'

const props = defineProps<{
  question: NodeQuestion
  /** 节点名：答复按名字回投，题卡本身不猜 */
  nodeName: string
  /** 紧凑模式：节点卡内嵌用，题干截断、按钮更小 */
  compact?: boolean
}>()

const emit = defineEmits<{
  (e: 'answered', question: NodeQuestion): void
  (e: 'log', line: string): void
}>()

const choice = ref<Record<string, string[]>>({})
const other = ref('')
const submitting = ref(false)
const error = ref('')

const answered = computed(() => props.question.answer)
const multiCount = computed(() => props.question.questions.filter(q => q.multiSelect).length)
// 头部标签随状态走：答完还写「待人工确认」会让人以为没提交成功
const headLabel = computed(() =>
  answered.value ? '已答复 · 待节点确认' : props.question.kind === 'plan' ? '计划待确认' : '待人工确认',
)

function reset() {
  choice.value = JSON.parse(JSON.stringify(props.question.answer?.choice ?? {}))
  other.value = ''
  error.value = ''
}
watch(() => props.question.id, reset, { immediate: true })

function picked(i: number): string[] {
  return choice.value[String(i)] ?? []
}

function toggle(i: number, label: string, multi?: boolean) {
  if (answered.value) return
  const key = String(i)
  const cur = picked(i)
  if (multi) {
    choice.value = { ...choice.value, [key]: cur.includes(label) ? cur.filter(x => x !== label) : [...cur, label] }
  } else {
    // 单选：再点一次取消，方便改主意
    choice.value = { ...choice.value, [key]: cur[0] === label ? [] : [label] }
  }
  error.value = ''
}

function isPicked(i: number, label: string): boolean {
  return picked(i).includes(label)
}

const empty = computed(() =>
  props.question.questions.every((_, i) => picked(i).length === 0) && !other.value.trim(),
)

async function submit() {
  if (answered.value || submitting.value) return
  if (empty.value) {
    error.value = '先选一项，或在「其他」里写一句'
    return
  }
  submitting.value = true
  error.value = ''
  try {
    const r = await answerQuestion(props.nodeName, choice.value, other.value.trim())
    if (!r.ok) {
      error.value = r.error ?? '提交失败'
      return
    }
    emit('log', '[ask] 已答复 ' + props.nodeName + '：' + flattenAnswer())
    emit('answered', r.question ?? props.question)
  } catch (err: any) {
    error.value = String(err?.message ?? err)
  } finally {
    submitting.value = false
  }
}

function flattenAnswer(): string {
  return props.question.questions
    .map((q, i) => (picked(i).join('、') || '（未选）') + (i === 0 && other.value.trim() ? ' + ' + other.value.trim() : ''))
    .join(' / ')
}

function timeOf(at?: number): string {
  if (!at) return ''
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
}
</script>

<template>
  <div
    class="rounded-lg border border-amber-500/50 bg-amber-500/[0.06] text-left"
    :class="compact ? 'p-2.5' : 'p-3.5'"
    @click.stop
  >
    <!-- 头部：来源与时间 -->
    <div class="flex items-center gap-1.5">
      <MessageCircleQuestion class="size-3.5 shrink-0 text-amber-500" />
      <span class="text-xs font-medium text-amber-600 dark:text-amber-400">
        {{ headLabel }}
      </span>
      <Badge v-if="multiCount > 0" variant="secondary" class="h-4 px-1 text-[10px]">含多选</Badge>
      <span class="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
        <Clock class="size-3" />{{ timeOf(question.at) }}
      </span>
    </div>

    <p v-if="question.title" class="mt-1 truncate text-[11px] text-muted-foreground" :title="question.title">
      {{ question.title }}
    </p>

    <!-- 题干与选项 -->
    <div class="mt-2 space-y-3">
      <div v-for="(q, i) in question.questions" :key="i" class="space-y-1.5">
        <p v-if="q.header" class="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {{ q.header }}
        </p>
        <p class="text-sm font-medium leading-snug" :class="compact ? 'line-clamp-2' : ''">{{ q.question }}</p>

        <div v-if="q.options?.length" class="space-y-1.5">
          <button
            v-for="opt in q.options"
            :key="opt.label"
            type="button"
            :disabled="!!answered"
            class="flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left transition-colors"
            :class="[
              isPicked(i, opt.label)
                ? 'border-primary bg-primary/10'
                : 'border-border hover:bg-muted/60',
              answered ? 'cursor-default' : 'cursor-pointer',
            ]"
            @click="toggle(i, opt.label, q.multiSelect)"
          >
            <span
              class="mt-0.5 flex size-4 shrink-0 items-center justify-center border"
              :class="[
                q.multiSelect ? 'rounded-[4px]' : 'rounded-full',
                isPicked(i, opt.label) ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/50',
              ]"
            >
              <Check v-if="isPicked(i, opt.label)" class="size-3" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block text-sm leading-tight">{{ opt.label }}</span>
              <span v-if="opt.description" class="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                {{ opt.description }}
              </span>
            </span>
          </button>
        </div>
        <p v-else class="text-[11px] italic text-muted-foreground">（这道题没有给选项，直接在其他里回答）</p>

        <!-- 其他：只对第一题开放，与后端 other 字段一一对应 -->
        <Input
          v-if="i === 0 && !answered"
          v-model="other"
          :placeholder="q.options?.length ? '其他（补充一句，会一起回给节点）' : '输入你的回答'"
          class="h-7 text-xs"
          @keydown.enter.prevent="submit"
        />
      </div>
    </div>

    <!-- 已答复：显示选择结果 -->
    <div v-if="answered" class="mt-2 flex flex-wrap items-center gap-1.5 border-t border-amber-500/30 pt-2 text-[11px] text-muted-foreground">
      <Badge variant="secondary" class="h-4 px-1 text-[10px]">已答复</Badge>
      <span>{{ timeOf(answered.at) }}</span>
      <span class="opacity-60">·</span>
      <span class="truncate">已作为留言投递给节点，等它确认</span>
    </div>

    <!-- 未答复：提交 -->
    <div v-else class="mt-2.5 flex items-center gap-2">
      <Button size="sm" :disabled="submitting" @click="submit">
        {{ submitting ? '提交中…' : '提交答复' }}
      </Button>
      <span v-if="error" class="flex items-center gap-1 text-[11px] text-destructive">
        <TriangleAlert class="size-3" />{{ error }}
      </span>
      <span v-else class="text-[11px] text-muted-foreground">答复会作为留言送达 {{ nodeName || '该节点' }}</span>
    </div>
  </div>
</template>
