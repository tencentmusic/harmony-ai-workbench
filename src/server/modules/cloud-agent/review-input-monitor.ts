import { CloudError } from './domain'

export class ReviewInputsChangedError extends CloudError {
  constructor() { super('审查输入被外部修改，本轮旧快照审查已停止；保留已生成问题，停止并发编辑后仅复核变化，不能沿用旧通过结论', 409) }
}

/** One bounded native inspection at a time, never overlapping or fire-and-forget. */
export function monitorReviewInputs(digest: string, inspect: () => Promise<string>, controller: AbortController, intervalMs = 30000) {
  let closed = false
  let error: unknown
  let pending: Promise<void> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    timer = setTimeout(() => {
      if (closed) return
      pending = (async () => {
        try {
          if (await inspect() !== digest) throw new ReviewInputsChangedError()
        } catch (cause) {
          error = cause instanceof Error ? cause : new CloudError('审查输入核验失败，不能继续沿用旧快照', 503)
          if (!closed) controller.abort(error)
        }
        if (!closed && !error) schedule()
      })()
    }, intervalMs)
  }
  schedule()
  return {
    get error() { return error },
    close: async () => { closed = true; clearTimeout(timer); await pending },
  }
}
