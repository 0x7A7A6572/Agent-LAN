const LOGOS: [string, string][] = [
  ['dsh', 'dsh.png'],
  ['deepseek', 'dsh.png'],
  ['claude', 'claude-code.png'],
  ['codex', 'codex.png'],
  ['grok', 'grok.png'],
  ['qoder', 'qoder.svg'],
  ['workbuddy', 'workbuddy.png'],
]

// 按 agent 名字模糊匹配 logo，不命中返回空走文字徽章
export function logoOf(name: string): string | null {
  const n = name.toLowerCase()
  const hit = LOGOS.find(([k]) => n.includes(k))
  return hit ? '/console/logos/' + hit[1] : null
}
