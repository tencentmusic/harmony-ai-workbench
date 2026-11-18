import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtemp, rm, writeFile, mkdir, readFile, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const directory = await mkdtemp(path.join(os.tmpdir(), 'cloud-agent-store-test-'))
process.env.DATABASE_URL = `file:${path.join(directory, 'test.db')}`
process.env.CLOUD_AGENT_MATERIAL_ROOT = path.join(directory, 'materials')
process.env.CLOUD_AGENT_RUNTIME_ROOT = path.join(directory, 'runtime')
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { env: { ...process.env, RUST_LOG: 'info' }, stdio: 'pipe' })
const { prisma } = await import('@/lib/prisma')
const { createCloudTask, claimCloudRun, finishCloudRun, getCloudTask, deleteCloudTask, listCloudRuns, decideCloudTask, listCloudTasks, cloudEvents, saveCloudMaterials } = await import('./store')
const { receiveCloudWebhook, processCloudInbox } = await import('./webhook')
const { recoverCloudLeases } = await import('./worker')
const { resumeCloudUiReview } = await import('./review-recovery')
const { cloudProject, branchAllowed } = await import('./config')
const { uploadCloudMaterial, downloadCloudMaterial, cleanupStagedMaterials } = await import('./materials')
const { materialTools } = await import('./material-tools')
const actor = { id: 'test-actor', appIds: ['KugouLive'] }
const material = { appId: 'KugouLive', title: '资料迁移', material: 'MainMeFragment 来源材料', targetBranch: 'kan-fx-release' }
async function removeWorkspaceFixture(id: string) {
  await prisma.cloudAgentEvent.deleteMany({ where: { taskId: id } })
  await prisma.cloudAgentApproval.deleteMany({ where: { taskId: id } })
  await prisma.cloudAgentRun.deleteMany({ where: { taskId: id } })
  await prisma.cloudAgentTask.delete({ where: { id } })
}
after(async () => { await prisma.$disconnect(); await rm(directory, { recursive: true, force: true }) })

test('artifact maintenance prevents a queued task claim while other tasks can still start', async () => {
  const { artifactMaintenanceLock, manageCloudArtifacts } = await import('./artifact-maintenance')
  const first = await prisma.cloudAgentTask.create({ data: { ...material, status: 'queued', material: 'synthetic' } })
  const second = await prisma.cloudAgentTask.create({ data: { ...material, status: 'queued', material: 'synthetic other' } })
  const release = await artifactMaintenanceLock(first.id, 'test-maintenance', new AbortController().signal)
  try {
    assert.equal((await claimCloudRun())?.task.id, second.id)
    assert.equal(await claimCloudRun(), null)
    await assert.rejects(manageCloudArtifacts('preview', second.id), /执行|排队/)
  } finally { await release() }
  try { assert.equal((await claimCloudRun())?.task.id, first.id) }
  finally { await removeWorkspaceFixture(first.id); await removeWorkspaceFixture(second.id) }
})

test('artifact operations preview, archive and restore an idle managed task without changing its phase', async () => {
  const { manageCloudArtifacts } = await import('./artifact-maintenance')
  const identity = 'artifact-ops-fixture'
  const artifactRoot = path.join(directory, 'runtime', 'tasks', identity, 'artifacts')
  const runDir = path.join(artifactRoot, 'harness')
  const backup = path.join(artifactRoot, 'execution', 'build-old', 'previous-0.hsp')
  await mkdir(runDir, { recursive: true })
  await mkdir(path.dirname(backup), { recursive: true })
  await writeFile(backup, 'synthetic backup')
  await writeFile(path.join(runDir, 'harness-events.jsonl'), JSON.stringify({ command: 'run-build', operation_id: 'build-old', status: 'committed' }))
  const harnessJson = JSON.stringify({ workspace: { identity, artifactRoot, runDir } })
  const task = await prisma.cloudAgentTask.create({ data: { ...material, status: 'harness_waiting', harnessJson } })
  try {
    await assert.rejects(manageCloudArtifacts('preview', task.id, undefined, '0', AbortSignal.abort()))
    const preview = await manageCloudArtifacts('preview', task.id, undefined, '0')
    assert.ok('digest' in preview)
    const archived = await manageCloudArtifacts('archive', task.id, preview.digest, '0')
    assert.ok('archiveId' in archived && archived.archiveId)
    await assert.rejects(access(backup))
    const listed = await manageCloudArtifacts('list', task.id)
    assert.ok('archives' in listed && listed.archives?.length === 1)
    await manageCloudArtifacts('restore', task.id, archived.archiveId)
    assert.equal(await readFile(backup, 'utf8'), 'synthetic backup')
    const current = await prisma.cloudAgentTask.findUniqueOrThrow({ where: { id: task.id } })
    assert.equal(current.status, task.status)
    assert.equal(current.revision, task.revision)
    assert.equal(current.harnessJson, harnessJson)
    assert.equal(await prisma.cloudAgentEvent.count({ where: { taskId: task.id, kind: 'artifact-maintenance' } }), 2)
  } finally { await removeWorkspaceFixture(task.id) }
})

test('handoff registers exactly one integration record without a GitLab token and binds the verified snapshot', async () => {
  const { registerIntegrationHandoff } = await import('./delivery-handoff')
  const original = process.env.CLOUD_AGENT_GITLAB_TOKEN
  delete process.env.CLOUD_AGENT_GITLAB_TOKEN
  const input = { id: 'synthetic-cloud-handoff', taskId: 'fixture', title: 'Fixture', appId: 'KugouLive', branch: 'feature/x', target: 'kan-fx-release', sha: 'a'.repeat(40), identity: 'fixture', documents: 'docs/migrations/fixture', creatorId: null }
  try {
    const first = await registerIntegrationHandoff(input)
    const retry = await registerIntegrationHandoff(input)
    assert.equal(first.id, retry.id)
    assert.equal(first.status, 'developing')
    assert.equal(await prisma.integrationRun.count({ where: { taskId: first.id } }), 0, 'registering does not restart model review')
    await assert.rejects(registerIntegrationHandoff({ ...input, sha: 'b'.repeat(40) }), /快照/)
  } finally {
    await prisma.integrationTask.deleteMany({ where: { id: input.id } })
    if (original !== undefined) process.env.CLOUD_AGENT_GITLAB_TOKEN = original
  }
})

test('delivery automation queues only settled native delivery-ready tasks, never requeues running or recovery tasks', async () => {
  const { queueAutomaticDelivery, wakeDeliveryForMerge } = await import('./delivery-automation')
  const saved = { workspace: { continuous: true, materialVersion: 1 }, status: { phase: 'delivery_ready' }, delivery: { codeCandidate: { origin: 'https://git.example', repository: 'team/repo', branch: 'feature/x', target: 'kan-fx-release', sha: 'a'.repeat(40) } } }
  const task = await prisma.cloudAgentTask.create({ data: { appId: 'KugouLive', title: 'auto fixture', material: '', targetBranch: 'kan-fx-release', status: 'delivery_ready', harnessJson: JSON.stringify(saved) } })
  try {
    const run = await prisma.cloudAgentRun.create({ data: { taskId: task.id, revision: 1, input: '', materialSnapshot: '', leaseToken: 'fixture', leaseUntil: new Date(Date.now() + 60000), status: 'running' } })
    assert.equal(await queueAutomaticDelivery(task.id, 'submit_delivery'), false)
    await prisma.cloudAgentRun.update({ where: { id: run.id }, data: { status: 'delivery_ready' } })
    assert.equal(await queueAutomaticDelivery(task.id, 'submit_delivery'), true)
    assert.equal(await queueAutomaticDelivery(task.id, 'submit_delivery'), false)
    const queued = await prisma.cloudAgentTask.findUniqueOrThrow({ where: { id: task.id } })
    assert.equal(JSON.parse(queued.harnessJson).deliveryRequest.automatic, true)
    await prisma.cloudAgentTask.update({ where: { id: task.id }, data: { status: 'awaiting_merge' } })
    assert.equal(await wakeDeliveryForMerge({ origin: 'https://evil.example', repository: 'team/repo', branch: 'kan-fx-release', iid: 1 }), false)
    assert.equal(await wakeDeliveryForMerge({ origin: 'https://git.example', repository: 'team/repo', branch: 'other', iid: 1 }), false)
    assert.equal(await wakeDeliveryForMerge({ origin: 'https://git.example', repository: 'team/repo', branch: 'kan-fx-release', iid: 1, sourceBranch: 'feature/x', sourceSha: 'a'.repeat(40), mergedSha: 'b'.repeat(40) }), true)
    assert.equal((await prisma.cloudAgentTask.findUniqueOrThrow({ where: { id: task.id } })).status, 'awaiting_merge', 'webhook wakeup is not merge proof')
  } finally { await prisma.cloudAgentDeliveryWatch.deleteMany({ where: { taskId: task.id } }); await removeWorkspaceFixture(task.id) }
})

