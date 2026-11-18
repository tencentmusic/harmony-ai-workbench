import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

const directory = await mkdtemp(path.join(os.tmpdir(), 'developer-handoff-'))
process.env.DATABASE_URL = `file:${path.join(directory, 'test.db')}`
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { env: { ...process.env, RUST_LOG: 'info' }, stdio: 'pipe' })
const { prisma } = await import('@/lib/prisma')
const { registerIntegrationHandoff } = await import('./delivery-handoff')
const { getCloudTask, listCloudTasks, decideCloudTask } = await import('./store')
const { transitionIntegrationTaskStatus } = await import('@/server/modules/integration/public')
after(async () => { await prisma.$disconnect(); await rm(directory, { recursive: true, force: true }) })

test('developer confirms once, without notes or rerunning translation/review; both screens share submission', async () => {
  const owner = await prisma.apiToken.create({ data: { tokenHash: 'handoff-fixture', personName: '开发测试', personCode: 'handoff-fixture' } })
  const actor = { id: owner.id, appIds: ['KugouLive'] }
  async function fixture(suffix: string, legacy = false, provisional = false) {
    const id = `handoff-${suffix}`, sha = 'a'.repeat(40)
    const deviceConclusion = provisional ? { result: 'incomplete', reason: '缺少真实播放证据' } : undefined
    if (legacy) await registerIntegrationHandoff({ id: `cloud-${id}`, taskId: id, title: 'fixture', appId: 'KugouLive', branch: 'feature/demo', target: 'kan-fx-release', sha, identity: id, documents: `docs/migrations/KugouLive/${id}`, creatorId: owner.id, deviceConclusion })
    return prisma.cloudAgentTask.create({ data: { id, appId: 'KugouLive', title: 'fixture', material: '', targetBranch: 'kan-fx-release', status: 'awaiting_merge', stage: 'integration', creatorId: owner.id,
      harnessJson: JSON.stringify({ workspace: { continuous: true, materialVersion: 1, identity: id, branch: 'feature/demo' }, status: { phase: provisional ? 'build_passed' : 'delivery_ready', nodes: [] }, deviceConclusion, delivery: { ...(legacy ? { integrationId: `cloud-${id}` } : {}), codeSnapshot: { sha }, codeCandidate: { sha, origin: 'https://git.example', repository: 'team/code', branch: 'feature/demo', target: 'kan-fx-release' } } }) } })
  }
  const task = await fixture('direct')
  const before = await getCloudTask(actor, task.id)
  assert.equal(before.delivery?.handoff?.status, 'pending')
  assert.equal(await prisma.integrationTask.count(), 0, 'no integration record until developer confirms')
  assert.equal((await listCloudTasks(actor, new URL('http://localhost/tasks?filter=confirmation'))).total, 1)
  assert.ok(before.actions.includes('confirm_delivery'))
  assert.ok(!before.actions.includes('rework'))
  await assert.rejects(decideCloudTask({ ...actor, appIds: [] }, task.id, { action: 'confirm_delivery', revision: task.revision }), /权限/)
  await assert.rejects(decideCloudTask(actor, task.id, { action: 'confirm_delivery', revision: task.revision + 1 }), /变化/)
  const confirmed = await decideCloudTask(actor, task.id, { action: 'confirm_delivery', revision: task.revision })
  assert.equal(confirmed.delivery?.handoff?.status, 'submitted')
  assert.equal(confirmed.status, 'awaiting_merge')
  assert.equal(confirmed.delivery?.handoff?.submittedBy, '开发测试')
  assert.equal(confirmed.actions.includes('confirm_delivery'), false)
  assert.equal(await prisma.integrationTask.count(), 1)
  assert.equal((await listCloudTasks(actor, new URL('http://localhost/tasks?filter=confirmation'))).total, 0)
  await decideCloudTask(actor, task.id, { action: 'confirm_delivery', revision: task.revision })
  assert.equal(await prisma.integrationTaskEvent.count({ where: { taskId: `cloud-${task.id}` } }), 1)
  for (const action of ['rework', 'retry', 'resume_translation']) await assert.rejects(decideCloudTask(actor, task.id, { action, revision: confirmed.revision, reason: 'local fix' }))
  assert.equal(await prisma.integrationRun.count(), 0)
  assert.equal(await prisma.cloudAgentRun.count(), 0)
  const other = await fixture('integration-entry', true)
  await transitionIntegrationTaskStatus({ taskId: `cloud-${other.id}`, status: 'submitted', expectedStatus: 'developing', actorTokenId: owner.id })
  assert.equal((await getCloudTask(actor, other.id)).delivery?.handoff?.status, 'submitted')
  const list = await listCloudTasks(actor, new URL('http://localhost/tasks'))
  assert.ok(list.items.every(item => item.delivery?.handoff?.status === 'submitted'))
  assert.equal(await prisma.integrationRun.count(), 0, 'handoff submission must not run model review again')
  const closed = await fixture('closed', true)
  await transitionIntegrationTaskStatus({ taskId: `cloud-${closed.id}`, status: 'closed', actorTokenId: owner.id })
  await assert.rejects(decideCloudTask(actor, closed.id, { action: 'confirm_delivery', revision: closed.revision }), /关闭/)
  const provisional = await fixture('provisional', true, true)
  await transitionIntegrationTaskStatus({ taskId: `cloud-${provisional.id}`, status: 'submitted', expectedStatus: 'developing', actorTokenId: owner.id })
  assert.equal(await prisma.integrationRun.count({ where: { taskId: `cloud-${provisional.id}` } }), 0)
  assert.match((await prisma.integrationTask.findUniqueOrThrow({ where: { id: `cloud-${provisional.id}` } })).featureDesc || '', /设备验收结论：未完成/)
})
