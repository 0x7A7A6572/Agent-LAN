import type { JsonRpcResponse } from '@/types/console'

// A2A JSON-RPC 入口：留言与派任务走同一个端点
export async function rpc<T = unknown>(method: string, params: unknown): Promise<JsonRpcResponse<T>> {
  const res = await fetch('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  })
  return (await res.json()) as JsonRpcResponse<T>
}