test('an incomplete device conclusion can queue delivery without a native delivery_ready phase', async () => {
  const { queueAutomaticDelivery } = await import('./delivery-automation')
  const task = await prisma.cloudAgentTask.create({ data: { appId: 'KugouLive', title: 'device conclusion fixture', material: '', targetBranch: 'kan-fx-release', status: 'device_concluded', stage: 'integration',
    harnessJson: JSON.stringify({ workspace: { continuous: true, materialVersion: 1 }, status: { phase: 'build_passed' }, deviceConclusion: { result: 'incomplete' } }) } })
  try {
    assert.equal(await queueAutomaticDelivery(task.id, 'submit_delivery'), true)
    const queued = await prisma.cloudAgentTask.findUniqueOrThrow({ where: { id: task.id } })
    assert.equal(queued.status, 'delivery_queued')
    assert.equal(JSON.parse(queued.harnessJson).deliveryRequest.action, 'submit_delivery')
  } finally { await prisma.cloudAgentDeliveryWatch.deleteMany({ where: { taskId: task.id } }); await removeWorkspaceFixture(task.id) }
})

test('notification outbox deduplicates, drops obsolete notices, retries failures and never stores transport secrets', async () => {
  const { collectCloudNotifications, dispatchCloudNotification } = await import('./notifications')
  const original = { ...process.env }
  Object.assign(process.env, { CLOUD_AGENT_WECOM_WEBHOOK: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-secret', CLOUD_AGENT_WECOM_DEFAULT_USER: 'fallback', CLOUD_AGENT_WECOM_USERS: '{}', CLOUD_AGENT_PUBLIC_URL: 'http://192.168.1.10:3100' })
  const task = await prisma.cloudAgentTask.create({ data: { appId: 'KugouLive', title: 'notify fixture', material: '', targetBranch: 'kan-fx-release', status: 'awaiting_approval' } })
  const signal = new AbortController().signal
  let sent = 0
  try {
    await collectCloudNotifications(); await collectCloudNotifications()
    assert.equal(await prisma.cloudAgentNotification.count({ where: { taskId: task.id } }), 1)
    await dispatchCloudNotification(signal, async payload => { sent++; assert.match(payload.text.content, /审批/); assert.ok('mentioned_list' in payload.text); assert.deepEqual(payload.text.mentioned_list, ['fallback']) })
    await dispatchCloudNotification(signal, async () => { sent++ })
    assert.equal(sent, 1)
    await prisma.cloudAgentTask.update({ where: { id: task.id }, data: { revision: 2, status: 'blocked' } })
    await collectCloudNotifications()
    await prisma.cloudAgentNotification.updateMany({ where: { taskId: task.id }, data: { attemptedAt: null } })
    await dispatchCloudNotification(signal, async () => { throw new Error('secret URL synthetic-secret') })
    const failed = await prisma.cloudAgentNotification.findFirstOrThrow({ where: { taskId: task.id, status: 'queued' } })
    assert.equal(failed.attempts, 1); assert.doesNotMatch(failed.error!, /synthetic-secret/)
    await prisma.cloudAgentTask.update({ where: { id: task.id }, data: { status: 'translating' } })
    await prisma.cloudAgentNotification.updateMany({ where: { id: failed.id }, data: { attemptedAt: null, nextAttempt: new Date(0) } })
    await dispatchCloudNotification(signal, async () => { sent++ })
    assert.equal(sent, 1)
    assert.equal((await prisma.cloudAgentNotification.findUniqueOrThrow({ where: { id: failed.id } })).status, 'obsolete')
    await prisma.cloudAgentTask.update({ where: { id: task.id }, data: { status: 'blocked' } })
    await collectCloudNotifications()
    assert.equal((await prisma.cloudAgentNotification.findUniqueOrThrow({ where: { id: failed.id } })).status, 'queued')
    assert.equal(await prisma.cloudAgentNotification.count({ where: { taskId: task.id, status: 'sent' } }), 1)
  } finally {
    for (const key of ['CLOUD_AGENT_WECOM_WEBHOOK', 'CLOUD_AGENT_WECOM_DEFAULT_USER', 'CLOUD_AGENT_WECOM_USERS', 'CLOUD_AGENT_PUBLIC_URL']) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key] }
    await prisma.cloudAgentNotification.deleteMany({ where: { taskId: task.id } }); await removeWorkspaceFixture(task.id)
  }
})

test('delivery polling is quiet when unchanged, backs off transient failures and honors cancellation and webhook backoff', async () => {
  const { scheduleCloudDelivery, wakeDeliveryForMerge, deliveryRetryLimit } = await import('./delivery-automation')
  const { CloudTransientError } = await import('./domain')
  const saved = { workspace: { continuous: true, materialVersion: 1 }, status: { phase: 'delivery_ready' }, delivery: { codeCandidate: { origin: 'https://git.example', repository: 'team/repo', branch: 'feature/x', target: 'release', sha: 'a'.repeat(40) } } }
  const task = await prisma.cloudAgentTask.create({ data: { appId: 'KugouLive', title: 'watch fixture', material: '', targetBranch: 'release', status: 'awaiting_merge', harnessJson: JSON.stringify(saved) } })
  const signal = new AbortController().signal
  try {
    await scheduleCloudDelivery(signal, async () => false)
    assert.equal(await prisma.cloudAgentRun.count({ where: { taskId: task.id } }), 0)
    assert.equal((await prisma.cloudAgentTask.findUniqueOrThrow({ where: { id: task.id } })).revision, 1)
    for (let attempt = 1; attempt <= deliveryRetryLimit; attempt++) {
      await prisma.cloudAgentDeliveryWatch.update({ where: { taskId: task.id }, data: { nextAttempt: new Date(0) } })
      await scheduleCloudDelivery(signal, async () => { throw new CloudTransientError('temporary', 503) })
      const watch = await prisma.cloudAgentDeliveryWatch.findUniqueOrThrow({ where: { taskId: task.id } })
      assert.equal(watch.failures, attempt)
      assert.ok(watch.nextAttempt > new Date())
      if (attempt < deliveryRetryLimit) {
        assert.equal((await prisma.cloudAgentTask.findUniqueOrThrow({ where: { id: task.id } })).status, 'awaiting_merge')
        await wakeDeliveryForMerge({ origin: 'https://git.example', repository: 'team/repo', branch: 'release', iid: 1, sourceBranch: 'feature/x', sourceSha: 'a'.repeat(40), mergedSha: 'b'.repeat(40) })
        assert.equal((await prisma.cloudAgentDeliveryWatch.findUniqueOrThrow({ where: { taskId: task.id } })).nextAttempt.getTime(), watch.nextAttempt.getTime())
      }
    }
    assert.equal((await prisma.cloudAgentTask.findUniqueOrThrow({ where: { id: task.id } })).status, 'delivery_queued')
    await prisma.cloudAgentTask.update({ where: { id: task.id }, data: { status: 'cancelled' } })
    await scheduleCloudDelivery(signal, async () => { throw new Error('Cancelled task must not poll') })
  } finally { await prisma.cloudAgentDeliveryWatch.deleteMany({ where: { taskId: task.id } }); await removeWorkspaceFixture(task.id) }
})

test('transient delivery run retains frozen state, does not return to coding and stops retrying on cancellation', async () => {
  const { deferDeliveryRun } = await import('./delivery-automation')
  const { CloudTransientError } = await import('./domain')
  const saved = { workspace: { continuous: true, materialVersion: 1 }, status: { phase: 'delivery_ready' }, deliveryRequest: { action: 'sync_delivery' }, delivery: { codeSnapshot: { sha: 'a'.repeat(40) } } }
  const task = await prisma.cloudAgentTask.create({ data: { appId: 'KugouLive', title: 'retry fixture', material: '', targetBranch: 'release', status: 'delivery_queued', harnessJson: JSON.stringify(saved) } })
  try {
    const claim = await claimCloudRun(); assert.equal(claim!.task.id, task.id)
    assert.equal(await deferDeliveryRun(claim!, new CloudTransientError('temporary', 503), new AbortController().signal), true)
    const current = await prisma.cloudAgentTask.findUniqueOrThrow({ where: { id: task.id } })
    assert.equal(current.status, 'awaiting_merge'); assert.equal(current.stage, 'integration')
    assert.equal(JSON.parse(current.harnessJson).delivery.codeSnapshot.sha, saved.delivery.codeSnapshot.sha)
    await prisma.cloudAgentTask.update({ where: { id: task.id }, data: { status: 'cancelled' } })
    assert.equal(await deferDeliveryRun(claim!, new CloudTransientError('temporary', 503), new AbortController().signal), false)
  } finally { await prisma.cloudAgentDeliveryWatch.deleteMany({ where: { taskId: task.id } }); await removeWorkspaceFixture(task.id) }
})

test('queuing continuation retains the verified review, build or device step instead of resetting to coding', async () => {
  for (const [phase, review, expected] of [['wired', 'stale', 'review'], ['wired', 'passed', 'build'], ['build_passed', 'passed', 'device'], ['ui_prototype_approved', 'pending', 'coding']]) {
    const task = await prisma.cloudAgentTask.create({ data: { appId: 'KugouLive', title: 'resume-stage-fixture', material: '', targetBranch: 'kan-fx-release', status: 'approved', stage: expected,
      harnessJson: JSON.stringify({ workspace: { continuous: true, materialVersion: 1 }, status: { phase, codeReview: { status: review }, nodes: [{ id: 'ui_prototype_approved', status: 'passed' }] } }) } })
    try {
      const result = await decideCloudTask(actor, task.id, { action: 'translate', revision: task.revision })
      assert.equal(result.status, 'translation_queued')
      assert.equal(result.stage, expected)
    } finally { await removeWorkspaceFixture(task.id) }
  }
})

