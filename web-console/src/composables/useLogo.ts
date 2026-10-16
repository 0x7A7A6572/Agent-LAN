const LOGOS: [string, string][] = [
  ['dsh', 'dsh.png'],
  ['deepseek', 'dsh.png'],
  ['claude', 'claude-code.png'],
  ['codex', 'codex.png'],
  ['grok', 'grok.png'],
  ['qoder', 'qoder.svg'],
  ['workbuddy', 'workbuddy.png'],
]

// 优先 agent 字段精确匹配（注册时自报的 agent 类型），退化到 name 模糊猜
export function logoOf(name: string, agent?: string): string | null {
  if (agent) {
    const a = agent.toLowerCase()
    const exact = LOGOS.find(([k]) => a === k)
    if (exact) return '/console/logos/' + exact[1]
  }
  const n = name.toLowerCase()
  const hit = LOGOS.find(([k]) => n.includes(k))
  return hit ? '/console/logos/' + hit[1] : null
}
