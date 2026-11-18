import { randomBytes } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { loadWorkspaceAppsConfig } from '@/lib/workspace-apps-config'
import { CloudError, record } from './domain'
import { readBoundedJson } from './response'
import { notificationPayload, notificationRecipient, notificationState, notificationStatuses, validateWecomWebhook } from './notification-domain'
import { handoffsFor } from './delivery-handoff'

let scanCursor: string | undefined
export async function collectCloudNotifications() {
  if (!process.env.CLOUD_AGENT_WECOM_WEBHOOK) return
  const tasks = await prisma.cloudAgentTask.findMany({ where: { status: { in: notificationStatuses } }, orderBy: { id: 'asc' }, take: 100,
    ...(scanCursor ? { cursor: { id: scanCursor }, skip: 1 } : {}) })
  scanCursor = tasks.length === 100 ? tasks.at(-1)!.id : undefined
  const handoffs = await handoffsFor(tasks)
  for (const task of tasks) {
    const state = notificationState({ ...task, handoffStatus: handoffs.get(task.id)?.status })
    if (!state) continue
    const identity = `${task.id}:${state.key}`
    await prisma.cloudAgentNotification.upsert({ where: { identity }, create: { identity, taskId: task.id, stateKey: state.key }, update: {} })
    // Polling can briefly leave a waiting state; revive only unsent obsolete notices, never sent ones.
    await prisma.cloudAgentNotification.updateMany({ where: { identity, status: 'obsolete' }, data: { status: 'queued', nextAttempt: new Date() } })
  }
}
export async function sendWecom(payload: ReturnType<typeof notificationPayload>, signal: AbortSignal, send = fetch) {
  const url = validateWecomWebhook(process.env.CLOUD_AGENT_WECOM_WEBHOOK || '')
  const response = await send(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) })
  if (!response.ok) throw new CloudError(`企业微信 HTTP ${response.status}`, 503)
  const body = record(await readBoundedJson(response, 16000))
  if (body.errcode !== 0) throw new CloudError(`企业微信发送失败，错误码 ${typeof body.errcode === 'number' ? body.errcode : 'unknown'}`, 503)
}
export async function dispatchCloudNotification(signal: AbortSignal, send = sendWecom) {
  if (!process.env.CLOUD_AGENT_WECOM_WEBHOOK || signal.aborted) return
  const now = new Date(), leaseToken = randomBytes(24).toString('hex')
  await prisma.cloudAgentNotification.updateMany({ where: { status: 'sending', leaseUntil: { lt: now } }, data: { status: 'queued', leaseToken: null } })
  const item = await prisma.$transaction(async tx => {
    // Serialize attempts per worker database, below the vendor's 20/minute limit.
    if (await tx.cloudAgentNotification.count({ where: { attemptedAt: { gt: new Date(Date.now() - 4000) } } })) return null
    const candidate = await tx.cloudAgentNotification.findFirst({ where: { status: 'queued', nextAttempt: { lte: now } }, orderBy: { createdAt: 'asc' } })
    if (!candidate) return null
    const claimed = await tx.cloudAgentNotification.updateMany({ where: { id: candidate.id, status: 'queued' }, data: { status: 'sending', leaseToken, leaseUntil: new Date(Date.now() + 60000), attemptedAt: now } })
    return claimed.count ? candidate : null
  })
  if (!item) return
  const owned = { id: item.id, status: 'sending', leaseToken }
  try {
    const task = await prisma.cloudAgentTask.findUnique({ where: { id: item.taskId } })
    const state = task && notificationState({ ...task, handoffStatus: (await handoffsFor([task])).get(task.id)?.status })
    if (!task || !state || state.key !== item.stateKey) {
      await prisma.cloudAgentNotification.updateMany({ where: owned, data: { status: 'obsolete', leaseToken: null, leaseUntil: null } }); return
    }
    const owner = task.creatorId ? await prisma.apiToken.findUnique({ where: { id: task.creatorId }, select: { personCode: true } }) : null
    let recipient, payload
    try {
      recipient = notificationRecipient(owner?.personCode || null, record(JSON.parse(process.env.CLOUD_AGENT_WECOM_USERS || '{}')), { userId: process.env.CLOUD_AGENT_WECOM_DEFAULT_USER, mobile: process.env.CLOUD_AGENT_WECOM_DEFAULT_MOBILE })
      const appLabel = loadWorkspaceAppsConfig().apps.find(app => app.app_id === task.appId)?.label || task.appId
      payload = notificationPayload(task, state, recipient, process.env.CLOUD_AGENT_PUBLIC_URL || '', appLabel)
      validateWecomWebhook(process.env.CLOUD_AGENT_WECOM_WEBHOOK || '')
    } catch {
      await prisma.cloudAgentNotification.updateMany({ where: owned, data: { status: 'queued', nextAttempt: new Date(Date.now() + 60000), error: '通知配置未就绪：检查Webhook、接收人映射与工作台地址', leaseToken: null, leaseUntil: null } }); return
    }
    if (item.attempts >= 6) {
      await prisma.cloudAgentNotification.updateMany({ where: owned, data: { status: 'failed', error: '通知重试已达上限，请管理员检查发送记录', leaseToken: null, leaseUntil: null } }); return
    }
    await prisma.cloudAgentNotification.updateMany({ where: owned, data: { attempts: { increment: 1 } } })
    await send(payload, signal)
    await prisma.cloudAgentNotification.updateMany({ where: owned, data: { status: 'sent', sentAt: new Date(), error: null, leaseToken: null, leaseUntil: null } })
  } catch (error) {
    // Never persist request URLs or arbitrary transport errors containing the robot key.
    await prisma.cloudAgentNotification.updateMany({ where: owned, data: { status: item.attempts + 1 >= 6 ? 'failed' : 'queued', nextAttempt: new Date(Date.now() + Math.min(900000, 30000 * 2 ** item.attempts)), error: error instanceof CloudError ? error.message : '企业微信网络请求失败，等待重试', leaseToken: null, leaseUntil: null } })
  }
}