test('legacy repair lifecycle is consistent in detail, filters and counts and resets on reanalysis', async () => {
  const task = await prisma.cloudAgentTask.create({ data: { appId: 'KugouLive', title: 'lifecycle-fixture', material: '', targetBranch: 'kan-fx-release', status: 'translating', stage: 'coding', revision: 2,
    harnessJson: JSON.stringify({ workspace: { continuous: true, materialVersion: 1 }, status: { phase: 'ui_prototype_approved', nodes: [], blockers: [] } }) } })
  try {
    const run = await prisma.cloudAgentRun.create({ data: { taskId: task.id, revision: 2, kind: 'translation', input: '', leaseToken: 'fixture', leaseUntil: new Date(0) } })
    await prisma.cloudAgentEvent.create({ data: { taskId: task.id, runId: run.id, kind: 'stage', message: '当前执行：构建验证。按当前已验证门禁继续执行' } })
    const detail = await getCloudTask(actor, task.id)
    assert.equal(detail.stage, 'build')
    assert.equal(detail.harness?.lifecycle?.reviewPassed, true)
    assert.equal(detail.harness?.phase, 'ui_prototype_approved')
    const builds = await listCloudTasks(actor, new URL(`http://localhost/tasks?q=${task.id}&stage=build`))
    assert.equal(builds.total, 1)
    assert.equal(builds.items[0].stage, 'build')
    assert.equal(builds.summary.byStage.build, 1)
    assert.equal(builds.summary.byStage.coding, 0)
    assert.equal((await listCloudTasks(actor, new URL(`http://localhost/tasks?q=${task.id}&stage=coding`))).total, 0)
    await prisma.cloudAgentRun.create({ data: { taskId: task.id, revision: 3, kind: 'analysis', input: '', leaseToken: 'fixture', leaseUntil: new Date(0) } })
    assert.equal((await getCloudTask(actor, task.id)).harness?.lifecycle, undefined)
    assert.equal((await listCloudTasks(actor, new URL(`http://localhost/tasks?q=${task.id}&stage=coding`))).total, 1)
    await assert.rejects(getCloudTask({ id: 'other', appIds: [] }, task.id), /无权限/)
    assert.equal((await listCloudTasks({ id: 'other', appIds: [] }, new URL('http://localhost/tasks'))).total, 0)
  } finally { await removeWorkspaceFixture(task.id) }
})

test('recovery lock hides actions in list and detail even when the locked run is outside recent history', async () => {
  const task = await prisma.cloudAgentTask.create({ data: { appId: 'KugouLive', title: 'recovery-action-fixture', material: '', targetBranch: 'kan-fx-release', status: 'harness_waiting', revision: 12, harnessJson: JSON.stringify({ workspace: { continuous: true } }) } })
  try {
    await prisma.cloudAgentRun.createMany({ data: Array.from({ length: 12 }, (_, index) => ({ taskId: task.id, revision: index + 1, kind: 'translation', status: index ? 'failed' : 'recovery_required', input: '', leaseToken: 'fixture', leaseUntil: new Date(0) })) })
    const detail = await getCloudTask(actor, task.id)
    assert.equal(detail.recoveryRequired, true)
    assert.deepEqual(detail.actions, [])
    const list = await listCloudTasks(actor, new URL(`http://localhost/tasks?q=${task.id}`))
    assert.equal(list.items[0].recoveryRequired, true)
    assert.deepEqual(list.items[0].actions, [])
    for (const action of ['resume_translation', 'retry', 'cancel']) await assert.rejects(decideCloudTask(actor, task.id, { action, revision: 12 }), /需先由运维恢复/)
    await prisma.cloudAgentRun.updateMany({ where: { taskId: task.id, status: 'recovery_required' }, data: { status: 'failed' } })
    assert.ok((await getCloudTask(actor, task.id)).actions.includes('resume_translation'))
  } finally { await removeWorkspaceFixture(task.id) }
})

test('detail returns only current execution, history paginates with scoped access and no private runtime payload', async () => {
  const task = await prisma.cloudAgentTask.create({ data: { appId: 'KugouLive', title: 'history-page-fixture', material: 'facts', targetBranch: 'kan-fx-release', revision: 12 } })
  try {
    await prisma.cloudAgentRun.createMany({ data: Array.from({ length: 12 }, (_, index) => ({ taskId: task.id, revision: index + 1, input: 'private input',
      output: `round-${index + 1}`, materialSnapshot: 'original material', status: 'approved', leaseToken: 'private-lease', leaseUntil: new Date(0), harnessJson: JSON.stringify({ secret: 'private-runtime' }) })) })
    const detail = await getCloudTask(actor, task.id)
    assert.equal(detail.runs.length, 1)
    assert.equal(detail.runs[0].output, 'round-12')
    const first = await listCloudRuns(actor, task.id, new URL('http://localhost/runs'))
    assert.equal(first.items.length, 10); assert.equal(first.nextBefore, 3)
    const next = await listCloudRuns(actor, task.id, new URL('http://localhost/runs?before=3'))
    assert.deepEqual(next.items.map(item => item.output), ['round-2', 'round-1']); assert.equal(next.nextBefore, null)
    assert.equal(new Set([...first.items, ...next.items].map(item => item.id)).size, 12)
    assert.doesNotMatch(JSON.stringify({ detail, first, next }), /private-runtime|private-lease|private input/)
    for (const before of ['0', '-1', 'x', '1.5']) await assert.rejects(listCloudRuns(actor, task.id, new URL(`http://localhost/runs?before=${before}`)), /游标/)
    await assert.rejects(listCloudRuns({ id: 'other', appIds: [] }, task.id, new URL('http://localhost/runs')), /无权限/)
    await assert.rejects(getCloudTask({ id: 'other', appIds: [] }, task.id), /无权限/)
  } finally { await removeWorkspaceFixture(task.id) }
})

test('UI recovery refuses stale or cancelled tasks, extra instances, missing approval and revoked authority without changing state', async () => {
  const workspace = { continuous: true, materialVersion: 1, artifactRoot: directory, runDir: directory }
  const review = { kind: 'ui', digest: 'a'.repeat(64), materialVersion: 1 }
  const task = await prisma.cloudAgentTask.create({ data: { appId: 'KugouLive', title: 'recovery-guard-fixture', material: '', targetBranch: 'kan-fx-release', status: 'blocked', revision: 2, harnessJson: JSON.stringify({ workspace, review }) } })
  const run = await prisma.cloudAgentRun.create({ data: { taskId: task.id, revision: 2, kind: 'review', status: 'recovery_required', input: '', leaseToken: 'fixture', leaseUntil: new Date(0) } })
  try {
    await prisma.cloudAgentTask.update({ where: { id: task.id }, data: { status: 'cancelled' } })
    await assert.rejects(resumeCloudUiReview(run.id), /任务或材料已变化/)
    await prisma.cloudAgentTask.update({ where: { id: task.id }, data: { status: 'blocked', materialVersion: 2 } })
    await assert.rejects(resumeCloudUiReview(run.id), /任务或材料已变化/)
    await prisma.cloudAgentTask.update({ where: { id: task.id }, data: { materialVersion: 1 } })
    await prisma.cloudAgentRun.update({ where: { id: run.id }, data: { instanceJson: '{"pid":123}' } })
    await assert.rejects(resumeCloudUiReview(run.id), /额外实例/)
    await prisma.cloudAgentRun.update({ where: { id: run.id }, data: { instanceJson: '{}' } })
    await assert.rejects(resumeCloudUiReview(run.id), /原始UI人工确认/)
    await prisma.cloudAgentApproval.create({ data: { taskId: task.id, revision: 1, actorId: 'revoked-or-missing', digest: review.digest, decision: 'ui', reason: 'fixture', payload: JSON.stringify(review) } })
    await assert.rejects(resumeCloudUiReview(run.id), /授权已失效/)
    assert.equal((await prisma.cloudAgentRun.findUniqueOrThrow({ where: { id: run.id } })).status, 'recovery_required')
    assert.equal(await prisma.cloudAgentEvent.count({ where: { taskId: task.id } }), 0)
    assert.equal(await prisma.cloudAgentApproval.count({ where: { taskId: task.id } }), 1)
  } finally { await removeWorkspaceFixture(task.id) }
})

test('completed review rejection can retry while uncertain native writes retain the recovery lock', async () => {
  for (const terminal of ['blocked', 'recovery_required'] as const) {
    const task = await prisma.cloudAgentTask.create({ data: { appId: 'KugouLive', title: 'review-validation-fixture', material: 'facts', targetBranch: 'kan-fx-release', status: 'reviewing', revision: 2 } })
    try {
      const run = await prisma.cloudAgentRun.create({ data: { taskId: task.id, revision: 2, kind: 'review', input: '', leaseToken: 'review-fixture', leaseUntil: new Date(Date.now() + 60000) } })
      await finishCloudRun(run.id, run.leaseToken, terminal, 'original evidence', 'P-1: missing behavior')
      const stored = await getCloudTask(actor, task.id)
      assert.equal(stored.status, 'blocked')
      assert.equal(stored.runs[0].error, 'P-1: missing behavior')
      if (terminal === 'recovery_required') await assert.rejects(decideCloudTask(actor, task.id, { action: 'retry', revision: 2 }), /需先由运维恢复/)
      else assert.equal((await decideCloudTask(actor, task.id, { action: 'retry', revision: 2 })).status, 'queued')
    } finally { await removeWorkspaceFixture(task.id) }
  }
})

