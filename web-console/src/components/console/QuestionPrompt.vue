<script setup lang="ts">
// 节点提问卡：用 shadcn-vue 的 Questionnaire（多步问卷）渲染 agent 的 AskUserQuestion。
// 一题一步、自动进度/校验/键盘快捷键；答完原地转为只读回看态。
import { computed, ref } from 'vue'
import { Check, Clock, MessageCircleQuestion } from 'lucide-vue-next'
import { Badge } from '@/components/ui/badge'
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from '@/components/ui/questionnaire'
import type { QuestionnaireItemDefinition } from '@/components/ui/questionnaire'
import { answerQuestion } from '@/api/console'
import type { NodeQuestion } from '@/types/console'

const props = defineProps<{
  question: NodeQuestion
  /** 节点名：答复按名字回投，题卡本身不猜 */
  nodeName: string
}>()

const emit = defineEmits<{
  (e: 'answered', question: NodeQuestion): void
  (e: 'log', line: string): void
}>()

const answered = computed(() => props.question.answer)
const headLabel = computed(() =>
  answered.value ? '已答复 · 待节点确认' : props.question.kind === 'plan' ? '计划待确认' : '待人工确认',
)
const submitting = ref(false)
const error = ref('')

// 字段名用 q0/q1…：FormData 按 name 回收，服务端 choice 也按题序号索引
const keyOf = (i: number) => 'q' + i
const items = computed<QuestionnaireItemDefinition[]>(() =>
  props.question.questions.map((q, i) => ({
    name: keyOf(i),
    // 有选项的题给 items 声明 choice，快捷键与顺序才稳定；没有选项的走自由填写
    ...(q.options?.length ? { choices: q.options.map(o => ({ value: o.label })) } : {}),
    required: true,
  })),
)

async function onSubmit(e: Event) {
  e.preventDefault()
  if (answered.value || submitting.value) return
  const fd = new FormData(e.target as HTMLFormElement)
  const choice: Record<string, string[]> = {}
  props.question.questions.forEach((_, i) => {
    const picked = fd.getAll(keyOf(i)).map(String).map(s => s.trim()).filter(Boolean)
    if (picked.length) choice[String(i)] = picked
  })
  if (!Object.keys(choice).length) {
    error.value = '先选一项或填写内容'
    return
  }
  submitting.value = true
  error.value = ''
  try {
    const r = await answerQuestion(props.nodeName, choice)
    if (!r.ok) {
      error.value = r.error ?? '提交失败'
      return
    }
    emit('log', '[ask] 已答复 ' + props.nodeName)
    emit('answered', r.question ?? props.question)
  } catch (err: any) {
    error.value = String(err?.message ?? err)
  } finally {
    submitting.value = false
  }
}

function timeOf(at?: number): string {
  if (!at) return ''
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
}

/** 回看态：把当初的选择从 answer.choice 里取出来展示 */
function chosenOf(i: number): string[] {
  return answered.value?.choice?.[String(i)] ?? []
}
</script>

<template>
  <div class="rounded-lg border border-amber-500/50 bg-amber-500/[0.06] p-3.5 text-left" @click.stop>
    <!-- 头部：来源与时间 -->
    <div class="flex items-center gap-1.5">
      <MessageCircleQuestion class="size-3.5 shrink-0 text-amber-500" />
      <span class="text-xs font-medium text-amber-600 dark:text-amber-400">{{ headLabel }}</span>
      <Badge v-if="question.questions.length > 1" variant="secondary" class="h-4 px-1 text-[10px]">
        {{ question.questions.length }} 问
      </Badge>
      <span class="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
        <Clock class="size-3" />{{ timeOf(question.at) }}
      </span>
    </div>

    <p v-if="question.title" class="mt-1 truncate text-[11px] text-muted-foreground" :title="question.title">
      {{ question.title }}
    </p>

    <!-- 已回答：只读回看 -->
    <div v-if="answered" class="mt-2 space-y-2">
      <div v-for="(q, i) in question.questions" :key="i" class="space-y-1">
        <p v-if="q.header" class="text-[11px] font-medium tracking-wide text-muted-foreground">{{ q.header }}</p>
        <p class="text-sm font-medium leading-snug">{{ q.question }}</p>
        <div class="flex flex-wrap gap-1">
          <span
            v-for="c in chosenOf(i)"
            :key="c"
            class="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-xs"
          >
            <Check class="size-3" />{{ c }}
          </span>
          <span v-if="!chosenOf(i).length" class="text-xs text-muted-foreground">（未选）</span>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-1.5 border-t border-amber-500/30 pt-2 text-[11px] text-muted-foreground">
        <Badge variant="secondary" class="h-4 px-1 text-[10px]">已答复</Badge>
        <span>{{ timeOf(answered.at) }}</span>
        <span class="opacity-60">·</span>
        <span>节点当场拿到答复，已继续执行</span>
      </div>
    </div>

    <!-- 未回答：问卷表单 -->
    <Questionnaire
      v-else
      :items="items"
      class="mt-2 gap-3"
      @submit="onSubmit"
    >
      <QuestionnaireProgress
        v-if="question.questions.length > 1"
        v-slot="{ current, total }"
        class="min-w-0 text-[11px] text-muted-foreground"
      >
        第 {{ current }} / {{ total }} 题
      </QuestionnaireProgress>

      <QuestionnaireItem
        v-for="(q, i) in question.questions"
        :key="i"
        :name="keyOf(i)"
        :multiple="!!q.multiSelect"
        required
      >
        <!-- header 放在题干上方（问卷自带的 Description 是题干下方辅助说明，语义反了） -->
        <p v-if="q.header" class="text-[11px] font-medium tracking-wide text-muted-foreground">
          {{ q.header }}<span v-if="q.multiSelect" class="ml-1 opacity-70">· 可多选</span>
        </p>
        <QuestionnaireTitle class="text-sm font-medium leading-snug">{{ q.question }}</QuestionnaireTitle>
        <QuestionnaireChoices v-if="q.options?.length">
          <QuestionnaireChoice v-for="o in q.options" :key="o.label" :value="o.label">
            {{ o.label }}
            <QuestionnaireChoiceDescription v-if="o.description">
              {{ o.description }}
            </QuestionnaireChoiceDescription>
          </QuestionnaireChoice>
        </QuestionnaireChoices>
        <QuestionnaireInput v-else placeholder="输入你的回答（回车继续）" />
        <QuestionnaireError class="text-[11px] text-destructive" />
      </QuestionnaireItem>

      <QuestionnaireActions class="mt-1">
        <QuestionnairePrevious>上一题</QuestionnairePrevious>
        <QuestionnaireNext>下一题</QuestionnaireNext>
        <QuestionnaireSubmit>{{ submitting ? '提交中…' : '提交答复' }}</QuestionnaireSubmit>
      </QuestionnaireActions>
    </Questionnaire>

    <p v-if="!answered && error" class="mt-1 text-[11px] text-destructive">{{ error }}</p>
    <p v-else-if="!answered" class="mt-1 text-[11px] text-muted-foreground">
      提交后 {{ nodeName }} 立刻拿到答复继续；超时它才回落到本地提问框
    </p>
  </div>
</template>
