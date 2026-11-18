import { prisma } from '@/lib/prisma'
import { CloudError, CloudRecoveryError } from './domain'
import { claimCloudRun, finishCloudRun } from './store'
import { processCloudInbox } from './webhook'
import { cleanupStagedMaterials } from './materials'
import { runTranslation } from './translation'
import { runDelivery } from './delivery'
import { scheduleCloudDelivery, deferDeliveryRun, resetDeliveryRetry } from './delivery-automation'
import { collectCloudNotifications, dispatchCloudNotification } from './notifications'
import { tokenCanAccessCloudApp } from './access'
import { maintainIdleCloudArtifacts } from './artifact-maintenance'

export async function executeCloudRun(claim: NonNullable<Awaited<ReturnType<typeof claimCloudRun>>>, stop: AbortSignal) {
  const { task, run } = claim
  const controller = new AbortController()
  const signal = AbortSignal.any([stop, controller.signal])
  let heartbeatBusy = false
  const checkLease = async () => {
    const current = await prisma.cloudAgentTask.findUnique({ where: { id: task.id } })
    const expected = run.kind === 'delivery' ? 'delivering' : run.kind === 'translation' ? 'translating' : run.kind === 'review' ? 'reviewing' : 'running'
    if (!current || current.status !== expected || current.revision !== run.revision || current.materialVersion !== run.materialVersion) { controller.abort(); return }
    if (task.creatorId) {
      if (!await tokenCanAccessCloudApp(task.creatorId, task.appId)) { controller.abort(); return }
    }
    const update = await prisma.cloudAgentRun.updateMany({ where: { id: run.id, status: 'running', leaseToken: run.leaseToken, leaseUntil: { gt: new Date() } }, data: { leaseUntil: new Date(Date.now() + 90_000) } })
    if (!update.count) controller.abort()
  }
  const heartbeat = setInterval(() => {
    if (heartbeatBusy) return
    heartbeatBusy = true
    void checkLease().catch(() => controller.abort()).finally(() => { heartbeatBusy = false })
  }, 5000)
  try {
    await checkLease(); signal.throwIfAborted()
    if (run.kind === 'delivery') { await runDelivery(claim, signal, checkLease); await resetDeliveryRetry(task.id) }
    else await runTranslation(claim, signal, checkLease)
  } catch (error) {
    if (run.kind === 'delivery' && await deferDeliveryRun(claim, error, signal)) return
    const message = error instanceof CloudError ? error.message : signal.aborted ? '运行已中止，已保留本轮材料与档案' : '流程执行失败，请检查运行环境后继续'
    await finishCloudRun(run.id, run.leaseToken, error instanceof CloudRecoveryError ? 'recovery_required' : run.kind === 'translation' && !signal.aborted ? 'harness_waiting' : signal.aborted ? 'failed' : error instanceof CloudError && error.status === 503 ? 'blocked' : 'failed', '', message)
  } finally { clearInterval(heartbeat) }
}
export async function recoverCloudLeases() {
  const expired = await prisma.cloudAgentRun.findMany({ where: { status: 'running', leaseUntil: { lt: new Date() } } })
  for (const run of expired) await prisma.$transaction(async tx => {
    const update = await tx.cloudAgentRun.updateMany({ where: { id: run.id, status: 'running', leaseUntil: { lt: new Date() } }, data: { status: 'recovery_required', error: '执行租约过期；需确认旧实例停止后恢复，未自动重放' } })
    if (!update.count) return
    await tx.cloudAgentTask.updateMany({ where: { id: run.taskId, status: { in: ['running', 'translating', 'reviewing', 'delivering', 'cancelling'] } }, data: { status: run.kind === 'translation' ? 'harness_waiting' : 'blocked' } })
    await tx.cloudAgentEvent.create({ data: { taskId: run.taskId, runId: run.id, kind: 'blocked', message: '执行租约过期，需要确认旧实例状态；禁止自动重试' } })
  })
  await prisma.cloudAgentInbox.updateMany({ where: { status: 'running', leaseUntil: { lt: new Date() } }, data: { status: 'queued', leaseToken: null } })
}
export async function runCloudWorker(signal: AbortSignal) {
  const active = new Set<Promise<void>>()
  let notificationWork: Promise<void> | undefined
  let deliveryWork: Promise<void> | undefined
  let artifactWork: Promise<void> | undefined
  const limit = Math.max(1, Math.min(2, Number(process.env.CLOUD_AGENT_CONCURRENCY) || 2))
  while (!signal.aborted) {
    try {
      await recoverCloudLeases()
      await cleanupStagedMaterials()
      await processCloudInbox()
      if (!artifactWork) artifactWork = maintainIdleCloudArtifacts(signal).catch(() => { console.error('[cloud-agent] artifact maintenance unavailable; normal queue continues') }).finally(() => { artifactWork = undefined })
      if (!deliveryWork) deliveryWork = scheduleCloudDelivery(signal).catch(() => { if (!signal.aborted) console.error('[cloud-agent] delivery watcher unavailable') }).finally(() => { deliveryWork = undefined })
      if (!notificationWork) notificationWork = collectCloudNotifications().then(() => dispatchCloudNotification(signal)).catch(() => { console.error('[cloud-agent] notification queue unavailable') }).finally(() => { notificationWork = undefined })
      while (active.size < limit && !signal.aborted) {
        const claim = await claimCloudRun()
        if (!claim) break
        const promise = executeCloudRun(claim, signal).catch(() => { console.error('[cloud-agent] run persistence failed; lease recovery required') }).finally(() => active.delete(promise))
        active.add(promise)
      }
    } catch { console.error('[cloud-agent] queue unavailable; retrying without starting duplicate work') }
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  await Promise.allSettled(active)
  if (notificationWork) await notificationWork
  if (deliveryWork) await deliveryWork
  if (artifactWork) await artifactWork
}