test('compact task filters stay scoped and independent from lifecycle selection', async () => {
  const title = 'workspace-filter-fixture'
  try {
    await prisma.cloudAgentTask.createMany({ data: ['awaiting_approval', 'translating', 'failed', 'completed', 'cancelled'].map(status => ({ appId: 'KugouLive', title, material: '', targetBranch: 'kan-fx-release', status })) })
    await prisma.cloudAgentTask.create({ data: { appId: 'KugouPlayer', title, material: '', targetBranch: 'main', status: 'awaiting_approval' } })
    for (const filter of ['confirmation', 'active', 'issues', 'completed', 'cancelled']) assert.equal((await listCloudTasks(actor, new URL(`http://localhost/tasks?q=${title}&filter=${filter}`))).total, 1)
    assert.equal((await listCloudTasks({ id: 'outside', appIds: [] }, new URL('http://localhost/tasks?filter=confirmation'))).total, 0)
    await assert.rejects(listCloudTasks(actor, new URL('http://localhost/tasks?filter=invalid')), /筛选/)
  } finally { await prisma.cloudAgentTask.deleteMany({ where: { title } }) }
})

test('one-click approval stays bound to digest and material version and records explicit default intent', async () => {
  const review = { kind: 'ui', digest: 'a'.repeat(64), materialVersion: 1, content: '# UI', files: [], decision: 'approved' }
  const task = await prisma.cloudAgentTask.create({ data: { appId: 'KugouLive', title: 'inline-review-fixture', material: 'facts', targetBranch: 'kan-fx-release', status: 'awaiting_approval', harnessJson: JSON.stringify({ workspace: { continuous: true }, review }), runs: { create: { revision: 1, status: 'awaiting_approval', input: '', leaseToken: 'fixture', leaseUntil: new Date(0) } } } })
  try {
    await assert.rejects(decideCloudTask(actor, task.id, { action: 'approve', revision: 1, digest: 'b'.repeat(64) }), /失效/)
    await decideCloudTask(actor, task.id, { action: 'approve', revision: 1, digest: review.digest })
    const approval = await prisma.cloudAgentApproval.findFirstOrThrow({ where: { taskId: task.id } })
    assert.match(approval.reason, /开始代码转译/)
    assert.equal(approval.actorId, actor.id)
    await assert.rejects(decideCloudTask(actor, task.id, { action: 'approve', revision: 1, digest: review.digest }), /变化/)
  } finally { await removeWorkspaceFixture(task.id) }
})

test('material submit atomically saves a new baseline and queues analysis, rejecting active or stale edits', async () => {
  const task = await prisma.cloudAgentTask.create({ data: { appId: 'KugouLive', title: 'material-submit-fixture', material: 'old', targetBranch: 'kan-fx-release', status: 'awaiting_approval' } })
  try {
    const saved = await saveCloudMaterials(actor, task.id, { material: 'new', materialVersion: 1, reanalyze: true })
    assert.equal(saved.materialVersion, 2)
    assert.equal(saved.revision, 2)
    assert.equal(saved.status, 'queued')
    await assert.rejects(saveCloudMaterials(actor, task.id, { material: 'stale', materialVersion: 1, reanalyze: true }), /更新/)
    await prisma.cloudAgentTask.update({ where: { id: task.id }, data: { status: 'running' } })
    await assert.rejects(saveCloudMaterials(actor, task.id, { material: 'unsafe', materialVersion: 2, reanalyze: true }), /运行/)
    assert.equal((await getCloudTask(actor, task.id)).material, 'new')
  } finally { await removeWorkspaceFixture(task.id) }
})

test('automatic translation requires a UI approval plus native receipt and cancellation wins', async () => {
  for (const variant of ['valid', 'scope', 'stale', 'cancel', 'missing'] as const) {
    const workspace = { continuous: true, materialVersion: 1 }
    const task = await prisma.cloudAgentTask.create({ data: { appId: 'KugouLive', title: `auto-translation-${variant}`, material: 'facts', targetBranch: 'kan-fx-release', status: variant === 'cancel' ? 'cancelling' : 'reviewing', revision: 2, materialVersion: variant === 'stale' ? 2 : 1,
      harnessJson: JSON.stringify({ workspace, status: { nodes: variant === 'missing' ? [] : [{ id: 'scope_approved', status: 'passed' }, { id: 'ui_prototype_approved', status: 'passed' }] } }) } })
    try {
      await prisma.cloudAgentApproval.create({ data: { taskId: task.id, revision: 1, actorId: actor.id, digest: 'a'.repeat(64), decision: variant === 'scope' ? 'scope' : 'ui', reason: 'fixture approval', payload: '{}' } })
      const run = await prisma.cloudAgentRun.create({ data: { taskId: task.id, revision: 2, kind: 'review', input: '', leaseToken: 'fixture', leaseUntil: new Date(Date.now() + 60000) } })
      if (variant === 'scope' || variant === 'missing') await assert.rejects(finishCloudRun(run.id, run.leaseToken, 'translation_queued', '# reviewed'), /UI 人工审批/)
      else {
        await finishCloudRun(run.id, run.leaseToken, 'translation_queued', '# reviewed')
        const result = await getCloudTask(actor, task.id)
        assert.equal(result.status, variant === 'valid' ? 'translation_queued' : variant === 'cancel' ? 'cancelled' : 'awaiting_input')
        assert.equal(result.revision, variant === 'valid' ? 3 : 2)
      }
    } finally { await removeWorkspaceFixture(task.id) }
  }
})

test('task list and detail expose identical feature branch metadata without the private workspace', async () => {
  const task = await prisma.cloudAgentTask.create({ data: { appId: 'KugouLive', title: 'branch-display-fixture', material: '', targetBranch: 'kan-fx-release', status: 'cancelled',
    harnessJson: JSON.stringify({ workspace: { branch: 'feature/cloud-existing', targetBranch: 'kan-fx-release', baseSha: 'a'.repeat(40), harmonyRoot: '/private/repository' } }) } })
  try {
    const detail = await getCloudTask(actor, task.id)
    const list = await listCloudTasks(actor, new URL(`http://localhost/tasks?q=${task.id}`))
    assert.deepEqual(list.items[0].branch, detail.branch)
    assert.equal(detail.branch?.name, 'feature/cloud-existing')
    assert.equal(detail.branch?.base, 'kan-fx-release')
    assert.ok(!JSON.stringify(list).includes('/private/repository'))
    assert.ok(!('harnessJson' in list.items[0]))
  } finally { await prisma.cloudAgentTask.delete({ where: { id: task.id } }) }
})

test('delivery requires native readiness and freezes materials after snapshot even on failure', async () => {
  const task = await prisma.cloudAgentTask.create({ data: { appId: 'KugouLive', title: 'delivery-gate-fixture', material: '', targetBranch: 'kan-fx-release', status: 'delivery_ready' } })
  try {
    await assert.rejects(decideCloudTask(actor, task.id, { action: 'submit_delivery', revision: task.revision }), /尚未交付/)
    await prisma.cloudAgentTask.update({ where: { id: task.id }, data: { status: 'failed', harnessJson: JSON.stringify({ delivery: { codeSnapshot: { sha: 'a'.repeat(40) } } }) } })
    await assert.rejects(saveCloudMaterials(actor, task.id, { materialVersion: task.materialVersion, material: 'changed', attachmentIds: [] }), /固定快照/)
    await assert.rejects(decideCloudTask(actor, task.id, { action: 'retry', revision: task.revision }), /快照已固定/)
  } finally { await prisma.cloudAgentTask.delete({ where: { id: task.id } }) }
})

