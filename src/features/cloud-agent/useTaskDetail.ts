import { useCallback, useEffect, useRef, useState } from 'react'
import type { CloudTask } from '@/contracts/cloud-agent'
import { request, RequestError } from './client'
import { TaskCache } from './task-cache'

export function useTaskDetail(selected: string, active: boolean) {
  const [cache] = useState(() => new TaskCache<CloudTask>())
  const [stored, setStored] = useState<CloudTask | null>(null)
  const [failure, setFailure] = useState({ id: '', message: '' })
  const [validated, setValidated] = useState('')
  const current = useRef({ selected, active })
  current.current = { selected, active }
  const clear = useCallback(() => { cache.clear(); setStored(null); setValidated(''); setFailure({ id: '', message: '' }) }, [cache])
  const accept = useCallback((task: CloudTask) => {
    const value = cache.put(task)
    if (current.current.selected === task.id) { setStored(value); setValidated(task.id); setFailure({ id: '', message: '' }) }
  }, [cache])
  const refresh = useCallback(async () => {
    const { selected: id, active: enabled } = current.current
    if (!id || !enabled) return
    try {
      const value = await cache.load(id, async signal => (await request<{ item: CloudTask }>(`/tasks/${encodeURIComponent(id)}`, { signal })).item)
      if (current.current.selected === id && current.current.active) accept(value)
    } catch (error) {
      if (current.current.selected !== id || !current.current.active || (error as Error).name === 'AbortError' || (error as Error).message === 'Task request discarded') return
      if (error instanceof RequestError && [401, 403, 404].includes(error.status)) { cache.clear(); setStored(null) }
      setValidated(''); setFailure({ id, message: (error as Error).message })
    }
  }, [cache, accept])
  useEffect(() => {
    setValidated(''); setFailure({ id: '', message: '' })
    setStored(cache.get(selected) || null)
    if (active) void refresh()
  }, [selected, active, cache, refresh])
  useEffect(() => () => cache.clear(), [cache])
  return { detail: stored?.id === selected ? stored : null, error: failure.id === selected ? failure.message : '',
    ready: active && validated === selected && !!selected, refresh, accept, clear }
}
