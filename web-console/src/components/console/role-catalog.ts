// 角色外观：按角色名归一成固定色调与头像，保证同一个角色每次都长一样
// 不改角色数据，只决定颜色；职责文案由角色库自己维护

type AvatarMode = 'seed' | 'initial'

export type RoleVisual = {
  from: string
  to: string
  mode: AvatarMode
  glyph: string
}

// 命中顺序即优先级，越具体的越靠前
const RULES: { match: string[]; style: Omit<RoleVisual, 'glyph'> }[] = [
  { match: ['主理', 'lead', '负责'], style: { from: '#5b8cff', to: '#2b4bd8', mode: 'seed' } },
  { match: ['产品经理', 'pm'], style: { from: '#c9b6ff', to: '#7b5cf0', mode: 'initial' } },
  { match: ['需求', '选型', '架构', '分析', 'requirement'], style: { from: '#ffcf7a', to: '#f08a2c', mode: 'seed' } },
  { match: ['测试', 'qa', '质量', 'test'], style: { from: '#9ff0dd', to: '#2bb39a', mode: 'seed' } },
  { match: ['发布', '交付', 'release', 'deploy'], style: { from: '#ffb9c4', to: '#ef5d7e', mode: 'seed' } },
  { match: ['运维', '保障', 'ops', 'sre'], style: { from: '#9ed8f8', to: '#3a86d6', mode: 'seed' } },
  { match: ['增长', '运营', 'growth'], style: { from: '#ffae94', to: '#ec5f47', mode: 'seed' } },
  { match: ['文档', 'docs', 'docs'], style: { from: '#d8dbe3', to: '#8b90a0', mode: 'seed' } },
  { match: ['开发', '研发', '前端', '后端', '全栈', 'frontend', 'backend', 'dev', 'engineer'], style: { from: '#8fb8ff', to: '#3b6fe0', mode: 'seed' } },
]

const FALLBACK: RoleVisual = { from: '#a8a8b3', to: '#6b6b78', mode: 'initial', glyph: '' }

export function roleVisual(name: string): RoleVisual {
  const n = (name || '').trim().toLowerCase()
  for (const { match, style } of RULES) {
    if (match.some(k => n.includes(k))) return { ...style, glyph: '' }
  }
  return { ...FALLBACK, glyph: (name || '?').trim().slice(0, 1) || '?' }
}

// 中性表情：固定笑脸，只有底色随角色变
const SMILE = "<circle cx='24' cy='21' r='8.5' fill='#ffe9d4'/>"
  + "<circle cx='21' cy='20.5' r='1.1' fill='#3a2d28'/><circle cx='27' cy='20.5' r='1.1' fill='#3a2d28'/>"
  + "<path d='M21 24.6q3 2.2 6 0' stroke='#3a2d28' stroke-width='1.1' fill='none' stroke-linecap='round'/>"
  + "<path d='M14.5 18.2c0-6 4.6-9.6 9.5-9.6s9.5 3.6 9.5 9.6c-2.2-3-5.2-4.4-9.5-4.4s-7.3 1.4-9.5 4.4Z' fill='#2c2a35'/>"

function esc(s: string) {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return s.replace(/[&<>"']/g, c => map[c] ?? c)
}

// 头像：seed 用表情，initial 显示首字
export function faceSvg(v: RoleVisual, id: string): string {
  const gid = 'rg' + (id || 'x').replace(/[^a-zA-Z0-9]/g, '')
  const font = "'Geist','PingFang SC','Microsoft YaHei',sans-serif"
  const face = v.mode === 'seed'
    ? SMILE
    : '<text x="24" y="27" text-anchor="middle" font-size="16" font-weight="700" fill="#26232e" font-family="' + font + '">' + esc(v.glyph) + '</text>'
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">'
    + '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="1" y2="1">'
    + '<stop offset="0" stop-color="' + v.from + '"/><stop offset="1" stop-color="' + v.to + '"/></linearGradient></defs>'
    + '<rect width="48" height="48" rx="15" fill="url(#' + gid + ')"/>'
    + '<ellipse cx="24" cy="46" rx="15" ry="10" fill="#ffffff" fill-opacity=".5"/>'
    + face + '</svg>'
}

export function faceDataUrl(v: RoleVisual, id: string): string {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(faceSvg(v, id))
}