test('token-free delivery rejects in-place rework and cannot bypass a merged MR', async () => {
  const harness = { workspace: { continuous: true, materialVersion: 1 }, status: { phase: 'delivery_ready' }, deliveryRequest: { action: 'rework' }, delivery: { priorCode: { sha: 'a'.repeat(40) }, reworkReason: 'repair playback', codeMerged: false } }
  const task = await prisma.cloudAgentTask.create({ data: { appId: 'KugouLive', title: 'rework-fixture', material: '', targetBranch: 'kan-fx-release', status: 'failed', harnessJson: JSON.stringify(harness) } })
  await prisma.cloudAgentRun.create({ data: { taskId: task.id, revision: task.revision, materialVersion: 1, materialSnapshot: '', input: '', leaseToken: 'fixture', leaseUntil: new Date(0), kind: 'delivery', status: 'failed' } })
  try {
    await assert.rejects(decideCloudTask(actor, task.id, { action: 'rework', revision: task.revision, reason: '' }))
    await assert.rejects(decideCloudTask(actor, task.id, { action: 'rework', revision: task.revision, reason: 'resume interrupted repair' }), /无 Token/)
    const next = await prisma.cloudAgentTask.findUniqueOrThrow({ where: { id: task.id } })
    assert.equal(next.status, 'failed')
    await prisma.cloudAgentTask.update({ where: { id: task.id }, data: { status: 'awaiting_merge' } })
    assert.equal((await getCloudTask(actor, task.id)).actions.includes('rework'), false)
    assert.equal((await listCloudTasks(actor, new URL(`http://localhost/tasks?q=${task.id}`))).items[0].actions.includes('rework'), false)
    harness.delivery.codeMerged = true
    await prisma.cloudAgentTask.update({ where: { id: task.id }, data: { status: 'failed', harnessJson: JSON.stringify(harness) } })
    await assert.rejects(decideCloudTask(actor, task.id, { action: 'rework', revision: next.revision, reason: 'repair playback' }), /未合入/)
  } finally {
    await prisma.cloudAgentEvent.deleteMany({ where: { taskId: task.id } })
    await prisma.cloudAgentRun.deleteMany({ where: { taskId: task.id } })
    await prisma.cloudAgentTask.delete({ where: { id: task.id } })
  }
})

test('failed tasks retain their actual lifecycle stage in counts and filters', async () => {
  const marker = 'persisted-stage-fixture'
  try {
    await prisma.cloudAgentTask.createMany({ data: ['build', 'device'].map(stage => ({ appId: 'KugouLive', title: marker, material: '', targetBranch: 'kan-fx-release', status: 'failed', stage })) })
    const list = await listCloudTasks(actor, new URL(`http://localhost/tasks?q=${marker}&stage=build`))
    assert.equal(list.total, 1)
    assert.equal(list.items[0].stage, 'build')
    assert.equal(list.summary.byStage.build, 1)
    assert.equal(list.summary.byStage.device, 1)
    assert.equal(list.summary.byStage.analysis, 0)
  } finally { await prisma.cloudAgentTask.deleteMany({ where: { title: marker } }) }
})

test('review files require app access, current digest, unchanged bytes and scoped paths', async () => {
  const { downloadReviewFile } = await import('./review-files')
  const { sha256 } = await import('./scoped-files')
  const file = path.join(directory, 'review.txt')
  await writeFile(file, 'review evidence')
  const review = { digest: 'd'.repeat(64), materialVersion: 1, files: [{ id: 'opaque-file', label: 'layoutSpec', path: file, mime: 'text/plain', sha256: sha256('review evidence') }] }
  const workspace = { artifactRoot: directory }
  const task = await prisma.cloudAgentTask.create({ data: { appId: 'KugouLive', title: 'review-file-fixture', material: '', targetBranch: 'kan-fx-release', status: 'awaiting_approval', harnessJson: JSON.stringify({ workspace, review }) } })
  const url = new URL(`http://localhost/review-file?digest=${review.digest}&file=opaque-file`)
  try {
    await assert.rejects(downloadReviewFile({ id: 'outsider', appIds: [] }, task.id, url), /权限/)
    await assert.rejects(downloadReviewFile(actor, task.id, new URL('http://localhost/review-file?digest=stale&file=opaque-file')), /版本/)
    const response = await downloadReviewFile(actor, task.id, url)
    assert.equal(await response.text(), 'review evidence')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.match(response.headers.get('content-security-policy')!, /sandbox/)
    await writeFile(file, 'changed evidence')
    await assert.rejects(downloadReviewFile(actor, task.id, url), /已变化/)
    review.files[0].path = path.join(directory, '..', 'outside-review.txt')
    await prisma.cloudAgentTask.update({ where: { id: task.id }, data: { harnessJson: JSON.stringify({ workspace, review }) } })
    await assert.rejects(downloadReviewFile(actor, task.id, url))
    await prisma.cloudAgentTask.update({ where: { id: task.id }, data: { materialVersion: 2 } })
    await assert.rejects(downloadReviewFile(actor, task.id, url), /版本/)
  } finally { await prisma.cloudAgentTask.delete({ where: { id: task.id } }) }
})

test('HTML preview uses the same access, digest and material gates as downloads without approving', async () => {
  const { downloadReviewFile } = await import('./review-files')
  const { sha256 } = await import('./scoped-files')
  const html = '<!doctype html><html><body><main>Preview only</main><script>alert(1)</script></body></html>'
  const file = path.join(directory, 'review.html')
  await writeFile(file, html)
  const review = { digest: 'e'.repeat(64), materialVersion: 1, files: [{ id: 'prototype', label: 'prototypes/ready', path: file, mime: 'text/plain', sha256: sha256(html) }] }
  const task = await prisma.cloudAgentTask.create({ data: { appId: 'KugouLive', title: 'html-review-fixture', material: '', targetBranch: 'kan-fx-release', status: 'awaiting_approval', harnessJson: JSON.stringify({ workspace: { artifactRoot: directory }, review }) } })
  const url = new URL(`http://localhost/review-file?digest=${review.digest}&file=prototype&preview=html`)
  try {
    await assert.rejects(downloadReviewFile({ id: 'outsider', appIds: [] }, task.id, url), /权限/)
    const stale = new URL(url); stale.searchParams.set('digest', 'old')
    await assert.rejects(downloadReviewFile(actor, task.id, stale), /版本/)
    const response = await downloadReviewFile(actor, task.id, url)
    assert.match(response.headers.get('content-type')!, /application\/json/)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const result = await response.json()
    assert.match(result.html, /Preview only/)
    assert.doesNotMatch(result.html, /<script/)
    const after = await prisma.cloudAgentTask.findUniqueOrThrow({ where: { id: task.id } })
    assert.equal(after.harnessJson, task.harnessJson)
    assert.equal(after.revision, task.revision)
    assert.equal(await prisma.cloudAgentApproval.count({ where: { taskId: task.id } }), 0)
    await writeFile(file, 'changed')
    await assert.rejects(downloadReviewFile(actor, task.id, url), /已变化/)
    await writeFile(file, html)
    await prisma.cloudAgentTask.update({ where: { id: task.id }, data: { materialVersion: 2 } })
    await assert.rejects(downloadReviewFile(actor, task.id, url), /版本/)
  } finally { await prisma.cloudAgentTask.delete({ where: { id: task.id } }) }
})

test('coding retains native-approved UI snapshots and preview without reviving an approval action', async () => {
  const { downloadReviewFile } = await import('./review-files')
  const { sha256 } = await import('./scoped-files')
  const root = await mkdtemp(path.join(directory, 'approved-ui-'))
  const runDir = path.join(root, 'harness'); await mkdir(runDir)
  const html = '<html><body><main>Approved full UI</main><script>bad()</script></body></html>'
  const file = path.join(root, 'ui.html'); await writeFile(file, html)
  const review = { kind: 'ui', digest: 'b'.repeat(64), materialVersion: 1, content: '# Approved UI', decision: 'approved', files: [{ id: 'html', label: 'prototypes/ready', mime: 'text/plain', path: file, sha256: sha256(html) }] }
  const workspace = { continuous: true, identity: 'approved-ui-test', materialVersion: 1, artifactRoot: root, runDir }
  const task = await prisma.cloudAgentTask.create({ data: { appId: 'KugouLive', title: 'approved-ui-test', material: '', targetBranch: 'kan-fx-release', status: 'translating', stage: 'coding', harnessJson: JSON.stringify({ workspace, review: null }) } })
  const approval = await prisma.cloudAgentApproval.create({ data: { taskId: task.id, revision: 1, actorId: actor.id, digest: review.digest, decision: 'ui', reason: 'fixture', payload: JSON.stringify(review) } })
  const parity = { ui_review: { status: 'approved', approval_reference: `cloud-agent:${workspace.identity}:approval:${approval.id}` } }
  const url = new URL(`http://localhost/review-file?digest=${review.digest}&file=html&preview=html`)
  try {
    assert.deepEqual((await getCloudTask(actor, task.id)).approvedReviews, [], 'DB decision alone is not an applied native approval')
    await writeFile(path.join(runDir, 'parity-matrix.json'), JSON.stringify(parity))
    const detail = await getCloudTask(actor, task.id)
    assert.equal(detail.review, null)
    assert.equal(detail.approvedReviews?.[0].kind, 'ui')
    assert.equal(detail.approvedReviews?.[0].files[0].id, 'html')
    assert.doesNotMatch(JSON.stringify(detail.approvedReviews), /sha256|\.html|artifactRoot/)
    assert.ok(!detail.actions.includes('approve'))
    const preview = await (await downloadReviewFile(actor, task.id, url)).json()
    assert.match(preview.html, /Approved full UI/); assert.doesNotMatch(preview.html, /<script/)
    await assert.rejects(downloadReviewFile({ id: 'other', appIds: [] }, task.id, url), /权限/)
    await assert.rejects(decideCloudTask(actor, task.id, { action: 'approve', revision: 1, digest: review.digest }), /变化/)
    await writeFile(file, 'modified')
    await assert.rejects(downloadReviewFile(actor, task.id, url), /已变化/)
    await writeFile(file, html)
    await prisma.cloudAgentTask.update({ where: { id: task.id }, data: { materialVersion: 2 } })
    assert.deepEqual((await getCloudTask(actor, task.id)).approvedReviews, [])
    await assert.rejects(downloadReviewFile(actor, task.id, url), /版本/)
    await prisma.cloudAgentTask.update({ where: { id: task.id }, data: { materialVersion: 1, harnessJson: JSON.stringify({ workspace: { ...workspace, identity: 'other-workspace' }, review: null }) } })
    assert.deepEqual((await getCloudTask(actor, task.id)).approvedReviews, [])
    await assert.rejects(downloadReviewFile(actor, task.id, url), /版本/)
    assert.equal(await prisma.cloudAgentApproval.count({ where: { taskId: task.id } }), 1)
  } finally { await removeWorkspaceFixture(task.id) }
})

