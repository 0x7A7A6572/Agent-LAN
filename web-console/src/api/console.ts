import type { FileInfo, Order, OrderAttachment, OrderDetail, Presence } from '@/types/console'
import { rpc } from './rpc'

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  return (await res.json()) as T
}

export const fetchPresences = () =>
  getJson<{ presences: Presence[] }>('/console/presence/stream').catch(() => ({ presences: [] as Presence[] }))

export const fetchLogs = () => getJson<{ logs: string[] }>('/console/logs').catch(() => ({ logs: [] as string[] }))

export const clearLogs = () => fetch('/console/logs/clear', { method: 'POST' })

export const fetchRoles = () => getJson<{ allowed?: string[] }>('/console/roles').then(d => d.allowed ?? [])

export const saveRoles = (roles: string[]) =>
  fetch('/console/roles/allowed', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roles }),
  }).then(r => r.json() as Promise<{ ok: boolean; allowed?: string[]; error?: string }>)

export const setNodeRole = (name: string, role: string) =>
  fetch('/console/roles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, role }),
  }).then(r => r.json() as Promise<{ ok: boolean; role?: string; error?: string }>)

export const fetchPmDoc = async () => {
  const res = await fetch('/console/pm')
  if (!res.ok) throw new Error('读取失败')
  return res.text()
}

export const savePmDoc = (text: string) =>
  fetch('/console/pm', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: text }).then(r =>
    r.json() as Promise<{ ok: boolean; error?: string }>,
  )

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

export const dispatchTask = (target: string, prompt: string) => rpc('message/send', { prompt, target })
