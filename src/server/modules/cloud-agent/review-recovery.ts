import { randomBytes, randomUUID } from 'node:crypto'
import os from 'node:os'
import { prisma } from '@/lib/prisma'
import { CloudError, record } from './domain'
import { tokenCanAccessCloudApp } from './access'
import { requireChildProcessesStopped } from './process-recovery'
import { harnessUiOperationFacts, verifyHarness, type HarnessWorkspace } from './harness'
import { prepareNativeReview } from './harness-review'
import { assertUiReviewRecovery, assertUiReviewReconciliation } from './review-recovery-domain'
import { executeCloudRun } from './worker'

// Operator-only recovery: reuse the original decision and run revision, never create an approval.
export async function resumeCloudUiReview(id: string, mode: 'retry' | 'reconcile' = 'retry') {
  const run = await prisma.cloudAgentRun.findUnique({ where: { id }, include: { task: { include: { attachments: true } } } })
  if (!run || run.kind !== 'review' || run.status !== 'recovery_required') throw new CloudError('仅待恢复的UI审批运行允许恢复登记', 409)
  const task = run.task
  if (task.status !== 'blocked' || task.revision !== run.revision || task.materialVersion !== run.materialVersion) throw new CloudError('任务或材料已变化，不能沿用原批准', 409)
  if (Object.keys(record(JSON.parse(run.instanceJson))).length) throw new CloudError('审批运行存在额外实例，需先人工核验', 409)
  const saved = record(JSON.parse(task.harnessJson))
  const workspace = saved.workspace as HarnessWorkspace | undefined
  if (!workspace?.continuous || workspace.materialVersion !== task.materialVersion || !workspace.artifactRoot || !workspace.runDir) throw new CloudError('任务档案不完整或已过期', 409)
  await requireChildProcessesStopped(workspace.artifactRoot)
  const human = await prisma.cloudAgentApproval.findUnique({ where: { taskId_revision: { taskId: task.id, revision: run.revision - 1 } } })
  const approved = human ? record(JSON.parse(human.payload)) : null
  if (!human || human.decision !== 'ui' || approved?.kind !== 'ui' || approved.digest !== human.digest || record(saved.review || {}).digest !== human.digest) throw new CloudError('缺少当前版本的原始UI人工确认', 409)
  if (!await tokenCanAccessCloudApp(human.actorId, task.appId)) throw new CloudError('审批人授权已失效，必须重新审核', 403)
  const signal = AbortSignal.timeout(180000)
  const previous = record(saved.uiReviewRecovery || {})
  const previousOperationId = previous.runId === id && typeof previous.operationId === 'string' ? previous.operationId : `${human.id}-ui`
  const facts = await harnessUiOperationFacts(workspace, previousOperationId, signal)
  if (mode === 'reconcile') {
    if (previous.runId !== id || previous.approvalId !== human.id || previous.operationId !== previousOperationId) throw new CloudError('缺少原始恢复操作记录', 409)
    assertUiReviewReconciliation(facts, previousOperationId, { reference: `cloud-agent:${workspace.identity}:approval:${human.id}`,
      actorId: human.actorId, reason: human.reason, decision: String(approved!.decision) })
  } else {
    assertUiReviewRecovery(facts, previousOperationId)
    const checked = await verifyHarness(workspace, signal, 'scope_approved')
    if (!checked.raw.verified || checked.status.phase !== 'scope_approved') throw new CloudError('当前原生范围门禁已变化，不能恢复UI登记', 409)
    const current = await prepareNativeReview(workspace, checked.status, signal)
    if (!current || current.digest !== human.digest || current.materialVersion !== task.materialVersion) throw new CloudError('审核文件或材料摘要已变化，必须重新审核', 409)
  }
  const operationId = mode === 'reconcile' ? previousOperationId : `${human.id}-ui-recovery-${randomUUID()}`
  const harnessJson = JSON.stringify({ ...saved, uiReviewRecovery: { runId: id, approvalId: human.id, previousOperationId, operationId, mode,
    previousError: run.error, operator: os.userInfo().username, host: os.hostname(), requestedAt: new Date().toISOString() } })
  const claim = await prisma.$transaction(async tx => {
    const freshHuman = await tx.cloudAgentApproval.findUnique({ where: { id: human.id } })
    if (!freshHuman || freshHuman.payload !== human.payload || freshHuman.reason !== human.reason || freshHuman.actorId !== human.actorId || freshHuman.digest !== human.digest) throw new CloudError('人工确认已变化', 409)
    const updated = await tx.cloudAgentTask.updateMany({ where: { id: task.id, status: 'blocked', revision: run.revision, materialVersion: run.materialVersion, harnessJson: task.harnessJson }, data: { status: 'reviewing', stage: 'approval', harnessJson } })
    if (!updated.count) throw new CloudError('任务已变化或已被恢复', 409)
    const owned = await tx.cloudAgentRun.updateMany({ where: { id, status: 'recovery_required', leaseToken: run.leaseToken }, data: { status: 'running', leaseToken: randomBytes(24).toString('hex'), leaseUntil: new Date(Date.now() + 90000), finishedAt: null, error: null, harnessJson } })
    if (!owned.count) throw new CloudError('运行已被恢复', 409)
    await tx.cloudAgentEvent.create({ data: { taskId: task.id, runId: id, kind: 'review-recovery', message: `${mode === 'reconcile' ? '核对已落盘UI批准，补齐同一操作的完成凭据' : '已核验旧进程停止、原批准及材料摘要，恢复UI登记'}；原操作 ${previousOperationId}，恢复操作 ${operationId}。原失败记录保留：${run.error || ''}` } })
    return { task: await tx.cloudAgentTask.findUniqueOrThrow({ where: { id: task.id }, include: { attachments: true } }), run: await tx.cloudAgentRun.findUniqueOrThrow({ where: { id } }) }
  })
  await executeCloudRun(claim, signal)
  const result = await prisma.cloudAgentRun.findUniqueOrThrow({ where: { id }, select: { status: true, error: true } })
  if (result.status !== 'approved') throw new CloudError(`UI登记恢复未完成：${result.error || result.status}`, 409)
  return { recovered: id, approvalId: human.id, operationId, status: 'approved', next: 'translation_queued' }
}