test('lifecycle statistics cover all scoped pages, keep failures in analysis and ignore current status filter', async () => {
  const marker = 'lifecycle-count-fixture'
  const values = ['queued', 'awaiting_input', 'running', 'blocked', 'failed', 'cancelling', 'awaiting_approval', 'approved', 'cancelled']
  try {
    await prisma.cloudAgentTask.createMany({ data: [...Array.from({ length: 35 }, () => 'queued'), ...values].map(status => ({ appId: 'KugouLive', title: marker, material: '', targetBranch: 'kan-fx-release', status })) })
    await prisma.cloudAgentTask.create({ data: { appId: 'KugouPlayer', title: marker, material: '', targetBranch: 'live-ktv-merge', status: 'running' } })
    const list = await listCloudTasks(actor, new URL(`http://localhost/tasks?q=${marker}&page=2&stage=preparation`))
    assert.equal(list.items.length, 7)
    assert.equal(list.total, 37)
    assert.deepEqual(list.summary.byStage, { preparation: 37, analysis: 4, approval: 1, ready: 1, coding: 0, review: 0, build: 0, device: 0, integration: 0, knowledge: 0 })
    assert.equal(list.summary.total, 44)
    assert.equal(list.summary.byStatus.cancelled, 1)
    const filtered = await listCloudTasks(actor, new URL(`http://localhost/tasks?q=${marker}&status=blocked`))
    assert.equal(filtered.total, 1)
    assert.deepEqual(filtered.summary, list.summary)
    assert.equal((await listCloudTasks({ id: 'outsider', appIds: [] }, new URL(`http://localhost/tasks?q=${marker}`))).summary.total, 0)
    const byId = await listCloudTasks(actor, new URL(`http://localhost/tasks?q=${filtered.items[0].id}`))
    assert.equal(byId.total, 1)
    assert.equal((await listCloudTasks(actor, new URL('http://localhost/tasks?stage=coding'))).total, 0)
    await assert.rejects(listCloudTasks(actor, new URL('http://localhost/tasks?stage=unknown')), /无效阶段/)
  } finally { await prisma.cloudAgentTask.deleteMany({ where: { title: marker } }) }
})

test('task lifecycle is scoped, approvals bind revision/digest, edits preserve history', async () => {
  await assert.rejects(createCloudTask({ id: 'outsider', appIds: [] }, material), /权限/)
  await assert.rejects(createCloudTask(actor, { ...material, targetBranch: 'live-ktv-merge' }), /分支/)
  const task = await createCloudTask(actor, material)
  assert.equal(task.model, 'gpt-6-astra')
  const claim = await claimCloudRun()
  assert.ok(claim)
  assert.equal(claim.task.id, task.id)
  assert.equal(await claimCloudRun(), null)
  await finishCloudRun(claim.run.id, 'wrong-lease', 'awaiting_approval', '# forged')
  assert.equal((await getCloudTask(actor, task.id)).status, 'running')
  await finishCloudRun(claim.run.id, claim.run.leaseToken, 'awaiting_approval', '# plan')
  const pending = await getCloudTask(actor, task.id)
  await assert.rejects(decideCloudTask(actor, task.id, { action: 'approve', revision: 1, digest: pending.runs[0].digest, reason: '旧方案' }), /旧流程/)
  const review = { kind: 'scope', digest: 'a'.repeat(64), materialVersion: 1, content: '# Synthetic scope', files: [], decision: 'approved' }
  const harnessJson = JSON.stringify({ workspace: { continuous: true, identity: 'db-fixture', materialVersion: 1 }, review })
  await prisma.cloudAgentTask.update({ where: { id: task.id }, data: { harnessJson } })
  await assert.rejects(decideCloudTask(actor, task.id, { action: 'approve', revision: 1, digest: 'b'.repeat(64), reason: '错误摘要' }), /失效/)
  const approved = await decideCloudTask(actor, task.id, { action: 'approve', revision: 1, digest: review.digest, reason: 'Synthetic test approval' })
  assert.equal(approved.status, 'review_queued')
  assert.equal(approved.revision, 2)
  assert.equal(await prisma.cloudAgentApproval.count({ where: { taskId: task.id } }), 1)
  const saved = await saveCloudMaterials(actor, task.id, { materialVersion: 1, material: '新增验收材料', attachmentIds: [] })
  assert.equal(saved.status, 'awaiting_input')
  assert.equal(saved.revision, 2)
  const revised = await decideCloudTask(actor, task.id, { action: 'retry', revision: 2 })
  assert.equal(revised.revision, 3)
  assert.equal(JSON.parse((await prisma.cloudAgentTask.findUniqueOrThrow({ where: { id: task.id } })).harnessJson).workspace.identity, 'db-fixture', 'retry must preserve the same archive until the worker archives changed scope')
  assert.equal(revised.runs[0].output, '# plan')
  await assert.rejects(decideCloudTask(actor, task.id, { action: 'approve', revision: 1, digest: pending.runs[0].digest, reason: 'stale' }), /变化/)
  await decideCloudTask(actor, task.id, { action: 'cancel', revision: 3 })
  assert.equal((await listCloudTasks({ id: 'outsider', appIds: [] }, new URL('http://localhost'))).total, 0)
  await assert.rejects(cloudEvents({ id: 'outsider', appIds: [] }, task.id, 0), /权限/)
})
test('cancellation wins over late successful output', async () => {
  const task = await createCloudTask(actor, material)
  const claim = await claimCloudRun()
  assert.ok(claim)
  await decideCloudTask(actor, task.id, { action: 'cancel', revision: 1 })
  await finishCloudRun(claim.run.id, claim.run.leaseToken, 'awaiting_approval', 'late')
  assert.equal((await getCloudTask(actor, task.id)).status, 'cancelled')
  await assert.rejects(decideCloudTask(actor, task.id, { action: 'retry', revision: 1 }), /变化/)
})
test('expired lease is blocked, not blindly replayed', async () => {
  const task = await createCloudTask(actor, material)
  const claim = await claimCloudRun()
  assert.ok(claim)
  await prisma.cloudAgentRun.update({ where: { id: claim.run.id }, data: { leaseUntil: new Date(0) } })
  await recoverCloudLeases()
  assert.equal((await getCloudTask(actor, task.id)).status, 'blocked')
  await assert.rejects(decideCloudTask(actor, task.id, { action: 'retry', revision: 1 }), /恢复/)
  await finishCloudRun(claim.run.id, claim.run.leaseToken, 'awaiting_approval', 'late')
  assert.equal((await getCloudTask(actor, task.id)).status, 'blocked')
})
test('MR inbox deduplicates retries, unrelated pushes do not create tasks', async () => {
  const event = { object_kind: 'merge_request', project: { id: 12, web_url: 'https://git.example/team/android' }, object_attributes: { iid: 7, state: 'merged', target_branch: 'release' } }
  await receiveCloudWebhook(event)
  await receiveCloudWebhook(event)
  await receiveCloudWebhook({ object_kind: 'push' })
  assert.equal(await prisma.cloudAgentInbox.count(), 1)
})
test('app config isolates branch families', () => {
  const live = cloudProject('KugouLive')
  assert.equal(live.defaultBranch, 'kan-fx-release')
  assert.equal(branchAllowed(live, 'kan-fx-feature-1'), true)
  assert.equal(branchAllowed(live, 'live-ktv-merge'), false)
  assert.equal(branchAllowed(live, 'kan-fx-release:refs/heads/main'), false)
})

test('MR verification freezes exact source, deduplicates and stops before coding', async () => {
  const deps = {
    sources: () => [{ id: 'android-nested', root: 'fixture', suffix: 'nested', branches: ['release'], projectIds: ['kugou-live'] }],
    projects: () => [{ ...cloudProject('KugouLive'), androidPrefixes: ['nested/profile'], mrTrigger: true }],
    identity: async () => ({ origin: 'https://git.example', repository: 'team/android', remote: 'https://git.example/team/android.git', sourcePrefix: '' }),
    get: async (_origin: string, endpoint: string): Promise<unknown> => endpoint.endsWith('/changes') ? { changes: [{ old_path: 'profile/Old.java', new_path: 'profile/New.java', diff: '+code' }], overflow: false }
      : endpoint.includes('/merge_requests/') ? { project_id: 12, iid: 7, state: 'merged', target_branch: 'release', merge_commit_sha: 'a'.repeat(40), title: 'MR fixture' }
        : { path_with_namespace: 'team/android' },
  }
  await processCloudInbox(deps)
  const tasks = await prisma.cloudAgentTask.findMany({ where: { source: 'android-mr' } })
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].status, 'queued')
  assert.equal(tasks[0].targetBranch, 'kan-fx-release')
  assert.equal(JSON.parse(tasks[0].sourceSnapshot).sourceId, 'android-nested')
  assert.equal(JSON.parse(tasks[0].sourceSnapshot).mergedSha, 'a'.repeat(40))
  await receiveCloudWebhook({ object_kind: 'merge_request', project: { id: 12, web_url: 'https://git.example/team/android' }, object_attributes: { iid: 7, state: 'merged', target_branch: 'release' } })
  await processCloudInbox(deps)
  assert.equal(await prisma.cloudAgentTask.count({ where: { source: 'android-mr' } }), 1)
  await prisma.cloudAgentTask.update({ where: { id: tasks[0].id }, data: { status: 'cancelled' } })
})

