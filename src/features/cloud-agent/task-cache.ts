type VersionedTask = { id: string; revision: number; updatedAt: string }

// Owned by the mounted page, never shared across users or persisted to browser storage.
export class TaskCache<T extends VersionedTask> {
  private values = new Map<string, T>()
  private pending = new Map<string, { promise: Promise<T>; abort: AbortController }>()
  private limit: number
  constructor(limit = 12) { this.limit = limit }
  get(id: string) {
    const value = this.values.get(id)
    if (value) { this.values.delete(id); this.values.set(id, value) }
    return value
  }
  put(value: T): T {
    const previous = this.values.get(value.id)
    if (previous && (previous.revision > value.revision || previous.revision === value.revision && previous.updatedAt > value.updatedAt)) return previous
    this.values.delete(value.id); this.values.set(value.id, value)
    while (this.values.size > this.limit) this.values.delete(this.values.keys().next().value!)
    return value
  }
  load(id: string, loader: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const existing = this.pending.get(id)
    if (existing) return existing.promise
    const abort = new AbortController()
    const promise = loader(abort.signal).then(value => {
      if (abort.signal.aborted) throw new Error('Task request discarded')
      return this.put(value)
    }).finally(() => { if (this.pending.get(id)?.promise === promise) this.pending.delete(id) })
    this.pending.set(id, { promise, abort })
    return promise
  }
  delete(id: string) { this.pending.get(id)?.abort.abort(); this.pending.delete(id); this.values.delete(id) }
  clear() { for (const item of this.pending.values()) item.abort.abort(); this.pending.clear(); this.values.clear() }
}
