import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'

import {
  buildOpencodeHeaders,
  type OpencodeConfig,
} from './opencode-config'
import {
  type ChatStreamEvent,
  createTranslatorState,
  parseSseLine,
  translateEvent,
} from './opencode-events'
import {
  isSafeOpencodeSessionPathSegment,
  isValidOpencodeSessionId,
  reconcileOpencodeSessionId,
} from './opencode-session'

export type StreamChatInput = {
  message: string
  attachments?: Array<{
    path: string
    name: string
    mime: string
    size: number
    dataUrl?: string
  }>
  sessionId?: string | null
  signal?: AbortSignal
  shouldCancel?: () => boolean
  cfg?: OpencodeConfig
}

export type DirectoryOpencodeErrorCode =
  | 'OPENCODE_DIRECTORY_INVALID'
  | 'OPENCODE_CONFIG_FAILED'
  | 'SESSION_CREATE_FAILED'
  | 'SSE_CONNECT_FAILED'
  | 'PROMPT_REJECTED'
  | 'PROMPT_ACCEPTANCE_UNKNOWN'
  | 'SESSION_STATUS_FAILED'
  | 'ABORT_FAILED'
  | 'SESSION_DELETE_FAILED'
  | 'INSTANCE_DISPOSE_FAILED'

export class DirectoryOpencodeError extends Error {
  readonly name = 'DirectoryOpencodeError'
  readonly code: DirectoryOpencodeErrorCode
  readonly status?: number

  constructor(
    code: DirectoryOpencodeErrorCode,
    message: string,
    options?: ErrorOptions & { status?: number },
  ) {
    super(message, options)
    this.code = code
    this.status = options?.status
  }
}

export interface DirectoryOpencodeClientInput {
  cfg?: OpencodeConfig
  directory: string
  fetchImpl?: typeof fetch
}

export interface DirectoryOpencodeRequestOptions {
  signal?: AbortSignal
}

export interface DirectoryOpencodePromptOptions extends DirectoryOpencodeRequestOptions {
  agent?: string
  tools?: Readonly<Record<string, boolean>>
}

export interface DirectoryOpencodeClient {
  readonly directory: string
  getConfig(options?: DirectoryOpencodeRequestOptions): Promise<unknown>
  createSession(options?: DirectoryOpencodeRequestOptions): Promise<string>
  openGlobalEventStream(options?: DirectoryOpencodeRequestOptions): Promise<Response>
  promptAsync(
    sessionId: string,
    prompt: string,
    options?: DirectoryOpencodePromptOptions,
  ): Promise<void>
  getSessionStatuses(options?: DirectoryOpencodeRequestOptions): Promise<unknown>
  abortSession(sessionId: string, options?: DirectoryOpencodeRequestOptions): Promise<boolean>
  deleteSession(sessionId: string, options?: DirectoryOpencodeRequestOptions): Promise<boolean>
  disposeInstance(options?: DirectoryOpencodeRequestOptions): Promise<boolean>
}

async function resolveOpencodeConfig(explicit?: OpencodeConfig): Promise<OpencodeConfig> {
  if (explicit) return explicit
  const { getOpencodeConfig } = await import('./opencode-config')
  return getOpencodeConfig()
}

async function resolveIntegrationOpencodeConfig(
  explicit?: OpencodeConfig,
): Promise<OpencodeConfig> {
  if (explicit) return explicit
  const { getIntegrationOpencodeConfig } = await import('./opencode-config')
  return getIntegrationOpencodeConfig()
}

async function resolveCanonicalDirectory(directory: string): Promise<string> {
  if (
    typeof directory !== 'string' ||
    !directory ||
    !path.isAbsolute(directory) ||
    path.resolve(directory) !== directory
  ) {
    throw new DirectoryOpencodeError(
      'OPENCODE_DIRECTORY_INVALID',
      'OpenCode directory 必须是规范化的绝对路径',
    )
  }

  try {
    const canonical = await realpath(directory)
    const directoryStat = await stat(canonical)
    if (!directoryStat.isDirectory()) throw new Error('not a directory')
    return canonical
  } catch (error) {
    throw new DirectoryOpencodeError(
      'OPENCODE_DIRECTORY_INVALID',
      'OpenCode directory 不存在或不是目录',
      { cause: error },
    )
  }
}