test('MR paths in a monorepo are scoped relative to the configured source directory', async () => {
  await receiveCloudWebhook({ object_kind: 'merge_request', project: { id: 14, web_url: 'https://git.example/team/mono' }, object_attributes: { iid: 8, state: 'merged', target_branch: 'release' } })
  await processCloudInbox({
    sources: () => [{ id: 'android-main', root: 'fixture/android', suffix: '', branches: ['release'], projectIds: ['kugou-live'] }],
    projects: () => [{ ...cloudProject('KugouLive'), androidPrefixes: ['profile'], mrTrigger: true }],
    identity: async () => ({ origin: 'https://git.example', repository: 'team/mono', remote: 'https://git.example/team/mono.git', sourcePrefix: 'android/' }),
    get: async (_origin: string, endpoint: string): Promise<unknown> => endpoint.endsWith('/changes') ? { changes: [
      { old_path: 'android/profile/Page.java', new_path: 'android/profile/Page.java', diff: '+allowed' },
      { old_path: 'profile/Page.java', new_path: 'profile/Page.java', diff: '+outside-source' },
      { old_path: 'android/other/Page.java', new_path: 'android/other/Page.java', diff: '+outside-app' },
    ], overflow: false } : endpoint.includes('/merge_requests/') ? { project_id: 14, iid: 8, state: 'merged', target_branch: 'release', merge_commit_sha: 'b'.repeat(40), title: 'monorepo fixture' }
      : { path_with_namespace: 'team/mono' },
  })
  const task = await prisma.cloudAgentTask.findFirstOrThrow({ where: { title: 'monorepo fixture' } })
  assert.match(task.material, /allowed/)
  assert.doesNotMatch(task.material, /outside-source|outside-app/)
  assert.equal(JSON.parse(task.sourceSnapshot).sourceId, 'android-main')
  await prisma.cloudAgentTask.update({ where: { id: task.id }, data: { status: 'cancelled' } })
})

test('foreign MR never receives a GitLab API request', async () => {
  await receiveCloudWebhook({ object_kind: 'merge_request', project: { id: 13, web_url: 'https://attacker.example/other/repo' }, object_attributes: { iid: 99, state: 'merged', target_branch: 'release' } })
  let called = false
  await processCloudInbox({ sources: () => [], projects: () => [], identity: async () => { throw new Error('unexpected') }, get: async () => { called = true; return {} } })
  assert.equal(called, false)
  assert.equal(await prisma.cloudAgentInbox.count({ where: { status: 'ignored' } }), 1)
})

test('cloud apps follow AI employee scopes and revalidate credentials without cache', async () => {
  const { requireCloudActor } = await import('./http')
  const { tokenCanAccessCloudApp } = await import('./access')
  const { listCloudApps } = await import('./git')
  const { hashToken } = await import('@/lib/token')
  const token = await prisma.apiToken.create({ data: { personName: 'fixture', personCode: 'fixture', tokenHash: hashToken('fixture-token') } })
  await prisma.apiTokenAppScope.create({ data: { tokenId: token.id, appScopeId: 'KugouLive' } })
  const request = new Request('http://localhost', { headers: { authorization: 'Bearer fixture-token' } })
  assert.deepEqual((await requireCloudActor(request)).appIds, ['KugouLive'])
  assert.equal(await tokenCanAccessCloudApp(token.id, 'KugouPlayer'), false)
  await prisma.apiTokenAppScope.deleteMany({ where: { tokenId: token.id } })
  const unrestricted = await requireCloudActor(request)
  assert.deepEqual(unrestricted.appIds.sort(), ['KugouLive', 'KugouPlayer'].sort())
  assert.deepEqual((await listCloudApps(unrestricted)).map(app => app.id).sort(), unrestricted.appIds.sort())
  assert.equal(await tokenCanAccessCloudApp(token.id, 'KugouLive'), true)
  assert.equal(await tokenCanAccessCloudApp(token.id, 'KugouPlayer'), true)
  const created = await createCloudTask(unrestricted, material)
  await removeWorkspaceFixture(created.id)
  await prisma.apiTokenAppScope.create({ data: { tokenId: token.id, appScopeId: 'RemovedApp' } })
  assert.deepEqual((await requireCloudActor(request)).appIds.sort(), unrestricted.appIds)
  await prisma.apiTokenAppScope.deleteMany({ where: { tokenId: token.id } })
  await prisma.apiToken.update({ where: { id: token.id }, data: { revokedAt: new Date() } })
  await assert.rejects(requireCloudActor(request), /失效/)
  assert.equal(await tokenCanAccessCloudApp(token.id, 'KugouLive'), false)
  await prisma.apiToken.update({ where: { id: token.id }, data: { revokedAt: null, expiresAt: new Date(Date.now() - 1000) } })
  await assert.rejects(requireCloudActor(request), /失效/)
  assert.equal(await tokenCanAccessCloudApp(token.id, 'KugouLive'), false)
})

test('attachment-only creation, access isolation, immutable active snapshot and stale approvals', async () => {
  const data = Buffer.from('MainMeFragment document evidence')
  const request = () => new Request('http://localhost/attachments?appId=KugouLive&name=requirement.md', { method: 'POST', headers: { 'content-length': String(data.length) }, body: data })
  await assert.rejects(uploadCloudMaterial({ id: 'outsider', appIds: [] }, request()), /权限/)
  const file = await uploadCloudMaterial(actor, request())
  assert.equal(file.kind, 'document')
  assert.equal(file.sha256.length, 64)
  await assert.rejects(downloadCloudMaterial({ id: 'other', appIds: ['KugouLive'] }, file.id), /权限/)
  await assert.rejects(createCloudTask({ id: 'other', appIds: ['KugouLive'] }, { ...material, material: '', attachmentIds: [file.id] }), /无权/)
  const task = await createCloudTask(actor, { ...material, material: '', attachmentIds: [file.id] })
  assert.equal(task.attachments[0].id, file.id)
  const download = await downloadCloudMaterial({ id: 'colleague', appIds: ['KugouLive'] }, file.id)
  assert.equal(await download.text(), data.toString())
  await assert.rejects(downloadCloudMaterial({ id: 'outsider', appIds: ['KugouPlayer'] }, file.id), /权限/)
  await assert.rejects(createCloudTask(actor, { ...material, attachmentIds: [file.id] }), /无权/)
  const tools = await materialTools([file], new AbortController().signal, path.join(directory, 'tool-output'))
  const content = await tools.tools.find(tool => tool.definition.name === 'read_material')!.call({ id: file.id })
  assert.match(JSON.stringify(content), /MainMeFragment/)
  const claim = await claimCloudRun()
  assert.equal(claim?.task.id, task.id)
  assert.equal(JSON.parse(claim!.run.attachmentSnapshot)[0].sha256, file.sha256)
  const edit = { materialVersion: 1, material: 'additional evidence', attachmentIds: [] }
  const saved = await saveCloudMaterials(actor, task.id, edit)
  assert.equal(saved.status, 'running')
  assert.equal(saved.materialVersion, 2)
  assert.equal(saved.revision, 1)
  assert.equal(saved.attachments.length, 0)
  await assert.rejects(saveCloudMaterials(actor, task.id, edit), /其他人更新/)
  await finishCloudRun(claim!.run.id, claim!.run.leaseToken, 'awaiting_approval', 'old result')
  const stale = await getCloudTask(actor, task.id)
  assert.equal(stale.status, 'awaiting_input')
  assert.equal(stale.runs[0].materialVersion, 1)
  assert.equal(stale.runs[0].attachments[0].id, file.id)
  await assert.rejects(decideCloudTask(actor, task.id, { action: 'approve', revision: 1, digest: stale.runs[0].digest, reason: 'stale' }), /变化|失效/)
  await decideCloudTask(actor, task.id, { action: 'retry', revision: 1 })
  const latest = await claimCloudRun()
  assert.equal(latest?.run.materialVersion, 2)
  assert.equal(latest?.run.materialSnapshot, 'additional evidence')
  assert.equal(latest?.run.attachmentSnapshot, '[]')
  await decideCloudTask(actor, task.id, { action: 'cancel', revision: 2 })
  await finishCloudRun(latest!.run.id, latest!.run.leaseToken, 'awaiting_approval', 'late')
  const cancelled = await saveCloudMaterials(actor, task.id, { materialVersion: 2, material: 'retained', attachmentIds: [file.id] })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.materialVersion, 3)
  const old = await uploadCloudMaterial(actor, request())
  await prisma.cloudAgentAttachment.updateMany({ where: { id: { in: [old.id, file.id] } }, data: { createdAt: new Date(0) } })
  await cleanupStagedMaterials()
  assert.equal(await prisma.cloudAgentAttachment.findUnique({ where: { id: old.id } }), null)
  assert.ok(await prisma.cloudAgentAttachment.findUnique({ where: { id: file.id } }), 'history attachment must survive cleanup')
  assert.equal(await (await downloadCloudMaterial(actor, file.id)).text(), data.toString())
})

