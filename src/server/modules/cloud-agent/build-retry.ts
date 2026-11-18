import { open, readFile } from 'node:fs/promises'
import path from 'node:path'
import { CloudError, record } from './domain'
import { scopedPath, sha256, relativeToRoot } from './scoped-files'

export function buildExecutionId(requested: unknown, snapshot: unknown, config: unknown) {
  if (typeof requested !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(requested)) throw new CloudError('操作 ID 非法')
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value
  return `build-${sha256(JSON.stringify(canonical({ requested, snapshot, config }))).slice(0, 40)}`
}

export async function readExecutionLog(root: string, relative: unknown, offset?: number) {
  if (typeof relative !== 'string' || !/^execution\/[A-Za-z0-9_-]{1,100}\/(?:build|adapter)\.log$/.test(relative)) throw new CloudError('仅可读取当前任务 execution 下的构建或执行器日志', 403)
  const file = await scopedPath(root, relative, ['execution'])
  const handle = await open(file, 'r')
  try {
    const info = await handle.stat(), size = info.size
    if (!info.isFile()) throw new CloudError('日志不是普通文件')
    const start = offset === undefined ? Math.max(0, size - 24000) : offset
    if (!Number.isSafeInteger(start) || start < 0 || start > size) throw new CloudError('日志字节偏移非法')
    const bytes = Buffer.alloc(Math.min(24000, size - start))
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, start)
    // Rendering only: preserve the original evidence bytes and native log digest.
    const text = bytes.subarray(0, bytesRead).toString('utf8').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, value => value === '\0' ? '\\0' : `\\x${value.charCodeAt(0).toString(16).padStart(2, '0')}`)
    return { relativePath: relative, offset: start, size, bytesRead, text, nextOffset: start + bytesRead < size ? start + bytesRead : null, displayOnly: true }
  } finally { await handle.close() }
}

export function compilerDiagnostic(text: string) {
  const lines = text.split(/\r?\n/), chosen = new Set<number>()
  for (let i = 0; i < lines.length; i++) if (/\bERROR\b|Error Message:|At File:|BUILD FAILED|FAILURE:/i.test(lines[i])) {
    for (let j = i; j <= Math.min(i + 2, lines.length - 1); j++) chosen.add(j)
  }
  return (chosen.size ? [...chosen].sort((a, b) => a - b).map(i => lines[i]).join('\n') : /BUILD SUCCESSFUL/i.test(text) ? 'Hvigor 日志显示 BUILD SUCCESSFUL；未发现编译错误。' : '日志尾部未发现明确编译错误，请按原生错误诊断或分页读取日志。').slice(0, 2400)
}

export function buildFailureMessage(error: unknown, log: string, logPath: string) {
  const reason = error instanceof Error ? error.message : String(error)
  return `构建执行或产物登记未完成：${reason.slice(0, 2400)}\n${compilerDiagnostic(log)}\n日志：${logPath}。${/BUILD SUCCESSFUL/i.test(log) ? '不要根据 WARN 修改业务代码；先用 harness_build_context 核对产物根、原生失败原因及实际输出，再修复或更新对应依赖。' : '使用 harness_build_log 分页定位真实错误；源码修复后复审再构建。'}`
}

export function needsFreshPackageBuild(log: string) {
  return /UP-TO-DATE[^\r\n]*@SignH(?:ap|sp)/i.test(log) && /ENOENT[\s\S]{0,2500}[\\/][^\\/\r\n]*-signed\.(?:hap|hsp)/i.test(log)
}

export async function previousBuildFailure(workspace: { runDir: string; artifactRoot: string }) {
  const journal = await readFile(path.join(workspace.runDir, 'harness-events.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  const last = journal.split(/\r?\n/).filter(Boolean).map(line => record(JSON.parse(line))).filter(event => event.command === 'run-build' && ['failed', 'committed'].includes(String(event.status))).at(-1)
  if (last?.status === 'failed' && typeof last.error === 'string' && typeof last.operation_id === 'string' && /^[\w-]{1,100}$/.test(last.operation_id)) {
    const logPath = `execution/${last.operation_id}/build.log`
    const log = await readExecutionLog(workspace.artifactRoot, logPath).catch(() => null)
    return { status: 'failed', logPath, diagnostic: buildFailureMessage(new Error(last.error), log?.text || '', logPath), historical: true }
  }
  const verification = await readFile(path.join(workspace.runDir, 'verification-report.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (!verification) return null
  const build = record(record(JSON.parse(verification)).build || {})
  if (build.status !== 'failed') return null
  const evidence = record(build.evidence || {})
  if (typeof evidence.path !== 'string') return { status: 'failed', diagnostic: '旧构建没有可读日志引用，需核对原生收据' }
  const relative = await relativeToRoot(workspace.artifactRoot, evidence.path)
  const log = await readExecutionLog(workspace.artifactRoot, relative)
  return { status: 'failed', logPath: relative, diagnostic: buildFailureMessage(new Error(String(build.failure_reason || '原生构建未通过')), log.text, relative), historical: true }
}
