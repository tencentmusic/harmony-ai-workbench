import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { CloudError, CloudRecoveryError, record } from './domain'

export interface TaskTool { definition: Tool; call: (args: Record<string, unknown>) => Promise<CallToolResult> }
export const textResult = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] })
export function taskTool(name: string, description: string, properties: Record<string, object>, required: string[], call: TaskTool['call']): TaskTool {
  return { definition: { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } }, call }
}

async function waitForTurn(previous: Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted()
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new CloudError('排队请求已取消或等待超时，尚未执行；原运行中的操作不受影响', 409))
    signal.addEventListener('abort', abort, { once: true })
  })
  try { await Promise.race([previous, cancelled]) } finally { signal.removeEventListener('abort', abort) }
}

/** Each runtime owns an authenticated loopback endpoint, with serialized tool execution. */
export async function startTaskTools(tools: TaskTool[], signal: AbortSignal, onProgress: (message: string) => Promise<void>, timeout = 180000) {
  const secret = randomBytes(32).toString('hex')
  let calls = 0
  let busy = false
  let waiting = 0
  let tail = Promise.resolve()
  const queuedRequests = new Map<string | number, AbortController>()
  let operationDeadline = 0
  let recovery = false
  let closing = false
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${secret}` || req.headers.origin || req.url !== '/mcp') { res.writeHead(403).end(); return }
    if (signal.aborted) { res.writeHead(503).end(); return }
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    const disconnected = new AbortController()
    res.once('close', () => disconnected.abort())
    const mcp = new Server({ name: 'cloud-task', version: '1.0.0' }, { capabilities: { tools: {}, logging: {} } })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(tool => tool.definition) }))
    mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const tool = tools.find(item => item.definition.name === request.params.name)
      const rejected = !tool ? '工具名称不存在' : signal.aborted ? '任务已取消' : closing ? '工具服务正在收尾，不再接收新请求' : recovery ? '需运维恢复：先核验原操作的未决结果' : ++calls > 400 ? '本轮已达400次工具调用预算' : ''
      if (!tool || rejected) return { ...textResult(rejected), isError: true }
      if (queuedRequests.has(extra.requestId)) return { ...textResult('相同请求已在排队，未重复执行'), isError: true }
      const cancelled = new AbortController()
      queuedRequests.set(extra.requestId, cancelled)
      const previous = tail
      let release!: () => void
      const turn = new Promise<void>(resolve => { release = resolve })
      tail = previous.then(() => turn)
      waiting++
      let active = false
      // Keep the response readable while nested review/build work has no final result yet.
      const heartbeat = () => extra.sendNotification({ method: 'notifications/message', params: {
        level: 'debug', logger: 'cloud-task', data: { tool: tool.definition.name, status: active ? 'running' : 'queued' },
      } }).catch(() => {}) // A disconnected client does not cancel an already-started operation.
      const timer = setInterval(() => { void heartbeat() }, 15000)
      timer.unref()
      try {
        if (busy || waiting > 1) await heartbeat()
        await waitForTurn(previous, AbortSignal.any([signal, extra.signal, disconnected.signal, cancelled.signal, AbortSignal.timeout(timeout)]))
        signal.throwIfAborted()
        extra.signal.throwIfAborted()
        disconnected.signal.throwIfAborted()
        cancelled.signal.throwIfAborted()
        if (closing || recovery) throw new CloudError(recovery ? '原操作结果未决，排队请求未执行，需核验后恢复' : '工具服务正在收尾，排队请求未执行', 409)
        waiting--; active = true; busy = true
        queuedRequests.delete(extra.requestId)
        operationDeadline = Date.now() + timeout
        await heartbeat()
        await onProgress(`调用 ${tool.definition.name}`)
        const result = await tool.call(request.params.arguments || {})
        await onProgress(`完成 ${tool.definition.name}${result.isError ? '（需处理返回问题）' : ''}`)
        return result
      } catch (error) {
        if (error instanceof CloudRecoveryError) recovery = true
        const message = error instanceof CloudError ? error.message : '工具执行失败；请检查参数或环境，不得假定成功'
        await onProgress(`${tool.definition.name}：${message}`)
        return { ...textResult(message), isError: true }
      } finally { clearInterval(timer); if (active) busy = false; else waiting--; if (queuedRequests.get(extra.requestId) === cancelled) queuedRequests.delete(extra.requestId); release() }
    })
    try {
      let size = 0
      const chunks: Buffer[] = []
      for await (const chunk of req) { size += chunk.length; if (size > 20 * 1024 * 1024) { res.writeHead(413).end(); return }; chunks.push(chunk) }
      const input = record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      // Stateless HTTP delivers cancellation on a different transport from the original call.
      if (input.method === 'notifications/cancelled') {
        const params = record(input.params)
        if (typeof params.requestId !== 'string' && typeof params.requestId !== 'number') { res.writeHead(400).end(); return }
        queuedRequests.get(params.requestId)?.abort()
        res.writeHead(202).end()
        return
      }
      await mcp.connect(transport)
      res.on('close', () => { void mcp.close() })
      await transport.handleRequest(req, res, input)
    } catch { if (!res.headersSent) res.writeHead(400).end(); else res.end() }
  })
  server.requestTimeout = timeout
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new CloudError('任务工具端口不可用', 503)
  return { config: { type: 'remote' as const, url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: `Bearer ${secret}` }, oauth: false as const, timeout },
    busy: () => busy || waiting > 0,
    recovery: () => recovery,
    exhausted: () => calls >= 400,
    settle: async (waitMs = timeout) => {
      const deadline = Math.min(Date.now() + waitMs, operationDeadline || Infinity)
      signal.throwIfAborted()
      while ((busy || waiting > 0) && !recovery && Date.now() < deadline) await delay(Math.min(100, deadline - Date.now()), undefined, { signal })
      signal.throwIfAborted()
      return !busy && waiting === 0 && !recovery
    },
    drain: async (waitMs = timeout) => {
      closing = true
      const deadline = Date.now() + waitMs
      while ((busy || waiting > 0) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
      return !busy && waiting === 0 && !recovery
    },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}