test('oversized, forged, truncated and unsupported uploads leave no staged records', async () => {
  const initial = await prisma.cloudAgentAttachment.count()
  for (const [name, size, body] of [['a.png', '99999999', 'x'], ['a.png', '5', 'false'], ['a.md', '1', 'too long'], ['a.md', '999', 'short'], ['a.svg', '4', '<svg'], ['a.mp4', '4', 'fake']]) {
    await assert.rejects(uploadCloudMaterial(actor, new Request(`http://localhost/attachments?appId=KugouLive&name=${name}`, { method: 'POST', headers: { 'content-length': size }, body })))
  }
  assert.equal(await prisma.cloudAgentAttachment.count(), initial)
})

test('translation requires current approval, claims separately, preserves history and cancels without completion', async () => {
  const task = await createCloudTask(actor, material)
  await assert.rejects(decideCloudTask(actor, task.id, { action: 'translate', revision: 1 }), /变化/)
  const analysis = await claimCloudRun()
  assert.equal(analysis?.run.kind, 'analysis')
  await prisma.cloudAgentRun.update({ where: { id: analysis!.run.id }, data: { baseSha: 'a'.repeat(40) } })
  await finishCloudRun(analysis!.run.id, analysis!.run.leaseToken, 'awaiting_approval', '# Approved candidate')
  const pending = await getCloudTask(actor, task.id)
  await assert.rejects(decideCloudTask(actor, task.id, { action: 'approve', revision: 1, digest: pending.runs[0].digest, reason: 'legacy' }), /旧流程/)
  await prisma.cloudAgentTask.update({ where: { id: task.id }, data: { status: 'approved', harnessJson: JSON.stringify({ workspace: { continuous: true, materialVersion: 1 }, status: { nodes: [{ id: 'ui_prototype_approved', status: 'passed' }] } }) } })
  assert.equal((await decideCloudTask(actor, task.id, { action: 'translate', revision: 1 })).status, 'translation_queued')
  const first = await claimCloudRun()
  assert.equal(first?.run.kind, 'translation')
  assert.equal((await getCloudTask(actor, task.id)).status, 'translating')
  await finishCloudRun(first!.run.id, first!.run.leaseToken, 'harness_waiting', 'Waiting for UI review')
  await assert.rejects(decideCloudTask(actor, task.id, { action: 'resume_translation', revision: 2 }), /原生档案路径/)
  const { harnessRoot } = await import('./harness')
  const fixtureScript = `import sys,json,tempfile
sys.path.insert(0,sys.argv[1])
import test_migration_harness as f
original=tempfile.TemporaryDirectory
tempfile.TemporaryDirectory=lambda: original(dir=sys.argv[2])
c=f.MigrationHarnessTests(); c.setUp(); c.mark_context(); c.mark_evidence(); c.mark_scope(); c.mark_ui_approved()
m=c.read('manifest'); print(json.dumps({'run':str(c.run_dir.resolve()),'manifest':m}))
c.temporary._finalizer.detach()`
  const fixture = JSON.parse(execFileSync('python', ['-B', '-c', fixtureScript, path.join(harnessRoot(), 'skills/android-to-harmony-feature-rollout/tests'), directory], { encoding: 'utf8', windowsHide: true }))
  const m = fixture.manifest
  const workspace = { continuous: true, materialVersion: 1, artifactRoot: m.artifact_root, runDir: fixture.run, androidRoot: m.android.root, harmonyRoot: m.harmony.root, branch: m.harmony.branch, baseSha: m.harmony.head }
  await prisma.cloudAgentTask.update({ where: { id: task.id }, data: { harnessJson: JSON.stringify({ workspace, status: { phase: 'context_ready', nodes: [] } }) } })
  await decideCloudTask(actor, task.id, { action: 'resume_translation', revision: 2 })
  const resumed = await prisma.cloudAgentTask.findUniqueOrThrow({ where: { id: task.id } })
  assert.equal(resumed.stage, 'coding')
  assert.ok(JSON.parse(resumed.harnessJson).status.nodes.some((node: { id: string; status: string }) => node.id === 'ui_prototype_approved' && node.status === 'passed'))
  const second = await claimCloudRun()
  assert.equal(second?.run.revision, 3)
  await decideCloudTask(actor, task.id, { action: 'cancel', revision: 3 })
  await finishCloudRun(second!.run.id, second!.run.leaseToken, 'code_ready', 'late success')
  const cancelled = await getCloudTask(actor, task.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.runs.length, 1)
  const history = await listCloudRuns(actor, task.id, new URL('http://localhost/runs'))
  assert.equal(history.items.length, 3)
  assert.equal(history.items[1].output, 'Waiting for UI review')
})

test('global SSE scopes changes, replays cursor and revalidates revoked credentials', async () => {
  const { streamCloudEvents } = await import('./events')
  const { hashToken } = await import('@/lib/token')
  const token = await prisma.apiToken.create({ data: { personName: 'SSE fixture', personCode: 'sse-fixture', tokenHash: hashToken('sse-fixture') } })
  await prisma.apiTokenAppScope.create({ data: { tokenId: token.id, appScopeId: 'KugouLive' } })
  const own = await prisma.cloudAgentTask.create({ data: { appId: 'KugouLive', title: 'own SSE', material: '', targetBranch: 'kan-fx-release', status: 'blocked' } })
  const other = await prisma.cloudAgentTask.create({ data: { appId: 'KugouPlayer', title: 'private SSE', material: '', targetBranch: 'live-ktv-merge', status: 'blocked' } })
  const request = (after?: number) => new Request(`http://localhost/events${after === undefined ? '' : `?after=${after}`}`, { headers: { authorization: 'Bearer sse-fixture' } })
  const response = await streamCloudEvents(request())
  const reader = response.body!.getReader()
  const initial = new TextDecoder().decode((await reader.read()).value)
  const cursor = JSON.parse(initial.split('data: ')[1].trim()).cursor
  await reader.cancel()
  await prisma.cloudAgentEvent.create({ data: { taskId: other.id, kind: 'harness', message: 'private data' } })
  const change = await prisma.cloudAgentEvent.create({ data: { taskId: own.id, kind: 'harness', message: 'own data' } })
  const replay = (await streamCloudEvents(request(cursor))).body!.getReader()
  let received = ''
  try {
    for (let i = 0; i < 5 && !received.includes(`id: ${change.id}\n`); i++) received += new TextDecoder().decode((await replay.read()).value)
    assert.match(received, new RegExp(own.id))
    assert.ok(!received.includes(other.id) && !received.includes('private data'))
    await prisma.apiToken.update({ where: { id: token.id }, data: { revokedAt: new Date() } })
    for (let i = 0; i < 5 && !received.includes('auth-or-stream-error'); i++) received += new TextDecoder().decode((await replay.read()).value)
    assert.match(received, /auth-or-stream-error/)
  } finally { await replay.cancel() }
})

test('only the owner can delete an idle task, and deletion removes its records', async () => {
  const task = await prisma.cloudAgentTask.create({ data: { ...material, status: 'cancelled', creatorId: actor.id, material: 'synthetic', attachmentIds: '[]' } })
  await prisma.cloudAgentEvent.create({ data: { taskId: task.id, kind: 'note', message: 'synthetic' } })
  await prisma.cloudAgentNotification.create({ data: { identity: `delete-${task.id}`, taskId: task.id, stateKey: 'delete' } })
  const removed: string[] = []
  await deleteCloudTask(actor, task.id, async plan => { removed.push(plan.id) })
  assert.deepEqual(removed, [task.id])
  assert.equal(await prisma.cloudAgentTask.findUnique({ where: { id: task.id } }), null)
  assert.equal(await prisma.cloudAgentEvent.count({ where: { taskId: task.id } }), 0)
  assert.equal(await prisma.cloudAgentNotification.count({ where: { taskId: task.id } }), 0)
  const other = await prisma.cloudAgentTask.create({ data: { ...material, status: 'cancelled', creatorId: 'someone-else', material: 'synthetic' } })
  const busy = await prisma.cloudAgentTask.create({ data: { ...material, status: 'running', creatorId: actor.id, material: 'synthetic' } })
  try {
    await assert.rejects(deleteCloudTask(actor, other.id, async () => { throw new Error('should not remove') }), /只能删除自己创建的任务/)
    await assert.rejects(deleteCloudTask(actor, busy.id, async () => { throw new Error('should not remove') }), /仍在执行/)
  } finally {
    await prisma.cloudAgentTask.delete({ where: { id: other.id } })
    await prisma.cloudAgentTask.delete({ where: { id: busy.id } })
  }
})
