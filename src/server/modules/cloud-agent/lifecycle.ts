import { prisma } from '@/lib/prisma'
import { executionLifecycle, type CloudExecutionLifecycle, type CloudHarness, type CloudStageId } from '@/contracts/cloud-agent'

type Row = { id: string; status: string; stage: string; materialVersion: number; harnessJson: string }
const executing = new Set(['translation_queued', 'translating', 'harness_waiting', 'code_ready', 'cancelled', 'cancelling', 'failed', 'blocked', 'reviewing', 'review_queued', 'awaiting_approval'])
const legacyStages = [['当前执行：代码审查。', 'review'], ['当前执行：构建验证。', 'build'], ['当前执行：设备验收。', 'device']] as const

export function legacyLifecycle(status: CloudHarness, version: number, messages: string[], checkpoint?: string) {
  let lifecycle = executionLifecycle(status, version, undefined, checkpoint)
  for (const message of messages) {
    const stage = legacyStages.find(([prefix]) => message.startsWith(prefix))?.[1]
    if (!stage) continue
    lifecycle = executionLifecycle(status, version, lifecycle, stage)
    lifecycle.passedNodes = [...new Set([...lifecycle.passedNodes, 'implemented', 'wired', ...(stage === 'device' ? ['build_passed'] : [])])]
    if (stage === 'build' || stage === 'device') lifecycle.reviewPassed = true
  }
  return lifecycle
}

// Batch legacy recovery keeps list/detail consistent without touching active Worker state.
export async function taskLifecycles(rows: Row[]): Promise<Map<string, CloudExecutionLifecycle>> {
  const result = new Map<string, CloudExecutionLifecycle>()
  const legacy: { row: Row; status: CloudHarness }[] = []
  for (const row of rows) {
    const saved = JSON.parse(row.harnessJson)
    if (!executing.has(row.status) || !['coding', 'review', 'build', 'device'].includes(row.stage) || !saved.status || saved.workspace?.materialVersion !== row.materialVersion) continue
    if (saved.status.lifecycle?.materialVersion === row.materialVersion) result.set(row.id, executionLifecycle(saved.status, row.materialVersion, saved.status.lifecycle, row.stage))
    else legacy.push({ row, status: saved.status })
  }
  if (!legacy.length) return result
  const runs = await prisma.cloudAgentRun.findMany({ where: { OR: legacy.map(({ row }) => ({ taskId: row.id, materialVersion: row.materialVersion })) }, select: { id: true, taskId: true, revision: true, kind: true }, orderBy: { revision: 'desc' } })
  const eligible = legacy.flatMap(({ row }) => {
    const owned = runs.filter(run => run.taskId === row.id)
    const reset = owned.find(run => run.kind === 'analysis' || run.kind === 'delivery')?.revision || 0
    return owned.filter(run => run.revision > reset && ['translation', 'review'].includes(run.kind))
  })
  const events = eligible.length ? await prisma.cloudAgentEvent.findMany({ where: { runId: { in: eligible.map(run => run.id) }, kind: 'stage', OR: legacyStages.map(([prefix]) => ({ message: { startsWith: prefix } })) }, select: { taskId: true, message: true } }) : []
  for (const { row, status } of legacy) {
    if (!eligible.some(run => run.taskId === row.id)) continue
    result.set(row.id, legacyLifecycle(status, row.materialVersion, events.filter(event => event.taskId === row.id).map(event => event.message), row.stage))
  }
  return result
}

export function displayedStage(row: { status: string; stage: string }, lifecycle?: CloudExecutionLifecycle): CloudStageId | undefined {
  if (row.status === 'awaiting_approval' || row.status === 'review_queued' || row.status === 'reviewing') return row.stage as CloudStageId || undefined
  return lifecycle?.stage || row.stage as CloudStageId || undefined
}
