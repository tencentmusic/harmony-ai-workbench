import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { prisma } from '@/lib/prisma'
import { CloudError, record } from './domain'
import { cloudRoot } from './git'
import { scopedPath } from './scoped-files'
import { acquireResource } from './resource-lock'
import { requireChildProcessesStopped, requireHarnessJournalSettled } from './process-recovery'
import { archiveArtifactStorage, listArtifactArchives, previewArtifactStorage, restoreArtifactStorage } from './artifact-storage'

const busyStatuses = ['queued', 'translation_queued', 'review_queued', 'delivery_queued', 'running', 'translating', 'reviewing', 'delivering', 'cancelling']
export const artifactMaintenanceLock = (id: string, owner: string, signal: AbortSignal) => acquireResource('artifact-maintenance', id, owner, signal)

function retentionDays(value = process.env.CLOUD_AGENT_ARTIFACT_RETENTION_DAYS ?? '7') {
  const days = Number(value)
  if (!Number.isSafeInteger(days) || days < 0 || days > 3650) throw new CloudError('产物保留天数须为 0 至 3650 的整数', 409)
  return days
}

async function taskState(id: string, days: number) {
  const task = await prisma.cloudAgentTask.findUniqueOrThrow({ where: { id }, include: {
    runs: { orderBy: { revision: 'asc' } }, approvals: { orderBy: { revision: 'asc' } },
  } })
  if (busyStatuses.includes(task.status) || task.runs.some(run => ['running', 'queued', 'recovery_required'].includes(run.status))) throw new CloudError('任务正在执行、已排队或仍待恢复，不能清理产物', 409)
  const workspace = record(record(JSON.parse(task.harnessJson)).workspace || {})
  if (typeof workspace.identity !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(workspace.identity) || typeof workspace.artifactRoot !== 'string' || typeof workspace.runDir !== 'string') throw new CloudError('任务未建立可管理的产物目录', 409)
  const expected = await scopedPath(cloudRoot(), `tasks/${workspace.identity}/artifacts`, ['tasks'])
  if ((await realpath(expected)).toLowerCase() !== (await realpath(workspace.artifactRoot)).toLowerCase() ||
    (await realpath(path.join(expected, 'harness'))).toLowerCase() !== (await realpath(workspace.runDir)).toLowerCase()) throw new CloudError('产物目录不属于当前受管任务，拒绝清理', 409)
  const input = { identity: workspace.identity, artifactRoot: expected, archiveRoot: path.join(path.dirname(expected), 'artifact-archive'), minimumAgeMs: days * 86400000,
    context: JSON.stringify({ taskId: task.id, revision: task.revision, status: task.status, materialVersion: task.materialVersion,
      material: task.material, harness: task.harnessJson, source: task.sourceSnapshot,
      runs: task.runs.map(run => ({ id: run.id, status: run.status, harness: run.harnessJson, output: run.output, input: run.input, material: run.materialSnapshot, attachments: run.attachmentSnapshot })), approvals: task.approvals }) }
  return { task, input, runDir: workspace.runDir }
}

export async function manageCloudArtifacts(command: 'preview' | 'archive' | 'list' | 'restore', id: string, value?: string, days?: string, stop?: AbortSignal) {
  const timeout = AbortSignal.timeout(10 * 60_000)
  const signal = stop ? AbortSignal.any([timeout, stop]) : timeout
  signal.throwIfAborted()
  const release = await artifactMaintenanceLock(id, `operator:${command}`, signal)
  try {
    const state = await taskState(id, retentionDays(days))
    const guard = async () => {
      signal.throwIfAborted()
      const current = await taskState(id, retentionDays(days))
      if (current.input.context !== state.input.context) throw new CloudError('归档期间任务已变化，停止处理；已有索引可恢复', 409)
      await requireChildProcessesStopped(state.input.artifactRoot)
      await requireHarnessJournalSettled(state.runDir)
    }
    await guard()
    if (command === 'list') return { taskId: id, archives: await listArtifactArchives(state.input) }
    if (command === 'preview') return { taskId: id, title: state.task.title, retentionDays: retentionDays(days), ...await previewArtifactStorage(state.input, signal) }
    if (!value) throw new CloudError('执行归档需要预览摘要，恢复需要归档编号', 409)
    const result = command === 'archive'
      ? await archiveArtifactStorage(state.input, value, signal, guard)
      : await restoreArtifactStorage(state.input, value, signal, guard)
    await prisma.cloudAgentEvent.create({ data: { taskId: id, kind: 'artifact-maintenance', message: JSON.stringify({ action: command, ...result }) } })
    return { taskId: id, ...result }
  } finally {
    // This operation starts no mutating subprocesses; awaited file work is fully settled here.
    await release(true)
  }
}

const checked = new Map<string, number>()
let nextSweep = 0
export async function maintainIdleCloudArtifacts(signal: AbortSignal) {
  if (process.env.CLOUD_AGENT_ARTIFACT_AUTO_ARCHIVE === '0' || signal.aborted || Date.now() < nextSweep) return
  nextSweep = Date.now() + 60_000
  const days = retentionDays()
  const tasks = await prisma.cloudAgentTask.findMany({ where: { status: { notIn: busyStatuses } }, orderBy: { updatedAt: 'asc' }, take: 100, select: { id: true, harnessJson: true } })
  const task = tasks.find(row => Date.now() >= (checked.get(row.id) || 0) && row.harnessJson.includes('"artifactRoot"'))
  if (!task) return
  checked.set(task.id, Date.now() + 24 * 60 * 60_000)
  try {
    const preview = await manageCloudArtifacts('preview', task.id, undefined, String(days), signal)
    if ('candidates' in preview && Array.isArray(preview.candidates) && preview.candidates.length && 'digest' in preview && typeof preview.digest === 'string' && !signal.aborted) {
      await manageCloudArtifacts('archive', task.id, preview.digest, String(days), signal)
    }
  } catch (error) {
    console.error(`[cloud-agent] artifact maintenance skipped for ${task.id}: ${error instanceof CloudError ? error.message : 'storage unavailable'}`)
  }
}