function directoryHeaders(
  cfg: OpencodeConfig,
  directory: string,
  headers?: HeadersInit,
): Headers {
  const result = buildOpencodeHeaders(cfg, headers)
  result.set('x-opencode-directory', directory)
  return result
}

function statusFailure(
  code: DirectoryOpencodeErrorCode,
  operation: string,
  response: Response,
): DirectoryOpencodeError {
  return new DirectoryOpencodeError(
    code,
    `${operation} failed with HTTP ${response.status}`,
    { status: response.status },
  )
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, 250)
    timer.unref?.()
  })
  await Promise.race([
    response.body.cancel().catch(() => {}),
    deadline,
  ])
  if (timer) clearTimeout(timer)
}

async function throwStatusFailure(
  code: DirectoryOpencodeErrorCode,
  operation: string,
  response: Response,
): Promise<never> {
  await cancelResponseBody(response)
  throw statusFailure(code, operation, response)
}

async function fetchUnknownJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch (error) {
    throw new DirectoryOpencodeError(
      'OPENCODE_CONFIG_FAILED',
      'OpenCode returned invalid JSON',
      { cause: error, status: response.status },
    )
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

async function withDirectoryRequestTimeout<T>(input: {
  cfg: OpencodeConfig
  signal?: AbortSignal
  code: DirectoryOpencodeErrorCode
  operation: string
  execute(signal: AbortSignal): Promise<T>
}): Promise<T> {
  if (input.signal?.aborted) throw abortReason(input.signal)

  const controller = new AbortController()
  let rejectBoundary: (reason: unknown) => void = () => {}
  const boundary = new Promise<never>((_, reject) => {
    rejectBoundary = reject
  })
  const abortFromCaller = () => {
    const reason = input.signal ? abortReason(input.signal) : undefined
    rejectBoundary(reason)
    controller.abort(reason)
  }
  input.signal?.addEventListener('abort', abortFromCaller, { once: true })

  const timeoutError = new DirectoryOpencodeError(
    input.code,
    `${input.operation} timed out after ${input.cfg.timeoutMs}ms`,
  )
  const timer = setTimeout(() => {
    rejectBoundary(timeoutError)
    controller.abort(timeoutError)
  }, input.cfg.timeoutMs)

  try {
    return await Promise.race([
      input.execute(controller.signal),
      boundary,
    ])
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', abortFromCaller)
  }
}

export async function createDirectoryOpencodeClient(
  input: DirectoryOpencodeClientInput,
): Promise<DirectoryOpencodeClient> {
  const cfg = await resolveIntegrationOpencodeConfig(input.cfg)
  const directory = await resolveCanonicalDirectory(input.directory)
  const fetchImpl = input.fetchImpl ?? fetch
  const url = (pathname: string) => `${cfg.baseUrl}${pathname}`

  return {
    directory,
    async getConfig(options = {}) {
      return withDirectoryRequestTimeout({
        cfg,
        signal: options.signal,
        code: 'OPENCODE_CONFIG_FAILED',
        operation: 'GET /config',
        execute: async (signal) => {
          const response = await fetchImpl(url('/config'), {
            method: 'GET',
            headers: directoryHeaders(cfg, directory),
            signal,
            cache: 'no-store',
          })
          if (!response.ok) {
            await throwStatusFailure('OPENCODE_CONFIG_FAILED', 'GET /config', response)
          }
          return fetchUnknownJson(response)
        },
      })
    },
    async createSession(options = {}) {
      return withDirectoryRequestTimeout({
        cfg,
        signal: options.signal,
        code: 'SESSION_CREATE_FAILED',
        operation: 'POST /session',
        execute: async (signal) => {
          const response = await fetchImpl(url('/session'), {
            method: 'POST',
            headers: directoryHeaders(cfg, directory, { 'Content-Type': 'application/json' }),
            body: '{}',
            signal,
          })
          if (!response.ok) {
            await throwStatusFailure('SESSION_CREATE_FAILED', 'POST /session', response)
          }
          let payload: unknown
          try {
            payload = await response.json()
          } catch (error) {
            throw new DirectoryOpencodeError(
              'SESSION_CREATE_FAILED',
              'POST /session returned invalid JSON',
              { cause: error, status: response.status },
            )
          }
          const id = payload && typeof payload === 'object'
            ? (payload as { id?: unknown }).id
            : undefined
          if (
            !isSafeOpencodeSessionPathSegment(id)
          ) {
            throw new DirectoryOpencodeError(
              'SESSION_CREATE_FAILED',
              'POST /session response is missing id',
              { status: response.status },
            )
          }
          return id
        },
      })
    },
    async openGlobalEventStream(options = {}) {
      const response = await fetchImpl(url('/global/event'), {
        method: 'GET',
        headers: directoryHeaders(cfg, directory, { Accept: 'text/event-stream' }),
        signal: options.signal,
        cache: 'no-store',
      })
      const contentType = response.headers.get('content-type') ?? ''
      if (
        !response.ok ||
        !response.body ||
        !contentType.toLowerCase().startsWith('text/event-stream')
      ) {
        await throwStatusFailure('SSE_CONNECT_FAILED', 'GET /global/event', response)
      }
      return response
    },
    async promptAsync(sessionId, prompt, options = {}) {
      if (!isSafeOpencodeSessionPathSegment(sessionId)) {
        throw new DirectoryOpencodeError(
          'SESSION_CREATE_FAILED',
          'OpenCode session id is not a safe path segment',
        )
      }
      return withDirectoryRequestTimeout({
        cfg,
        signal: options.signal,
        code: 'PROMPT_ACCEPTANCE_UNKNOWN',
        operation: 'POST /session/:id/prompt_async',
        execute: async (signal) => {
          let response: Response
          try {
            response = await fetchImpl(
              url(`/session/${encodeURIComponent(sessionId)}/prompt_async`),
              {
                method: 'POST',
                headers: directoryHeaders(cfg, directory, { 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                  ...(options.agent ? { agent: options.agent } : {}),
                  ...(options.tools ? { tools: options.tools } : {}),
                  parts: [{ type: 'text', text: prompt }],
                }),
                signal,
              },
            )
          } catch (error) {
            throw new DirectoryOpencodeError(
              'PROMPT_ACCEPTANCE_UNKNOWN',
              'POST prompt_async transport failed; prompt acceptance is unknown',
              { cause: error },
            )
          }
          if (response.status !== 204) {
            await cancelResponseBody(response)
            throw new DirectoryOpencodeError(
              'PROMPT_ACCEPTANCE_UNKNOWN',
              `POST prompt_async returned HTTP ${response.status}; prompt acceptance is unknown`,
              { status: response.status },
            )
          }
        },
      })
    },
    async getSessionStatuses(options = {}) {
      return withDirectoryRequestTimeout({
        cfg,
        signal: options.signal,
        code: 'SESSION_STATUS_FAILED',
        operation: 'GET /session/status',
        execute: async (signal) => {
          const response = await fetchImpl(url('/session/status'), {
            method: 'GET',
            headers: directoryHeaders(cfg, directory),
            signal,
            cache: 'no-store',
          })
          if (!response.ok) {
            await throwStatusFailure('SESSION_STATUS_FAILED', 'GET /session/status', response)
          }
          try {
            return await response.json()
          } catch (error) {
            throw new DirectoryOpencodeError(
              'SESSION_STATUS_FAILED',
              'GET /session/status returned invalid JSON',
              { cause: error, status: response.status },
            )
          }
        },
      })
    },
    async abortSession(sessionId, options = {}) {
      if (!isSafeOpencodeSessionPathSegment(sessionId)) {
        throw new DirectoryOpencodeError('ABORT_FAILED', 'OpenCode session id is invalid')
      }
      return withDirectoryRequestTimeout({
        cfg,
        signal: options.signal,
        code: 'ABORT_FAILED',
        operation: 'POST /session/:id/abort',
        execute: async (signal) => {
          const response = await fetchImpl(
            url(`/session/${encodeURIComponent(sessionId)}/abort`),
            {
              method: 'POST',
              headers: directoryHeaders(cfg, directory, { 'Content-Type': 'application/json' }),
              body: '{}',
              signal,
            },
          )
          if (!response.ok) {
            await throwStatusFailure('ABORT_FAILED', 'POST /session/:id/abort', response)
          }
          try {
            const value = await response.json()
            if (typeof value !== 'boolean') throw new Error('not a boolean')
            return value
          } catch (error) {
            throw new DirectoryOpencodeError(
              'ABORT_FAILED',
              'POST /session/:id/abort returned invalid JSON',
              { cause: error, status: response.status },
            )
          }
        },
      })
    },
    async deleteSession(sessionId, options = {}) {
      if (!isSafeOpencodeSessionPathSegment(sessionId)) {
        throw new DirectoryOpencodeError(
          'SESSION_DELETE_FAILED',
          'OpenCode session id is invalid',
        )
      }
      return withDirectoryRequestTimeout({
        cfg,
        signal: options.signal,
        code: 'SESSION_DELETE_FAILED',
        operation: 'DELETE /session/:id',
        execute: async (signal) => {
          const response = await fetchImpl(
            url(`/session/${encodeURIComponent(sessionId)}`),
            {
              method: 'DELETE',
              headers: directoryHeaders(cfg, directory),
              signal,
            },
          )
          if (!response.ok) {
            await throwStatusFailure(
              'SESSION_DELETE_FAILED',
              'DELETE /session/:id',
              response,
            )
          }
          try {
            const value = await response.json()
            if (typeof value !== 'boolean') throw new Error('not a boolean')
            return value
          } catch (error) {
            throw new DirectoryOpencodeError(
              'SESSION_DELETE_FAILED',
              'DELETE /session/:id returned invalid JSON',
              { cause: error, status: response.status },
            )
          }
        },
      })
    },
    async disposeInstance(options = {}) {
      return withDirectoryRequestTimeout({
        cfg,
        signal: options.signal,
        code: 'INSTANCE_DISPOSE_FAILED',
        operation: 'POST /instance/dispose',
        execute: async (signal) => {
          const response = await fetchImpl(url('/instance/dispose'), {
            method: 'POST',
            headers: directoryHeaders(cfg, directory, { 'Content-Type': 'application/json' }),
            body: '{}',
            signal,
          })
          if (!response.ok) {
            await throwStatusFailure(
              'INSTANCE_DISPOSE_FAILED',
              'POST /instance/dispose',
              response,
            )
          }
          try {
            const value = await response.json()
            if (typeof value !== 'boolean') throw new Error('not a boolean')
            return value
          } catch (error) {
            throw new DirectoryOpencodeError(
              'INSTANCE_DISPOSE_FAILED',
              'POST /instance/dispose returned invalid JSON',
              { cause: error, status: response.status },
            )
          }
        },
      })
    },
  }
}

export async function* streamChat(input: StreamChatInput): AsyncGenerator<ChatStreamEvent> {
  let cfg: OpencodeConfig
  try {
    cfg = await resolveOpencodeConfig(input.cfg)
  } catch (err) {
    if (
      err instanceof Error &&
      err.name === 'OpencodeConfigError' &&
      'code' in err &&
      typeof err.code === 'string'
    ) {
      yield { type: 'error', message: err.code }
      return
    }
    throw err
  }

  const cancelled = () => !!input.shouldCancel?.() || !!input.signal?.aborted
  const controller = new AbortController()
  let timedOut = false
  let sessionId = input.sessionId ?? null
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let translatorState: ReturnType<typeof createTranslatorState> | null = null
  const abortFromCaller = () => controller.abort(input.signal?.reason)
  input.signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('opencode_response_timeout'))
  }, cfg.timeoutMs)
  timer.unref?.()

  const abortRemoteSession = async () => {
    if (!sessionId || !isValidOpencodeSessionId(sessionId)) return
    try {
      await fetch(`${cfg.baseUrl}/session/${encodeURIComponent(sessionId)}/abort`, {
        method: 'POST',
        headers: buildOpencodeHeaders(cfg, { 'Content-Type': 'application/json' }),
        body: '{}',
        signal: AbortSignal.timeout(Math.min(5000, cfg.timeoutMs)),
      })
    } catch {
      // The local deadline must complete even when OpenCode cannot be reached.
    }
  }

  try {
    if (sessionId && !isValidOpencodeSessionId(sessionId)) {
      yield { type: 'error', message: 'invalid_session_id' }
      return
    }
    sessionId = await reconcileOpencodeSessionId(sessionId, cfg)
    if (!sessionId) {
      const sessionRes = await fetch(`${cfg.baseUrl}/session`, {
        method: 'POST',
        headers: buildOpencodeHeaders(cfg, { 'Content-Type': 'application/json' }),
        body: '{}',
        signal: controller.signal,
      })
      if (!sessionRes.ok) {
        let detail = ''
        try {
          const errBody = (await sessionRes.json()) as { name?: string; data?: { issues?: Array<{ message?: string }> } }
          const issues = errBody?.data?.issues?.map((i) => i.message).filter(Boolean)
          if (issues?.length) detail = `: ${issues.join('; ')}`
          else if (errBody?.name) detail = `: ${errBody.name}`
        } catch {
          // ignore parse errors
        }
        yield { type: 'error', message: `session_create_failed_${sessionRes.status}${detail}` }
        return
      }
      const session = (await sessionRes.json()) as { id?: string }
      if (!isValidOpencodeSessionId(session.id)) {
        yield { type: 'error', message: 'session_create_invalid_response' }
        return
      }
      sessionId = session.id
    }
    yield { type: 'session', sessionId }

    const eventRes = await fetch(`${cfg.baseUrl}/global/event`, {
      method: 'GET',
      headers: buildOpencodeHeaders(cfg, { Accept: 'text/event-stream' }),
      signal: controller.signal,
    })
    if (!eventRes.ok || !eventRes.body) {
      yield { type: 'error', message: `event_stream_failed_${eventRes.status}` }
      return
    }

    const promptRes = await fetch(
      `${cfg.baseUrl}/session/${encodeURIComponent(sessionId)}/prompt_async`,
      {
        method: 'POST',
        headers: buildOpencodeHeaders(cfg, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          parts: [
            ...(input.message.trim() ? [{ type: 'text', text: input.message }] : []),
            ...((input.attachments ?? []).map((item) => ({
              type: 'file',
              mime: item.mime,
              filename: item.name,
              url: item.dataUrl || `${item.path}`,
              ...(item.dataUrl
                ? {}
                : {
                    source: {
                      type: 'file',
                      path: item.path,
                    },
                  }),
            }))),
          ],
        }),
        signal: controller.signal,
      },
    )
    if (!promptRes.ok && promptRes.status !== 204) {
      yield { type: 'error', message: `prompt_failed_${promptRes.status}` }
      return
    }

    reader = eventRes.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    translatorState = createTranslatorState(sessionId)

    while (!translatorState.finished) {
      if (cancelled()) break
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const event = parseSseLine(line)
        if (!event) continue
        const result = translateEvent(translatorState, event)
        translatorState = result.state
        for (const e of result.emit) {
          yield e
        }
        if (translatorState.finished) break
      }
    }
    if (!translatorState.finished && !cancelled()) {
      await abortRemoteSession()
      yield { type: 'error', message: 'opencode_upstream_stream_interrupted' }
    }
  } catch (error) {
    if (cancelled() && !timedOut) return
    await abortRemoteSession()
    if (timedOut) {
      yield { type: 'error', message: 'opencode_response_timeout' }
      return
    }
    const message = error instanceof Error ? error.message : String(error || '')
    yield {
      type: 'error',
      message: /stream_read_error|upstream_error|fetch failed|terminated|ECONNRESET/i.test(message)
        ? 'opencode_upstream_stream_interrupted'
        : 'opencode_stream_interrupted',
    }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', abortFromCaller)
    await reader?.cancel().catch(() => {})
    if (!controller.signal.aborted) controller.abort()
  }
}
