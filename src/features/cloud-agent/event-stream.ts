import type { CloudEvent } from '@/contracts/cloud-agent'

export async function subscribeCloudEvents(path: string, signal: AbortSignal, onEvent: (event: CloudEvent) => void, onReady: () => void, onConnection?: (connected: boolean) => void, after?: number) {
  let cursor: number | undefined = after
  while (!signal.aborted) {
    try {
      const response = await fetch(`/api/cloud-agent${path}${cursor === undefined ? '' : `?after=${cursor}`}`, {
        headers: { authorization: `Bearer ${localStorage.getItem('hm_token') || ''}` }, cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(70000)]),
      })
      if (!response.ok || !response.body) { if ([401, 403, 404].includes(response.status)) { onConnection?.(false); window.dispatchEvent(new Event('cloud-agent-auth-invalid')); return }; throw new Error('stream') }
      const reader = response.body.getReader(), decoder = new TextDecoder()
      let buffer = ''
      try {
        while (!signal.aborted) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let end: number
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
            if (frame.includes('event: auth-or-stream-error')) { onReady(); throw new Error('stream') }
            const line = frame.split('\n').find(item => item.startsWith('data: '))
            if (!line) continue
            const data = JSON.parse(line.slice(6))
            if (frame.includes('event: ready')) { cursor = Number(data.cursor) || 0; onConnection?.(true); onReady(); continue }
            if (Number.isSafeInteger(data.id) && data.id > (cursor || 0)) { cursor = data.id; if (!signal.aborted) onEvent(data as CloudEvent) }
          }
          if (buffer.length > 100000) throw new Error('stream-size')
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    } catch { if (signal.aborted) return }
    finally { onConnection?.(false) }
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
      const timer = setTimeout(done, 1500)
      signal.addEventListener('abort', done, { once: true })
    })
  }
}
