import type { FileInfo, NodeQuestion, Order, OrderAttachment, OrderDetail, PmConfigView, PmDecisionView, PmState, Presence, RoleDef } from '@/types/console'
import { rpc } from './rpc'

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  return (await res.json()) as T
}

export const fetchPresences = () =>
  getJson<{ presences: Presence[] }>('/console/presence/stream').catch(() => ({ presences: [] as Presence[] }))

// SSE 断了才用：一次性名册快照（含 waitingFor / question），给兜底轮询
export const fetchPresenceSnapshot = () =>
  getJson<{ presences: Presence[]; at: number }>('/console/presence')

export const fetchLogs = () => getJson<{ logs: string[] }>('/console/logs').catch(() => ({ logs: [] as string[] }))

export const clearLogs = () => fetch('/console/logs/clear', { method: 'POST' })

// 旧服务端只回字符串数组，这里统一成 { name, desc }
export const fetchRoles = () =>
  getJson<{ allowed?: (string | RoleDef)[] }>('/console/roles').then(d =>
    (d.allowed ?? []).map(r => (typeof r === 'string' ? { name: r, desc: '' } : { name: r.name, desc: r.desc ?? '' })),
  )

export const saveRoles = (roles: RoleDef[]) =>
  fetch('/console/roles/allowed', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roles }),
  }).then(r => r.json() as Promise<{ ok: boolean; allowed?: RoleDef[]; error?: string }>)

export const setNodeRole = (name: string, role: string) =>
  fetch('/console/roles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, role }),
  }).then(r => r.json() as Promise<{ ok: boolean; role?: string; error?: string }>)

export const fetchPmConfig = () =>
  getJson<PmConfigView>('/console/pm/config').catch(() => null)

export const savePmConfig = (patch: Partial<PmConfigView> & { apiKey?: string }) =>
  fetch('/console/pm/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  }).then(r => r.json() as Promise<{ ok: boolean; error?: string; config?: PmConfigView }>)

export const fetchPmWorkbuddy = () =>
  getJson<{ available: boolean; reason?: string; ready: boolean; models: string[] }>('/console/pm/workbuddy').catch(
    () => ({ available: false, reason: '探测失败', ready: false, models: [] as string[] }),
  )

/** 初始化 WorkBuddy 直连并拿模型列表（首次会解凭据，几秒） */
export const readyPmWorkbuddy = () =>
  fetch('/console/pm/workbuddy/ready', { method: 'POST' }).then(r =>
    r.json() as Promise<{ ok: boolean; models?: string[]; error?: string }>,
  )

export const probePmModel = () =>
  fetch('/console/pm/probe', { method: 'POST' }).then(r =>
    r.json() as Promise<{ ok: boolean; error?: string }>,
  )

export const setPmMode = (mode: 'human' | 'pm') =>
  fetch('/console/pm/mode', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  }).then(r => r.json() as Promise<{ ok: boolean; mode?: string; error?: string }>)

export const fetchPmPolicy = () =>
  getJson<{ policy: string }>('/console/pm/policy').catch(() => ({ policy: '' }))

export const savePmPolicy = (policy: string) =>
  fetch('/console/pm/policy', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ policy }),
  }).then(r => r.json() as Promise<{ ok: boolean; error?: string }>)

export const fetchPmFlows = () =>
  getJson<{ flows: string }>('/console/pm/flows').catch(() => ({ flows: '' }))

export const savePmFlows = (flows: string) =>
  fetch('/console/pm/flows', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ flows }),
  }).then(r => r.json() as Promise<{ ok: boolean; error?: string }>)

export const fetchPmDecisions = (limit = 20) =>
  getJson<{ decisions?: PmDecisionView[] }>('/console/pm/decisions?limit=' + limit).catch(() => ({ decisions: [] }))

export const fetchPmState = () =>
  getJson<PmState>('/console/pm/state').catch(() => ({ mode: 'human', enabled: false } as PmState))

export const fetchFiles = () =>
  getJson<{ files: FileInfo[] }>('/console/files').catch(() => ({ files: [] as FileInfo[] }))

export const openInExplorer = (name: string) =>
  fetch('/console/files/open/' + encodeURIComponent(name), { method: 'POST' }).then(
    r => r.json() as Promise<{ ok: boolean; error?: string }>,
  )

export const fetchOrders = () => getJson<{ orders?: Order[] }>('/console/orders')

export const fetchOrder = (id: string) => getJson<OrderDetail | { error: string }>('/console/orders/' + id)

export const createOrder = (body: { title: string; assignee?: string; priority: string }) =>
  fetch('/console/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json() as Promise<{ order?: Order; error?: string }>)

// patch 可附带 addAttachments / removeAttachments：附件不走字段更新，服务端单独处理
export const updateOrder = (
  id: string,
  patch: Partial<Order> & { addAttachments?: OrderAttachment[]; removeAttachments?: string[] },
) =>
  fetch('/console/orders/' + id + '/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  }).then(r => r.json() as Promise<{ order?: Order; error?: string }>)

export const deleteOrder = (id: string) =>
  fetch('/console/orders/' + id, { method: 'DELETE' }).then(r => r.json() as Promise<{ ok: boolean }>)

export const cancelOrder = (id: string) =>
  fetch('/console/orders/' + id + '/cancel', { method: 'POST' }).then(
    r => r.json() as Promise<{ ok: boolean; canceled?: string[]; error?: string }>,
  )

export const redispatchOrder = (id: string, assignee?: string) =>
  fetch('/console/orders/' + id + '/dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(assignee ? { assignee } : {}),
  }).then(r => r.json() as Promise<{ ok: boolean; error?: string }>)

export const deleteNode = (name: string) =>
  fetch('/console/nodes/' + encodeURIComponent(name), { method: 'DELETE' }).then(r =>
    r.json() as Promise<{ ok: boolean; error?: string }>,
  )

export const sendMail = (to: string, text: string) => rpc('mailbox/send', { to, text, from: 'human-console' })

/** 回答节点提问：choice 按题序号索引，other 是第一题的「其他」自由文本 */
export const answerQuestion = (name: string, choice: Record<string, string[]>, other?: string) =>
  fetch('/console/questions/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, choice, other, by: 'human-console' }),
  }).then(r => r.json() as Promise<{ ok: boolean; error?: string; question?: NodeQuestion }>)

export const dispatchTask = (target: string, prompt: string) => rpc('message/send', { prompt, target })
