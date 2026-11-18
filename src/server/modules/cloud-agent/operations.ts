import os from 'node:os'
import { prisma } from '@/lib/prisma'
import { CloudError, record } from './domain'
import { requireChildProcessesStopped, confirmStoppedReceipt, requireHarnessJournalSettled } from './process-recovery'

export async function inspectCloudOperations() {
  return {
    delivery: await prisma.cloudAgentDeliveryWatch.findMany({ where: { error: { not: null } }, take: 50, orderBy: { updatedAt: 'desc' }, select: { taskId: true, failures: true, error: true, nextAttempt: true } }),
    notifications: await prisma.cloudAgentNotification.findMany({ where: { OR: [{ status: 'failed' }, { error: { not: null }, status: 'queued' }] }, take: 50, orderBy: { createdAt: 'desc' }, select: { id: true, taskId: true, status: true, attempts: true, error: true, nextAttempt: true } }),
    inbox: await prisma.cloudAgentInbox.findMany({ where: { status: { in: ['blocked', 'queued', 'running'] } }, take: 50, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, error: true, attempts: true, createdAt: true } }),
    recovery: await prisma.cloudAgentRun.findMany({ where: { status: 'recovery_required' }, select: { id: true, taskId: true, error: true, leaseUntil: true }, take: 50 }),
  }
}
export async function confirmCloudChildStopped(id: string, relative: string, hash: string, reason: string) {
  const run = await prisma.cloudAgentRun.findUnique({ where: { id } })
  if (!run || run.status !== 'recovery_required') throw new CloudError('仅待恢复运行允许人工核验')
  const workspace = record(record(JSON.parse(run.harnessJson)).workspace || {})
  if (typeof workspace.artifactRoot !== 'string') throw new CloudError('缺少任务档案路径')
  const result = await confirmStoppedReceipt(workspace.artifactRoot, relative, hash, reason)
  await prisma.cloudAgentEvent.create({ data: { taskId: run.taskId, runId: id, kind: 'recovery-confirmed', message: `运维已核验子进程树：${relative}；${reason}` } })
  return result
}
// Local operator command only; never terminate a process using a stale PID.
export async function recoverStoppedCloudRun(id: string) {
  const run = await prisma.cloudAgentRun.findUnique({ where: { id } })
  if (!run || run.status !== 'recovery_required') throw new CloudError('运行不处于待恢复状态')
  const receipt = record(JSON.parse(run.instanceJson))
  const workspace = record(record(JSON.parse(run.harnessJson)).workspace || {})
  if (typeof workspace.artifactRoot === 'string') await requireChildProcessesStopped(workspace.artifactRoot)
  if (typeof workspace.runDir === 'string') await requireHarnessJournalSettled(workspace.runDir)
  if (Object.keys(receipt).length) {
    if (receipt.host !== os.hostname() || !Number.isSafeInteger(receipt.pid) || Number(receipt.pid) <= 0) throw new CloudError('实例归属无法确认，需人工检查')
    try { process.kill(Number(receipt.pid), 0); throw new CloudError('旧实例 PID 仍存在，不能恢复；请核实实例身份并停止后再执行') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  await prisma.$transaction(async tx => {
    const update = await tx.cloudAgentRun.updateMany({ where: { id, status: 'recovery_required' }, data: { status: 'failed', error: run.kind === 'translation' ? '运行记录已恢复，可在原特性分支继续 Harness，无需重新审批需求' : '运行记录已恢复，可继续执行', finishedAt: new Date() } })
    if (!update.count) throw new CloudError('运行状态已变化', 409)
    await tx.cloudAgentEvent.create({ data: { taskId: run.taskId, runId: id, kind: 'recovered', message: `运维已核验旧进程停止及原生日志，保留特性分支、材料和审批。原中断原因：${run.error || '未记录'}` } })
  })
  return { recovered: id }
}
export async function retryCloudInbox(id: string) {
  const update = await prisma.cloudAgentInbox.updateMany({ where: { id, status: 'blocked' }, data: { status: 'queued', attempts: 0, nextAttempt: new Date(), leaseToken: null, leaseUntil: null } })
  if (!update.count) throw new CloudError('收件记录不处于阻塞状态')
  return { requeued: id }
}

export async function retryCloudNotification(id: string) {
  const updated = await prisma.cloudAgentNotification.updateMany({ where: { id, status: 'failed' }, data: { status: 'queued', attempts: 0, error: null, nextAttempt: new Date(), leaseToken: null, leaseUntil: null } })
  if (!updated.count) throw new CloudError('通知不处于发送失败状态')
  return { requeued: id }
}
