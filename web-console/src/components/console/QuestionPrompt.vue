<script setup lang="ts">
// 只读题卡：控制台只负责「让人看见节点在等什么」，不提供作答。
//
// 为什么不做作答：AskUserQuestion 的卡片一旦弹出就无法从外部关闭（PreToolUse 在用户点完
// 之后才触发，settings 的 permissions.deny 也禁不掉它）。控制台答完人还得回节点再点一下，
// 等于两次操作，反而更绕。所以决策统一在 agent 节点做，这里只把问题与选项展示清楚。
import { Clock, MessageCircleQuestion } from 'lucide-vue-next'
import { Badge } from '@/components/ui/badge'
import type { NodeQuestion } from '@/types/console'

defineProps<{
  question: NodeQuestion
  /** 节点名：提示人回哪个会话去答 */
  nodeName: string
}>()

function timeOf(at?: number): string {
  if (!at) return ''
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
}
</script>

<template>
  <div class="rounded-lg border border-amber-500/50 bg-amber-500/[0.06] p-3.5 text-left">
    <div class="flex items-center gap-1.5">
      <MessageCircleQuestion class="size-3.5 shrink-0 text-amber-500" />
      <span class="text-xs font-medium text-amber-600 dark:text-amber-400">待人工确认</span>
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

    <div class="mt-2 space-y-2.5">
      <div v-for="(q, i) in question.questions" :key="i" class="space-y-1">
        <p v-if="q.header" class="text-[11px] font-medium tracking-wide text-muted-foreground">
          {{ q.header }}<span v-if="q.multiSelect" class="ml-1 opacity-70">· 可多选</span>
        </p>
        <p class="text-sm font-medium leading-snug">{{ q.question }}</p>
        <ul v-if="q.options?.length" class="space-y-1">
          <li v-for="(o, oi) in q.options" :key="o.label" class="flex gap-1.5 text-xs text-muted-foreground">
            <span class="shrink-0 opacity-60">{{ oi + 1 }}.</span>
            <span class="min-w-0">
              <span class="text-foreground/80">{{ o.label }}</span>
              <span v-if="o.description" class="block text-[11px] opacity-70">{{ o.description }}</span>
            </span>
          </li>
        </ul>
        <p v-else class="text-xs text-muted-foreground">（自由填写）</p>
      </div>
    </div>

    <p class="mt-2 border-t border-amber-500/30 pt-2 text-[11px] text-muted-foreground">
      请回到 <span class="font-medium text-foreground/80">{{ nodeName }}</span> 的会话里作答 —— 控制台只做提示
    </p>
  </div>
</template>
