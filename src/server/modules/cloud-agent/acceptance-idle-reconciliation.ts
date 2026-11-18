import path from 'node:path'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { prisma } from '@/lib/prisma'
import { CloudError, record } from './domain'
import { invokeRuntime } from './native-runtime'
import { sha256 } from './scoped-files'
import { verifyHarness, type HarnessWorkspace } from './harness'
import { requireChildProcessesStopped, requireHarnessJournalSettled } from './process-recovery'

type Event = { id: number; runId: string | null; kind: string; message: string; at: number }
type Receipt = { startedAt: string; status: string }
const TOOL_SETTLEMENT_MS = 180_000

export function stoppedAcceptanceIntervals(events: Event[], receipts: Receipt[], attemptStart: number, attemptEnd: number) {
  if (!receipts.length) throw new CloudError('缺少 Harness 子进程收据，不能核减停机时间', 409)
  if (receipts.some(receipt => receipt.status !== 'stopped' || !Number.isFinite(Date.parse(receipt.startedAt)))) throw new CloudError('子进程收据未全部结算，不能核减停机时间', 409)
  const intervals: [number, number][] = []
  for (const [index, event] of events.entries()) {
    if (event.kind !== 'harness_waiting' || !event.runId) continue
    const resume = events.slice(index + 1).find(next => next.runId === event.runId && next.kind === 'resume_translation')
    if (!resume || resume.at <= event.at) continue
    if (events.slice(index + 1).some(next => next.at < resume.at && next.kind === 'tool')) continue
    const priorTools = events.slice(0, index).filter(next => next.runId === event.runId && next.kind === 'tool')
    const lastTool = priorTools.at(-1)
    const start = Math.max(attemptStart, event.at, lastTool ? lastTool.at + TOOL_SETTLEMENT_MS : event.at)
    const end = Math.min(attemptEnd, resume.at)
    if (start >= end) continue
    if (receipts.some(receipt => { const at = Date.parse(receipt.startedAt); return at >= start && at < end })) throw new CloudError('停机区间内有 Harness 子进程，不能核减', 409)
    intervals.push([start / 1000, end / 1000])
  }
  return intervals
}

export async function reconcileStoppedAcceptanceTime(taskId: string, attemptId: string) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(taskId) || !/^[A-Za-z0-9_-]{1,80}$/.test(attemptId)) throw new CloudError('任务或尝试 ID 非法')
  const task = await prisma.cloudAgentTask.findUnique({ where: { id: taskId } })
  if (!task || task.status !== 'harness_waiting') throw new CloudError('只允许核减已停止的 Harness 任务', 409)
  if (await prisma.cloudAgentRun.count({ where: { taskId, status: { in: ['running', 'recovery_required'] } } })) throw new CloudError('仍有运行或待恢复实例', 409)
  const savedWorkspace = record(record(JSON.parse(task.harnessJson)).workspace)
  if (typeof savedWorkspace.artifactRoot !== 'string' || typeof savedWorkspace.runDir !== 'string' ||
      !path.isAbsolute(savedWorkspace.artifactRoot) || !path.isAbsolute(savedWorkspace.runDir) ||
      path.relative(savedWorkspace.artifactRoot, savedWorkspace.runDir).startsWith('..')) throw new CloudError('任务档案路径非法', 409)
  const workspace = savedWorkspace as unknown as HarnessWorkspace
  await requireChildProcessesStopped(workspace.artifactRoot)
  await requireHarnessJournalSettled(workspace.runDir)
  const state = record(JSON.parse(await readFile(path.join(workspace.runDir, '.harness-runtime', 'acceptance.json'), 'utf8')))
  const nativeEvents = Array.isArray(state.events) ? state.events.map(record) : []
  const start = nativeEvents.find(event => event.operation_id === attemptId && record(event.payload).kind === 'start')
  const finish = nativeEvents.find(event => record(event.payload).kind === 'finish' && record(event.payload).attempt_id === attemptId)
  if (!start || !finish || record(start.payload).issue_id !== 'gate:visual' || record(finish.payload).issue_id !== 'gate:visual') throw new CloudError('仅允许核减已结算的视觉验收尝试', 409)
  if (nativeEvents.some(event => record(event.payload).kind === 'timing_reconciliation' && record(event.payload).attempt_id === attemptId)) return { alreadyReconciled: true }
  const attemptStart = Number(start.at) * 1000, attemptEnd = Number(finish.at) * 1000
  const rows = await prisma.cloudAgentEvent.findMany({ where: { taskId, createdAt: { gte: new Date(Math.floor(attemptStart)), lte: new Date(Math.ceil(attemptEnd)) } }, orderBy: { id: 'asc' }, select: { id: true, runId: true, kind: true, message: true, createdAt: true } })
  const events = rows.map(row => ({ id: row.id, runId: row.runId, kind: row.kind, message: row.message, at: row.createdAt.getTime() }))
  const processDir = path.join(workspace.artifactRoot, 'processes')
  const receipts = await Promise.all((await readdir(processDir)).filter(name => name.endsWith('.json')).map(async name => record(JSON.parse(await readFile(path.join(processDir, name), 'utf8')))))
  const intervals = stoppedAcceptanceIntervals(events, receipts as Receipt[], attemptStart, attemptEnd)
  if (!intervals.length) throw new CloudError('没有可核实的停机区间', 409)
  const evidence = { taskId, attemptId, nativeStart: start, nativeFinish: finish, events: rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() })), processReceipts: receipts, excludedIntervals: intervals }
  const contents = JSON.stringify(evidence)
  const digest = sha256(contents)
  const evidencePath = path.join(workspace.runDir, '.harness-runtime', `acceptance-idle-${digest.slice(0, 24)}.json`)
  await writeFile(evidencePath, contents, { flag: 'wx', mode: 0o600 }).catch(async error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(evidencePath, 'utf8') !== contents) throw error
  })
  const payload = { kind: 'timing_reconciliation', issue_id: 'gate:visual', attempt_id: attemptId,
    reason: 'Workbench stopped between execution batches; database stop/resume events and settled process receipts bound inactive intervals',
    excluded_intervals: intervals, evidence: [{ path: evidencePath, sha256: digest }] }
  const operationId = `reconcile-idle-${sha256(`${attemptId}:${JSON.stringify(intervals)}`).slice(0, 32)}`
  if (!await prisma.cloudAgentTask.count({ where: { id: taskId, status: 'harness_waiting' } }) ||
      await prisma.cloudAgentRun.count({ where: { taskId, status: { in: ['running', 'recovery_required'] } } })) throw new CloudError('任务状态已变化，停止计时核减', 409)
  const result = await invokeRuntime(workspace, 'acceptance', payload, operationId, AbortSignal.timeout(30000))
  const status = (await verifyHarness(workspace, AbortSignal.timeout(30000))).status
  return { operationId, intervals, evidence: { path: evidencePath, sha256: digest }, result, acceptance: status.acceptance }
}
