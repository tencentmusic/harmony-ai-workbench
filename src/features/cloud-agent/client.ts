export class RequestError extends Error {
  readonly status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}
export async function request<T>(url: string, init: RequestInit = {}, timeout = 20000): Promise<T> {
  const token = localStorage.getItem('hm_token') || ''
  const response = await fetch(`/api/cloud-agent${url}`, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout), cache: 'no-store', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers } })
  if (token !== (localStorage.getItem('hm_token') || '')) { window.dispatchEvent(new Event('cloud-agent-auth-invalid')); throw new DOMException('Session changed', 'AbortError') }
  if ([401, 403].includes(response.status)) window.dispatchEvent(new Event('cloud-agent-auth-invalid'))
  const result = await response.json()
  if (!response.ok) throw new RequestError(typeof result.error === 'string' ? result.error : '请求失败', response.status)
  return result as T
}
