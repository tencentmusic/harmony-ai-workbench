#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const projectRoot = path.resolve(import.meta.dirname, '..')
const schemaPath = path.join(projectRoot, 'prisma/schema.prisma')
const storePath = path.join(projectRoot, 'src/server/modules/integration/integration-store.ts')
const schema = readFileSync(schemaPath, 'utf8')
const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))

function getModelBlock(name) {
  const match = schema.match(new RegExp(`model\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`))
  assert.ok(match, `schema must define model ${name}`)
  return match[1]
}

const taskModel = getModelBlock('IntegrationTask')
const runModel = getModelBlock('IntegrationRun')
const artifactModel = getModelBlock('IntegrationArtifact')
const eventModel = getModelBlock('IntegrationTaskEvent')
const tokenModel = getModelBlock('ApiToken')

for (const field of [
  'id', 'title', 'projectId', 'sourceBranch', 'targetBranch', 'scopePath',
  'featureDesc', 'status', 'automationStatus', 'createdByTokenId', 'createdAt', 'updatedAt',
]) {
  assert.match(taskModel, new RegExp(`\\b${field}\\b`), `IntegrationTask must contain ${field}`)
}
assert.match(taskModel, /\bruns\s+IntegrationRun\[\]/)
assert.match(taskModel, /\bevents\s+IntegrationTaskEvent\[\]/)
assert.match(taskModel, /\bcreator\s+ApiToken\?/)
assert.match(tokenModel, /\bcreatedIntegrationTasks\s+IntegrationTask\[\]/)
assert.match(
  tokenModel,
  /\bupdatedIntegrationArtifactReviewNotes\s+IntegrationArtifact\[\]\s+@relation\("IntegrationArtifactReviewNoteUpdater"\)/,
)

for (const field of [
  'id', 'taskId', 'stage', 'sequence', 'triggerKey', 'status', 'baseSha', 'headSha',
  'targetTipSha', 'diffHash', 'claimOwner', 'claimEpoch', 'claimExpiresAt', 'worktreeStatus',
  'worktreePath', 'worktreeLeaseCipher', 'opencodeDisposedAt',
  'opencodeDisposeErrorCode', 'opencodeDisposeError', 'errorCode', 'error',
  'cleanupStatus', 'cleanupSafeAt',
  'cleanupCompletedAt', 'cleanupErrorCode', 'cleanupError', 'startedAt', 'finishedAt',
  'createdAt', 'updatedAt',
]) {
  assert.match(runModel, new RegExp(`\\b${field}\\b`), `IntegrationRun must contain ${field}`)
}
assert.match(runModel, /\btriggerKey\s+String\s+@unique/)
assert.match(runModel, /\bclaimEpoch\s+Int\s+@default\(0\)/)
assert.doesNotMatch(runModel, /\bopencodeSessionIds\b/)
assert.doesNotMatch(runModel, /worktreeLeaseToken/)
assert.match(runModel, /@@unique\(\[taskId,\s*sequence\]\)/)
assert.match(runModel, /@@index\(\[status,\s*claimExpiresAt\]\)/)
assert.match(runModel, /@@index\(\[cleanupStatus,\s*claimExpiresAt\]\)/)

for (const field of [
  'id', 'runId', 'type', 'status', 'outputPath', 'skillName', 'skillDigest',
  'opencodeSessionId', 'promptState', 'promptSubmittedAt', 'promptAcceptedAt',
  'promptAcceptanceUnknownAt', 'promptRejectedAt', 'abortRequestedAt', 'abortRespondedAt', 'abortAccepted',
  'abortErrorCode', 'abortError',
  'terminalAckSource', 'terminalAckAt', 'sessionDeletedAt',
  'sessionDeleteErrorCode', 'sessionDeleteError', 'content', 'conclusion',
  'reviewNote', 'reviewNoteUpdatedAt', 'reviewNoteUpdatedByTokenId',
  'errorCode', 'error',
  'startedAt', 'finishedAt', 'createdAt', 'updatedAt',
]) {
  assert.match(artifactModel, new RegExp(`\\b${field}\\b`), `IntegrationArtifact must contain ${field}`)
}
assert.match(artifactModel, /\bcontent\s+String\?/)
assert.match(artifactModel, /\breviewNote\s+String\?/)
assert.match(artifactModel, /\breviewNoteUpdatedAt\s+DateTime\?/)
assert.match(artifactModel, /\breviewNoteUpdatedByTokenId\s+String\?/)
assert.match(
  artifactModel,
  /\breviewNoteUpdatedBy\s+ApiToken\?\s+@relation\("IntegrationArtifactReviewNoteUpdater"[\s\S]*onDelete:\s*SetNull/,
)
assert.match(artifactModel, /\boutputPath\s+String(?:\s|$)/)
assert.match(artifactModel, /\bskillName\s+String(?:\s|$)/)
assert.match(artifactModel, /\bopencodeSessionId\s+String\?\s+@unique/)
assert.match(artifactModel, /@@unique\(\[runId,\s*type\]\)/)
assert.match(artifactModel, /@@index\(\[runId,\s*status\]\)/)
assert.match(eventModel, /\btask\s+IntegrationTask\s+@relation/)

assert.match(
  packageJson.scripts?.['test:integration-store'] || '',
  /test-integration-store-contract\.mjs/,
)
assert.ok(existsSync(storePath))
const storeSource = readFileSync(storePath, 'utf8')
assert.doesNotMatch(storeSource, /CREATE\s+TABLE|ALTER\s+TABLE/i)
assert.doesNotMatch(storeSource, /failRunningIntegrationRunsOnStartup/)
assert.doesNotMatch(storeSource, /updateIntegrationRunOpencodeSessionIds/)
assert.doesNotMatch(storeSource, /upsertIntegrationArtifact/)
assert.doesNotMatch(storeSource, /export\s+async\s+function\s+updateIntegrationTaskStatus/)
assert.doesNotMatch(storeSource, /worktreeLeaseToken/)

const expectedExports = [
  'listIntegrationTasks', 'getIntegrationTask', 'getIntegrationRunForExecution',
  'createIntegrationTask', 'deleteIntegrationTask',
  'transitionIntegrationTaskStatus', 'createIntegrationRun', 'retryLatestIntegrationRun',
  'rerunIntegrationStage', 'updateIntegrationArtifactReviewNote',
  'claimQueuedIntegrationRun',
  'claimIntegrationRunForRecovery', 'renewIntegrationRunClaim', 'releaseIntegrationRunClaim',
  'listQueuedIntegrationRuns', 'listIntegrationCleanupCandidates',
  'listIntegrationRunRecoveryCandidates', 'lockIntegrationRunSnapshot',
  'tryReuseIntegrationFinalReview',
  'prepareIntegrationRunWorktree', 'markIntegrationRunWorktreeActive',
  'markIntegrationArtifactRunning',
  'attachIntegrationArtifactSession', 'markIntegrationArtifactPromptSubmitted',
  'markIntegrationArtifactPromptAccepted', 'markIntegrationArtifactPromptAcceptanceUnknown',
  'markIntegrationArtifactPromptRejected',
  'markIntegrationArtifactAbortRequested', 'recordIntegrationArtifactAbortResponse',
  'recordIntegrationArtifactAbortFailure',
  'acknowledgeIntegrationArtifactTerminal', 'finishIntegrationArtifactSuccess',
  'finishIntegrationArtifactFailure', 'finishIntegrationRunFromArtifacts',
  'recordIntegrationArtifactSessionDeleted',
  'recordIntegrationArtifactSessionDeleteFailure',
  'recordIntegrationRunOpencodeDisposed',
  'recordIntegrationRunOpencodeDisposeFailure',
  'failIntegrationRunExecution',
  'markIntegrationRunCleanupPending', 'markIntegrationRunCleanupSafeIfTerminal',
  'beginIntegrationRunCleanup',
  'claimIntegrationRunCleanup', 'finishIntegrationRunCleanup', 'failIntegrationRunCleanup',
]

const tempRoot = mkdtempSync(path.join(tmpdir(), 'integration-store-contract-'))
const databasePath = path.join(tempRoot, 'store.db')
process.env.DATABASE_URL = `file:${databasePath}`
let prisma

function claimOf(run) {
  return { owner: run.claimOwner, epoch: run.claimEpoch }
}

async function expectFenced(operation) {
  await assert.rejects(operation, /CLAIM_STALE/)
}

async function markRunTerminal(run, {
  status = 'succeeded',
  cleanupStatus = 'completed',
  at = new Date('2026-07-20T00:30:00.000Z'),
} = {}) {
  await prisma.integrationArtifact.updateMany({
    where: { runId: run.id },
    data: { status },
  })
  const updated = await prisma.integrationRun.update({
    where: { id: run.id },
    data: {
      status,
      cleanupStatus,
      cleanupCompletedAt: cleanupStatus === 'completed' ? at : null,
      worktreeStatus: cleanupStatus === 'completed' ? 'cleaned' : 'none',
      worktreePath: null,
      worktreeLeaseCipher: null,
      claimOwner: null,
      claimExpiresAt: null,
      finishedAt: at,
    },
  })
  await prisma.integrationTask.update({
    where: { id: run.taskId },
    data: { automationStatus: status },
  })
  return updated
}

try {
  const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const dbPush = spawnSync(
    npxCommand,
    ['prisma', 'db', 'push', '--schema', schemaPath, '--skip-generate'],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, RUST_LOG: 'info' },
      shell: process.platform === 'win32',
    },
  )
  assert.equal(dbPush.status, 0, `${dbPush.stdout || ''}\n${dbPush.stderr || ''}`)

  const store = await import('../src/server/modules/integration/integration-store.ts')
  for (const name of expectedExports) {
    assert.equal(typeof store[name], 'function', `integration store must export ${name}`)
  }
  ;({ prisma } = await import('../src/lib/prisma.ts'))

  await prisma.apiToken.create({
    data: {
      id: 'integration-token',
      personName: '集成负责人',
      personCode: 'integration-owner',
      tokenHash: 'integration-store-contract-token',
    },
  })

  await assert.rejects(
    store.deleteIntegrationTask('missing-delete-task'),
    /TASK_NOT_FOUND/,
  )

  const mistakenDeleteTask = await store.createIntegrationTask({
    title: '录入错误可直接删除',
    projectId: 'ktv',
    sourceBranch: 'feature/delete-developing',
    targetBranch: 'kan-develop',
  })
  await store.deleteIntegrationTask(mistakenDeleteTask.id)
  assert.equal(
    await prisma.integrationTask.findUnique({ where: { id: mistakenDeleteTask.id } }),
    null,
    '没有运行记录的错误任务应能直接删除，不受业务状态限制',
  )

  const closedDeleteTask = await store.createIntegrationTask({
    title: '关闭任务删除事件',
    projectId: 'ktv',
    sourceBranch: 'feature/delete-closed',
    targetBranch: 'kan-develop',
  })
  await store.transitionIntegrationTaskStatus({
    taskId: closedDeleteTask.id,
    status: 'closed',
    actorTokenId: 'integration-token',
  })
  await store.deleteIntegrationTask(closedDeleteTask.id)
  assert.equal(
    await prisma.integrationTask.findUnique({ where: { id: closedDeleteTask.id } }),
    null,
  )
  assert.equal(
    await prisma.integrationTaskEvent.count({ where: { taskId: closedDeleteTask.id } }),
    0,
    '删除任务必须级联删除状态事件',
  )

  const cleanupBlockedDeleteTask = await store.createIntegrationTask({
    title: '清理完成前禁止删除',
    projectId: 'ktv',
    sourceBranch: 'feature/delete-cleanup-pending',
    targetBranch: 'kan-develop',
  })
  const cleanupBlockedDeleteRun = await store.createIntegrationRun({
    taskId: cleanupBlockedDeleteTask.id,
    stage: 'pre_merge_review',
    triggerKey: `delete-guard:${cleanupBlockedDeleteTask.id}:1`,
  })
  await assert.rejects(
    store.deleteIntegrationTask(cleanupBlockedDeleteTask.id),
    /TASK_DELETE_BLOCKED/,
  )
  await prisma.integrationRun.update({
    where: { id: cleanupBlockedDeleteRun.id },
    data: {
      status: 'failed',
      cleanupStatus: 'completed',
      cleanupCompletedAt: new Date('2026-07-20T00:00:00.000Z'),
      worktreeStatus: 'cleaned',
      claimOwner: 'worker-still-releasing',
      claimExpiresAt: new Date('2099-07-20T00:01:00.000Z'),
    },
  })
  await prisma.integrationArtifact.updateMany({
    where: { runId: cleanupBlockedDeleteRun.id },
    data: { status: 'failed' },
  })
  await assert.rejects(
    store.deleteIntegrationTask(cleanupBlockedDeleteTask.id),
    /TASK_DELETE_BLOCKED/,
    'cleanup completed 但 claim 尚未释放时仍不得删除',
  )
  await prisma.integrationRun.update({
    where: { id: cleanupBlockedDeleteRun.id },
    data: {
      claimExpiresAt: new Date('2000-07-20T00:01:00.000Z'),
    },
  })
  await store.deleteIntegrationTask(cleanupBlockedDeleteTask.id)
  assert.equal(
    await prisma.integrationRun.count({ where: { taskId: cleanupBlockedDeleteTask.id } }),
    0,
    '删除任务必须级联删除运行与产物',
  )
  assert.equal(
    await prisma.integrationArtifact.count({ where: { runId: cleanupBlockedDeleteRun.id } }),
    0,
  )

  const mergedDeleteTask = await store.createIntegrationTask({
    title: '已合入允许删除',
    projectId: 'ktv',
    sourceBranch: 'feature/delete-merged',
    targetBranch: 'kan-develop',
  })
  await prisma.integrationTask.update({
    where: { id: mergedDeleteTask.id },
    data: { status: 'merged' },
  })
  await store.deleteIntegrationTask(mergedDeleteTask.id)
  assert.equal(await store.getIntegrationTask(mergedDeleteTask.id), null)

  const reuseTask = await store.createIntegrationTask({
    title: '待合入复用提测审查',
    projectId: 'ktv',
    sourceBranch: 'feature/reuse-review',
    targetBranch: 'kan-develop',
  })
  const reusableSubmitRun = await store.createIntegrationRun({
    taskId: reuseTask.id,
    stage: 'submit_review_and_tests',
    triggerKey: `reuse-source:${reuseTask.id}`,
  })
  const reusableInitialReview = await prisma.integrationArtifact.findFirst({
    where: { runId: reusableSubmitRun.id, type: 'initial_review' },
  })
  assert.ok(reusableInitialReview)
  await prisma.integrationArtifact.updateMany({
    where: { runId: reusableSubmitRun.id },
    data: { status: 'succeeded' },
  })
  await prisma.integrationArtifact.update({
    where: { id: reusableInitialReview.id },
    data: {
      content: '# 首轮审查\n\n代码快照未发生变化。',
      conclusion: '通过',
      skillDigest: 'reused-review-digest',
    },
  })
  await prisma.integrationRun.update({
    where: { id: reusableSubmitRun.id },
    data: {
      status: 'succeeded',
      headSha: 'reuse-head',
      diffHash: 'reuse-diff',
      cleanupStatus: 'completed',
      cleanupCompletedAt: new Date('2026-07-20T00:10:00.000Z'),
      worktreeStatus: 'cleaned',
      finishedAt: new Date('2026-07-20T00:10:00.000Z'),
    },
  })
  const reusableMergeRun = await store.createIntegrationRun({
    taskId: reuseTask.id,
    stage: 'pre_merge_review',
    triggerKey: `reuse-target:${reuseTask.id}`,
  })
  const reusableFinalReview = await prisma.integrationArtifact.findFirst({
    where: { runId: reusableMergeRun.id, type: 'final_review' },
  })
  assert.ok(reusableFinalReview)
  const reusableClaim = await store.claimQueuedIntegrationRun({
    runId: reusableMergeRun.id,
    owner: 'reuse-worker',
    leaseMs: 60_000,
    now: new Date('2026-07-20T00:11:00.000Z'),
  })
  assert.ok(reusableClaim)
  const reusableFence = claimOf(reusableClaim)
  await store.lockIntegrationRunSnapshot({
    runId: reusableMergeRun.id,
    ...reusableFence,
    baseSha: 'reuse-base',
    headSha: 'reuse-head',
    targetTipSha: 'reuse-target',
    diffHash: 'reuse-diff',
    now: new Date('2026-07-20T00:11:01.000Z'),
  })
  assert.equal(
    await store.tryReuseIntegrationFinalReview({
      runId: reusableMergeRun.id,
      artifactId: reusableFinalReview.id,
      ...reusableFence,
      headSha: 'reuse-head',
      diffHash: 'changed-diff',
      now: new Date('2026-07-20T00:11:02.000Z'),
    }),
    false,
    'diff 变化时不得复用提测审查',
  )
  assert.equal(
    await store.tryReuseIntegrationFinalReview({
      runId: reusableMergeRun.id,
      artifactId: reusableFinalReview.id,
      ...reusableFence,
      headSha: 'reuse-head',
      diffHash: 'reuse-diff',
      now: new Date('2026-07-20T00:11:03.000Z'),
    }),
    true,
  )
  const reusedFinalReview = await prisma.integrationArtifact.findUniqueOrThrow({
    where: { id: reusableFinalReview.id },
  })
  assert.equal(reusedFinalReview.status, 'succeeded')
  assert.equal(reusedFinalReview.content, '# 首轮审查\n\n代码快照未发生变化。')
  assert.equal(reusedFinalReview.conclusion, '通过')
  assert.equal(reusedFinalReview.skillDigest, 'reused-review-digest')
  assert.equal(reusedFinalReview.opencodeSessionId, null)
  assert.equal(reusedFinalReview.promptState, 'not_submitted')
  await store.finishIntegrationRunFromArtifacts({
    runId: reusableMergeRun.id,
    ...reusableFence,
    now: new Date('2026-07-20T00:11:04.000Z'),
  })
  const reusableCleanupGate = await store.markIntegrationRunCleanupSafeIfTerminal({
    runId: reusableMergeRun.id,
    ...reusableFence,
    now: new Date('2026-07-20T00:11:05.000Z'),
  })
  assert.equal(reusableCleanupGate.safe, true)
  await store.beginIntegrationRunCleanup({
    runId: reusableMergeRun.id,
    ...reusableFence,
    now: new Date('2026-07-20T00:11:06.000Z'),
  })
  await store.finishIntegrationRunCleanup({
    runId: reusableMergeRun.id,
    ...reusableFence,
    now: new Date('2026-07-20T00:11:07.000Z'),
  })

  const task = await store.createIntegrationTask({
    title: '原子状态触发',
    projectId: 'ktv',
    sourceBranch: 'feature/atomic-transition',
    targetBranch: 'kan-develop',
    createdByTokenId: 'integration-token',
  })
  const concurrentTransitions = await Promise.all([
    store.transitionIntegrationTaskStatus({
      taskId: task.id,
      status: 'submitted',
      actorTokenId: 'integration-token',
    }),
    store.transitionIntegrationTaskStatus({
      taskId: task.id,
      status: 'submitted',
      actorTokenId: 'integration-token',
    }),
  ])
  const transitioned = concurrentTransitions[0]
  assert.equal(transitioned.task.status, 'submitted')
  assert.equal(transitioned.run.stage, 'submit_review_and_tests')
  assert.match(transitioned.run.triggerKey, /^transition-event:/)
  assert.equal(concurrentTransitions[1].run.id, transitioned.run.id)
  const replayed = await store.transitionIntegrationTaskStatus({
    taskId: task.id,
    status: 'submitted',
    actorTokenId: 'integration-token',
  })
  assert.equal(replayed.run.id, transitioned.run.id)
  assert.equal(await prisma.integrationTaskEvent.count({ where: { taskId: task.id } }), 1)
  assert.equal(await prisma.integrationRun.count({ where: { taskId: task.id } }), 1)

  const submittedRun = await prisma.integrationRun.findUniqueOrThrow({
    where: { id: transitioned.run.id },
    include: { artifacts: { orderBy: { type: 'asc' } } },
  })
  assert.deepEqual(
    submittedRun.artifacts.map(({ type, outputPath, skillName }) => ({ type, outputPath, skillName })),
    [
      {
        type: 'initial_review',
        outputPath: 'artifacts/initial-review.md',
        skillName: 'harmony-branch-code-review',
      },
      {
        type: 'test_cases',
        outputPath: 'artifacts/test-cases.md',
        skillName: 'harmony-branch-test-cases',
      },
    ],
  )
  assert.ok(submittedRun.artifacts.every((artifact) => artifact.content === null))
  const executionView = await store.getIntegrationRunForExecution(submittedRun.id)
  assert.equal(executionView.task.id, task.id)
  assert.deepEqual(
    executionView.artifacts.map((artifact) => artifact.type).sort(),
    ['initial_review', 'test_cases'],
  )
  assert.deepEqual(
    (await store.listQueuedIntegrationRuns()).map((run) => run.id),
    [submittedRun.id],
    'a committed transition must remain discoverable if enqueue never happens',
  )

  const retryTask = await store.createIntegrationTask({
    title: '重试 trigger',
    projectId: 'ktv',
    sourceBranch: 'feature/retry',
    targetBranch: 'kan-develop',
  })
  const retryKey = `retry:${retryTask.id}:1`
  const [retryRun, retryReplay] = await Promise.all([
    store.createIntegrationRun({
      taskId: retryTask.id,
      stage: 'pre_merge_review',
      triggerKey: retryKey,
    }),
    store.createIntegrationRun({
      taskId: retryTask.id,
      stage: 'pre_merge_review',
      triggerKey: retryKey,
    }),
  ])
  assert.equal(retryReplay.id, retryRun.id)
  assert.equal(await prisma.integrationRun.count({ where: { taskId: retryTask.id } }), 1)
  const finalArtifact = await prisma.integrationArtifact.findFirstOrThrow({ where: { runId: retryRun.id } })
  assert.equal(finalArtifact.type, 'final_review')
  assert.equal(finalArtifact.outputPath, 'artifacts/final-review.md')
  await assert.rejects(
    store.createIntegrationRun({
      taskId: task.id,
      stage: 'submit_review_and_tests',
      triggerKey: retryKey,
    }),
    /TRIGGER_KEY_CONFLICT/,
  )

  // 主动重跑用于“代码修复后重新审查”，与失败重试不同：成功且清理完成的
  // 阶段可以生成新的不可变 run，并以该阶段的最新 run id 做 CAS/幂等键。
  const rerunTask = await store.createIntegrationTask({
    title: '代码修改后主动重跑',
    projectId: 'ktv',
    sourceBranch: 'feature/deliberate-rerun',
    targetBranch: 'kan-develop',
  })
  await prisma.integrationTask.update({
    where: { id: rerunTask.id },
    data: { status: 'merge_pending' },
  })
  const rerunSubmitAnchor = await store.createIntegrationRun({
    taskId: rerunTask.id,
    stage: 'submit_review_and_tests',
    triggerKey: `rerun-anchor-submit:${rerunTask.id}`,
  })
  await markRunTerminal(rerunSubmitAnchor)
  const rerunFinalAnchor = await store.createIntegrationRun({
    taskId: rerunTask.id,
    stage: 'pre_merge_review',
    triggerKey: `rerun-anchor-final:${rerunTask.id}`,
  })
  await markRunTerminal(rerunFinalAnchor)

  const [deliberateRerun, deliberateRerunReplay] = await Promise.all([
    store.rerunIntegrationStage({
      taskId: rerunTask.id,
      stage: 'submit_review_and_tests',
      expectedRunId: rerunSubmitAnchor.id,
    }),
    store.rerunIntegrationStage({
      taskId: rerunTask.id,
      stage: 'submit_review_and_tests',
      expectedRunId: rerunSubmitAnchor.id,
    }),
  ])
  assert.equal(deliberateRerun.id, deliberateRerunReplay.id)
  assert.equal(deliberateRerun.sequence, 3)
  assert.equal(deliberateRerun.stage, 'submit_review_and_tests')
  assert.equal(deliberateRerun.status, 'queued')
  assert.equal(deliberateRerun.triggerKey, `rerun-run:${rerunSubmitAnchor.id}`)
  assert.deepEqual(
    (await prisma.integrationArtifact.findMany({
      where: { runId: deliberateRerun.id },
      orderBy: { type: 'asc' },
    })).map(({ type, status }) => ({ type, status })),
    [
      { type: 'initial_review', status: 'queued' },
      { type: 'test_cases', status: 'queued' },
    ],
  )
  assert.equal(
    await prisma.integrationRun.count({ where: { taskId: rerunTask.id } }),
    3,
    '并发重复提交必须只生成一个新的 run',
  )
  assert.equal(
    (await store.getIntegrationTask(rerunTask.id)).automationStatus,
    'queued',
  )
  await assert.rejects(
    store.rerunIntegrationStage({
      taskId: rerunTask.id,
      stage: 'pre_merge_review',
      expectedRunId: rerunFinalAnchor.id,
    }),
    /RUN_ACTIVE/,
    '任意阶段已有活动运行时不得并行主动重跑',
  )
  await markRunTerminal(deliberateRerun)
  assert.equal(
    (await store.rerunIntegrationStage({
      taskId: rerunTask.id,
      stage: 'submit_review_and_tests',
      expectedRunId: rerunSubmitAnchor.id,
    })).id,
    deliberateRerun.id,
    '已提交成功的同一重跑命令必须在阶段最新运行变化后仍可确定性回放',
  )
  await assert.rejects(
    store.rerunIntegrationStage({
      taskId: rerunTask.id,
      stage: 'submit_review_and_tests',
      expectedRunId: rerunFinalAnchor.id,
    }),
    /RUN_CAS_CONFLICT/,
    '从未提交成功的 expectedRunId 必须锚定所选阶段的最新运行',
  )
  const finalRerun = await store.rerunIntegrationStage({
    taskId: rerunTask.id,
    stage: 'pre_merge_review',
    expectedRunId: rerunFinalAnchor.id,
  })
  assert.equal(finalRerun.stage, 'pre_merge_review')
  assert.equal(finalRerun.sequence, 4)
  await markRunTerminal(finalRerun, { cleanupStatus: 'cleaning' })
  await assert.rejects(
    store.rerunIntegrationStage({
      taskId: rerunTask.id,
      stage: 'submit_review_and_tests',
      expectedRunId: deliberateRerun.id,
    }),
    /RUN_CLEANUP_PENDING/,
    '任意较新终态运行未清理完成时不得主动重跑其他阶段',
  )
  await markRunTerminal(finalRerun)
  await markRunTerminal(finalRerun)

  const developingRerunTask = await store.createIntegrationTask({
    title: '开发中禁止主动重跑',
    projectId: 'ktv',
    sourceBranch: 'feature/rerun-developing',
    targetBranch: 'kan-develop',
  })
  const developingRerun = await store.createIntegrationRun({
    taskId: developingRerunTask.id,
    stage: 'submit_review_and_tests',
    triggerKey: `rerun-developing:${developingRerunTask.id}`,
  })
  await markRunTerminal(developingRerun)
  await assert.rejects(
    store.rerunIntegrationStage({
      taskId: developingRerunTask.id,
      stage: 'submit_review_and_tests',
      expectedRunId: developingRerun.id,
    }),
    /RERUN_STAGE_NOT_ALLOWED/,
  )

  // Review 说明属于某一轮的具体 Review 产物，采用 reviewNoteUpdatedAt 做
  // 乐观锁；测试用例产物、未成功 Review 以及其他 task 的产物均不得写入。
  await prisma.apiToken.create({
    data: {
      id: 'review-note-editor',
      personName: '审查说明填写人',
      personCode: 'review-note-editor',
      tokenHash: 'integration-review-note-editor-token',
    },
  })
  const noteTask = await store.createIntegrationTask({
    title: 'Review 说明持久化',
    projectId: 'ktv',
    sourceBranch: 'feature/review-note',
    targetBranch: 'kan-develop',
  })
  const noteRun = await store.createIntegrationRun({
    taskId: noteTask.id,
    stage: 'submit_review_and_tests',
    triggerKey: `review-note:${noteTask.id}`,
  })
  await markRunTerminal(noteRun)
  const noteArtifacts = await prisma.integrationArtifact.findMany({
    where: { runId: noteRun.id },
  })
  const reviewArtifact = noteArtifacts.find((artifact) => artifact.type === 'initial_review')
  const testCasesArtifact = noteArtifacts.find((artifact) => artifact.type === 'test_cases')
  assert.ok(reviewArtifact)
  assert.ok(testCasesArtifact)
  const firstNoteAt = new Date('2026-07-20T00:40:00.000Z')
  await store.updateIntegrationArtifactReviewNote({
    taskId: noteTask.id,
    artifactId: reviewArtifact.id,
    note: '  该问题是 Android 与鸿蒙交互差异，已确认无需修改。\n保留当前实现。  ',
    expectedUpdatedAt: null,
    actorTokenId: 'review-note-editor',
    now: firstNoteAt,
  })
  const firstSavedNote = await prisma.integrationArtifact.findUniqueOrThrow({
    where: { id: reviewArtifact.id },
    include: { reviewNoteUpdatedBy: true },
  })
  assert.equal(
    firstSavedNote.reviewNote,
    '该问题是 Android 与鸿蒙交互差异，已确认无需修改。\n保留当前实现。',
  )
  assert.equal(firstSavedNote.reviewNoteUpdatedAt?.toISOString(), firstNoteAt.toISOString())
  assert.equal(firstSavedNote.reviewNoteUpdatedByTokenId, 'review-note-editor')
  assert.equal(firstSavedNote.reviewNoteUpdatedBy?.personName, '审查说明填写人')

  await assert.rejects(
    store.updateIntegrationArtifactReviewNote({
      taskId: noteTask.id,
      artifactId: reviewArtifact.id,
      note: '使用过期版本覆盖',
      expectedUpdatedAt: null,
      actorTokenId: 'review-note-editor',
    }),
    /REVIEW_NOTE_CAS_CONFLICT/,
  )
  const secondNoteAt = new Date('2026-07-20T00:41:00.000Z')
  await store.updateIntegrationArtifactReviewNote({
    taskId: noteTask.id,
    artifactId: reviewArtifact.id,
    note: null,
    expectedUpdatedAt: firstNoteAt,
    actorTokenId: 'review-note-editor',
    now: secondNoteAt,
  })
  const clearedNote = await prisma.integrationArtifact.findUniqueOrThrow({
    where: { id: reviewArtifact.id },
  })
  assert.equal(clearedNote.reviewNote, null)
  assert.equal(clearedNote.reviewNoteUpdatedAt?.toISOString(), secondNoteAt.toISOString())
  assert.equal(
    clearedNote.reviewNoteUpdatedByTokenId,
    'review-note-editor',
    '清空说明也必须保留更新人和 CAS 版本',
  )

  const unrelatedNoteTask = await store.createIntegrationTask({
    title: '其他任务',
    projectId: 'ktv',
    sourceBranch: 'feature/unrelated-note-task',
    targetBranch: 'kan-develop',
  })
  await assert.rejects(
    store.updateIntegrationArtifactReviewNote({
      taskId: unrelatedNoteTask.id,
      artifactId: reviewArtifact.id,
      note: '越权写入',
      expectedUpdatedAt: secondNoteAt,
      actorTokenId: 'review-note-editor',
    }),
    /ARTIFACT_NOT_FOUND/,
  )
  await assert.rejects(
    store.updateIntegrationArtifactReviewNote({
      taskId: noteTask.id,
      artifactId: 'missing-review-artifact',
      note: '不存在',
      expectedUpdatedAt: null,
      actorTokenId: 'review-note-editor',
    }),
    /ARTIFACT_NOT_FOUND/,
  )
  await assert.rejects(
    store.updateIntegrationArtifactReviewNote({
      taskId: noteTask.id,
      artifactId: testCasesArtifact.id,
      note: '测试用例不支持 Review 说明',
      expectedUpdatedAt: null,
      actorTokenId: 'review-note-editor',
    }),
    /ARTIFACT_NOT_REVIEW/,
  )

  const unfinishedReviewTask = await store.createIntegrationTask({
    title: '未完成 Review 不可写说明',
    projectId: 'ktv',
    sourceBranch: 'feature/unfinished-review-note',
    targetBranch: 'kan-develop',
  })
  const unfinishedReviewRun = await store.createIntegrationRun({
    taskId: unfinishedReviewTask.id,
    stage: 'pre_merge_review',
    triggerKey: `unfinished-review-note:${unfinishedReviewTask.id}`,
  })
  const unfinishedReviewArtifact = await prisma.integrationArtifact.findFirstOrThrow({
    where: { runId: unfinishedReviewRun.id },
  })
  await assert.rejects(
    store.updateIntegrationArtifactReviewNote({
      taskId: unfinishedReviewTask.id,
      artifactId: unfinishedReviewArtifact.id,
      note: '尚未成功',
      expectedUpdatedAt: null,
      actorTokenId: 'review-note-editor',
    }),
    /ARTIFACT_NOT_SUCCEEDED/,
  )
  for (const invalidNote of ['说'.repeat(4_001), '非法\u0000控制字符']) {
    await assert.rejects(
      store.updateIntegrationArtifactReviewNote({
        taskId: noteTask.id,
        artifactId: reviewArtifact.id,
        note: invalidNote,
        expectedUpdatedAt: secondNoteAt,
        actorTokenId: 'review-note-editor',
      }),
      /INVALID_INPUT/,
    )
  }
  await prisma.integrationTask.deleteMany({
    where: {
      id: {
        in: [
          rerunTask.id,
          developingRerunTask.id,
          noteTask.id,
          unrelatedNoteTask.id,
          unfinishedReviewTask.id,
        ],
      },
    },
  })

  const now = new Date('2026-07-20T01:00:00.000Z')
  const preflightFailureTask = await store.createIntegrationTask({
    title: '快照失败',
    projectId: 'ktv',
    sourceBranch: 'feature/missing',
    targetBranch: 'kan-develop',
  })
  const preflightFailureRun = await store.createIntegrationRun({
    taskId: preflightFailureTask.id,
    stage: 'pre_merge_review',
    triggerKey: `preflight-failure:${preflightFailureTask.id}`,
  })
  const preflightClaim = await store.claimQueuedIntegrationRun({
    runId: preflightFailureRun.id,
    owner: 'preflight-worker',
    leaseMs: 60_000,
    now,
  })
  const preflightFailed = await store.failIntegrationRunExecution({
    runId: preflightFailureRun.id,
    ...claimOf(preflightClaim),
    errorCode: 'ORIGIN_REF_NOT_FOUND',
    error: '开发分支不存在',
    now,
  })
  assert.equal(preflightFailed.status, 'failed')
  assert.equal(preflightFailed.cleanupStatus, 'completed')
  assert.equal(preflightFailed.worktreeStatus, 'none')
  assert.ok(preflightFailed.cleanupCompletedAt instanceof Date)
  assert.deepEqual(
    (await prisma.integrationArtifact.findMany({
      where: { runId: preflightFailureRun.id },
    })).map((artifact) => artifact.status),
    ['failed'],
  )
  assert.equal(
    (await store.getIntegrationTask(preflightFailureTask.id)).automationStatus,
    'failed',
  )
  const [preflightRetry, preflightRetryReplay] = await Promise.all([
    store.retryLatestIntegrationRun({
      taskId: preflightFailureTask.id,
      expectedRunId: preflightFailureRun.id,
    }),
    store.retryLatestIntegrationRun({
      taskId: preflightFailureTask.id,
      expectedRunId: preflightFailureRun.id,
    }),
  ])
  assert.equal(preflightRetry.id, preflightRetryReplay.id)
  assert.equal(preflightRetry.sequence, 2)
  assert.equal(preflightRetry.stage, preflightFailureRun.stage)
  assert.equal(preflightRetry.status, 'queued')
  assert.equal(
    await prisma.integrationRun.count({ where: { taskId: preflightFailureTask.id } }),
    2,
  )
  await assert.rejects(
    store.retryLatestIntegrationRun({
      taskId: preflightFailureTask.id,
      expectedRunId: 'stale-run-id',
    }),
    /RUN_CAS_CONFLICT/,
  )
  await assert.rejects(
    store.retryLatestIntegrationRun({
      taskId: retryTask.id,
      expectedRunId: retryRun.id,
    }),
    /RUN_NOT_FAILED/,
  )

  const claims = await Promise.all([
    store.claimQueuedIntegrationRun({ runId: submittedRun.id, owner: 'worker-a', leaseMs: 60_000, now }),
    store.claimQueuedIntegrationRun({ runId: submittedRun.id, owner: 'worker-b', leaseMs: 60_000, now }),
  ])
  assert.equal(claims.filter(Boolean).length, 1)
  const claim = claims.find(Boolean)
  assert.equal(claim.status, 'running')
  assert.equal(claim.claimEpoch, 1)
  const fence = claimOf(claim)
  assert.equal(
    (await store.listQueuedIntegrationRuns()).some((run) => run.id === submittedRun.id),
    false,
  )
  await expectFenced(() => store.lockIntegrationRunSnapshot({
    runId: submittedRun.id,
    owner: 'loser',
    epoch: claim.claimEpoch,
    baseSha: 'base', headSha: 'head', targetTipSha: 'target', diffHash: 'hash', now,
  }))
  await store.lockIntegrationRunSnapshot({
    runId: submittedRun.id,
    ...fence,
    baseSha: 'base', headSha: 'head', targetTipSha: 'target', diffHash: 'hash', now,
  })
  await assert.rejects(
    store.markIntegrationRunWorktreeActive({
      runId: submittedRun.id,
      ...fence,
      worktreePath: '/runtime/run/repo',
      worktreeLeaseCipher: 'encrypted-test-lease',
      now,
    }),
    /WORKTREE_STATE_CONFLICT/,
  )
  const preparingWorktreeRun = await store.prepareIntegrationRunWorktree({
    runId: submittedRun.id,
    ...fence,
    worktreeLeaseCipher: 'encrypted-test-lease',
    now,
  })
  assert.equal(preparingWorktreeRun.worktreeStatus, 'preparing')
  assert.equal(preparingWorktreeRun.worktreePath, null)
  assert.equal(preparingWorktreeRun.worktreeLeaseCipher, 'encrypted-test-lease')
  assert.equal(preparingWorktreeRun.cleanupStatus, 'pending')
  assert.equal(
    (await store.prepareIntegrationRunWorktree({
      runId: submittedRun.id,
      ...fence,
      worktreeLeaseCipher: 'encrypted-test-lease',
      now,
    })).worktreeStatus,
    'preparing',
  )
  await assert.rejects(
    store.markIntegrationRunWorktreeActive({
      runId: submittedRun.id,
      ...fence,
      worktreePath: '/runtime/run/repo',
      worktreeLeaseCipher: 'different-encrypted-lease',
      now,
    }),
    /WORKTREE_LEASE_CONFLICT/,
  )
  const activeWorktreeRun = await store.markIntegrationRunWorktreeActive({
    runId: submittedRun.id,
    ...fence,
    worktreePath: '/runtime/run/repo',
    worktreeLeaseCipher: 'encrypted-test-lease',
    now,
  })
  assert.equal(activeWorktreeRun.worktreeLeaseCipher, 'encrypted-test-lease')
  assert.equal(activeWorktreeRun.cleanupStatus, 'pending')
  assert.equal(activeWorktreeRun.cleanupErrorCode, null)
  assert.equal(activeWorktreeRun.cleanupError, null)
  assert.equal((await store.getIntegrationTask(task.id)).automationStatus, 'running')

  const initialReview = submittedRun.artifacts.find((artifact) => artifact.type === 'initial_review')
  const testCases = submittedRun.artifacts.find((artifact) => artifact.type === 'test_cases')
  await store.markIntegrationArtifactRunning({
    artifactId: initialReview.id,
    ...fence,
    skillDigest: 'review-digest',
    now,
  })
  await store.markIntegrationArtifactRunning({
    artifactId: testCases.id,
    ...fence,
    skillDigest: 'test-digest',
    now,
  })
  await store.attachIntegrationArtifactSession({
    artifactId: initialReview.id,
    ...fence,
    opencodeSessionId: 'session-initial-review',
    now,
  })
  await store.attachIntegrationArtifactSession({
    artifactId: testCases.id,
    ...fence,
    opencodeSessionId: 'session-test-cases',
    now,
  })

  const retryExecutionClaim = await store.claimQueuedIntegrationRun({
    runId: retryRun.id,
    owner: 'retry-worker',
    leaseMs: 60_000,
    now,
  })
  await store.markIntegrationArtifactRunning({
    artifactId: finalArtifact.id,
    ...claimOf(retryExecutionClaim),
    skillDigest: 'final-review-digest',
    now,
  })
  await assert.rejects(
    store.attachIntegrationArtifactSession({
      artifactId: finalArtifact.id,
      ...claimOf(retryExecutionClaim),
      opencodeSessionId: 'session-initial-review',
      now,
    }),
    /SESSION_ID_CONFLICT/,
  )
  await store.attachIntegrationArtifactSession({
    artifactId: finalArtifact.id,
    ...claimOf(retryExecutionClaim),
    opencodeSessionId: 'session-final-review',
    now,
  })

  for (const source of [
    'sse_session_idle',
    'sse_session_status_idle',
    'status_endpoint_idle',
  ]) {
    await assert.rejects(
      store.acknowledgeIntegrationArtifactTerminal({
        artifactId: finalArtifact.id,
        ...claimOf(retryExecutionClaim),
        source,
        now,
      }),
      /TERMINAL_ACK_PROMPT_NOT_ACCEPTED/,
      `not_submitted prompt must reject ${source}`,
    )
  }
  await store.markIntegrationArtifactPromptSubmitted({
    artifactId: finalArtifact.id,
    ...claimOf(retryExecutionClaim),
    now,
  })
  for (const source of [
    'sse_session_idle',
    'sse_session_status_idle',
    'status_endpoint_idle',
  ]) {
    await assert.rejects(
      store.acknowledgeIntegrationArtifactTerminal({
        artifactId: finalArtifact.id,
        ...claimOf(retryExecutionClaim),
        source,
        now,
      }),
      /TERMINAL_ACK_PROMPT_NOT_ACCEPTED/,
      `submitted prompt must reject ${source}`,
    )
  }
  await store.markIntegrationArtifactPromptAccepted({
    artifactId: finalArtifact.id,
    ...claimOf(retryExecutionClaim),
    now,
  })
  await store.acknowledgeIntegrationArtifactTerminal({
    artifactId: finalArtifact.id,
    ...claimOf(retryExecutionClaim),
    source: 'sse_session_idle',
    now,
  })
  const repeatedTerminalAck = await store.acknowledgeIntegrationArtifactTerminal({
    artifactId: finalArtifact.id,
    ...claimOf(retryExecutionClaim),
    source: 'status_endpoint_idle',
    now: new Date('2026-07-20T01:00:00.500Z'),
  })
  assert.equal(repeatedTerminalAck.terminalAckSource, 'sse_session_idle')
  assert.equal(repeatedTerminalAck.terminalAckAt.getTime(), now.getTime())
  await store.finishIntegrationArtifactFailure({
    artifactId: finalArtifact.id,
    ...claimOf(retryExecutionClaim),
    errorCode: 'REVIEW_FAILED',
    error: 'OpenCode review failed',
    now,
  })
  const failedRetryRun = await store.finishIntegrationRunFromArtifacts({
    runId: retryRun.id,
    ...claimOf(retryExecutionClaim),
    now,
  })
  assert.equal(failedRetryRun.status, 'failed')
  assert.equal(failedRetryRun.errorCode, 'REVIEW_FAILED')
  await store.recordIntegrationArtifactSessionDeleted({
    artifactId: finalArtifact.id,
    ...claimOf(retryExecutionClaim),
    now,
  })
  await store.recordIntegrationRunOpencodeDisposed({
    runId: retryRun.id,
    ...claimOf(retryExecutionClaim),
    now,
  })
  const retryCleanupSafe = await store.markIntegrationRunCleanupSafeIfTerminal({
    runId: retryRun.id,
    ...claimOf(retryExecutionClaim),
    now,
  })
  assert.equal(retryCleanupSafe.safe, true)
  const retryCleaning = await store.beginIntegrationRunCleanup({
    runId: retryRun.id,
    ...claimOf(retryExecutionClaim),
    now,
  })
  assert.equal(retryCleaning.cleanupStatus, 'cleaning')
  assert.equal(retryCleaning.claimEpoch, retryExecutionClaim.claimEpoch)
  await store.finishIntegrationRunCleanup({
    runId: retryRun.id,
    ...claimOf(retryExecutionClaim),
    now,
  })

  await assert.rejects(
    store.attachIntegrationArtifactSession({
      artifactId: testCases.id,
      ...fence,
      opencodeSessionId: 'session-initial-review',
      now,
    }),
    /SESSION_(?:ALREADY_ASSIGNED|ID_CONFLICT)/,
  )

  await store.markIntegrationArtifactPromptSubmitted({
    artifactId: initialReview.id,
    ...fence,
    now,
  })
  await store.markIntegrationArtifactPromptAcceptanceUnknown({
    artifactId: initialReview.id,
    ...fence,
    now: new Date('2026-07-20T01:00:01.000Z'),
  })
  await store.markIntegrationArtifactAbortRequested({
    artifactId: initialReview.id,
    ...fence,
    now: new Date('2026-07-20T01:00:02.000Z'),
  })
  await store.recordIntegrationArtifactAbortFailure({
    artifactId: initialReview.id,
    ...fence,
    errorCode: 'ABORT_FAILED',
    error: '首次中止请求超时',
    now: new Date('2026-07-20T01:00:02.500Z'),
  })
  assert.equal(
    (await prisma.integrationArtifact.findUniqueOrThrow({
      where: { id: initialReview.id },
    })).abortErrorCode,
    'ABORT_FAILED',
  )
  await store.recordIntegrationArtifactAbortResponse({
    artifactId: initialReview.id,
    ...fence,
    abortAccepted: false,
    now: new Date('2026-07-20T01:00:03.000Z'),
  })
  assert.equal(
    (await prisma.integrationArtifact.findUniqueOrThrow({
      where: { id: initialReview.id },
    })).abortAccepted,
    false,
  )
  await store.recordIntegrationArtifactAbortResponse({
    artifactId: initialReview.id,
    ...fence,
    abortAccepted: true,
    now: new Date('2026-07-20T01:00:03.500Z'),
  })
  const aborted = await prisma.integrationArtifact.findUniqueOrThrow({
    where: { id: initialReview.id },
  })
  assert.equal(aborted.promptState, 'acceptance_unknown')
  assert.equal(aborted.abortAccepted, true)
  assert.equal(aborted.abortErrorCode, null)
  assert.equal(aborted.terminalAckAt, null, 'abort true must not acknowledge terminal state')

  await store.markIntegrationArtifactPromptSubmitted({ artifactId: testCases.id, ...fence, now })
  await store.markIntegrationArtifactPromptAccepted({
    artifactId: testCases.id,
    ...fence,
    now: new Date('2026-07-20T01:00:01.000Z'),
  })
  await assert.rejects(
    store.acknowledgeIntegrationArtifactTerminal({
      artifactId: testCases.id,
      ...fence,
      source: 'session_idle',
      now: new Date('2026-07-20T01:00:03.000Z'),
    }),
    /TERMINAL_ACK_INVALID/,
  )
  await store.acknowledgeIntegrationArtifactTerminal({
    artifactId: testCases.id,
    ...fence,
    source: 'sse_session_status_idle',
    now: new Date('2026-07-20T01:00:04.000Z'),
  })
  await assert.rejects(
    store.finishIntegrationArtifactSuccess({
      artifactId: initialReview.id,
      ...fence,
      content: '# 初审',
      conclusion: 'warning',
      now: new Date('2026-07-20T01:00:05.000Z'),
    }),
    /ARTIFACT_TERMINAL_ACK_REQUIRED/,
    'a report must not become visible while its accepted or uncertain prompt can still mutate it',
  )
  await store.finishIntegrationArtifactSuccess({
    artifactId: testCases.id,
    ...fence,
    content: '# 测试用例',
    conclusion: null,
    now: new Date('2026-07-20T01:00:05.000Z'),
  })
  const unsafe = await store.markIntegrationRunCleanupSafeIfTerminal({
    runId: submittedRun.id,
    ...fence,
    now: new Date('2026-07-20T01:00:06.000Z'),
  })
  assert.equal(unsafe.safe, false)
  assert.equal(unsafe.run.cleanupSafeAt, null)
  await store.markIntegrationRunCleanupPending({
    runId: submittedRun.id,
    ...fence,
    now: new Date('2026-07-20T01:00:06.000Z'),
  })
  await store.acknowledgeIntegrationArtifactTerminal({
    artifactId: initialReview.id,
    ...fence,
    source: 'status_endpoint_idle',
    now: new Date('2026-07-20T01:00:07.000Z'),
  })
  await store.finishIntegrationArtifactSuccess({
    artifactId: initialReview.id,
    ...fence,
    content: '# 初审',
    conclusion: 'warning',
    now: new Date('2026-07-20T01:00:07.250Z'),
  })
  const runningCannotBeSafe = await store.markIntegrationRunCleanupSafeIfTerminal({
    runId: submittedRun.id,
    ...fence,
    now: new Date('2026-07-20T01:00:07.500Z'),
  })
  assert.equal(runningCannotBeSafe.safe, false)
  assert.equal(runningCannotBeSafe.run.status, 'running')
  assert.equal(runningCannotBeSafe.run.cleanupSafeAt, null)
  const aggregate = await store.finishIntegrationRunFromArtifacts({
    runId: submittedRun.id,
    ...fence,
    now: new Date('2026-07-20T01:00:08.000Z'),
  })
  assert.equal(aggregate.status, 'succeeded')
  const remoteCleanupUnsafe = await store.markIntegrationRunCleanupSafeIfTerminal({
    runId: submittedRun.id,
    ...fence,
    now: new Date('2026-07-20T01:00:08.250Z'),
  })
  assert.equal(
    remoteCleanupUnsafe.safe,
    false,
    'the local worktree must remain while OpenCode sessions or directory state still exist',
  )
  await assert.rejects(
    store.recordIntegrationRunOpencodeDisposed({
      runId: submittedRun.id,
      ...fence,
      now: new Date('2026-07-20T01:00:08.300Z'),
    }),
    /OPENCODE_SESSIONS_NOT_DELETED/,
  )
  await store.recordIntegrationArtifactSessionDeleted({
    artifactId: initialReview.id,
    ...fence,
    now: new Date('2026-07-20T01:00:08.400Z'),
  })
  await store.recordIntegrationArtifactSessionDeleted({
    artifactId: testCases.id,
    ...fence,
    now: new Date('2026-07-20T01:00:08.500Z'),
  })
  await store.recordIntegrationRunOpencodeDisposed({
    runId: submittedRun.id,
    ...fence,
    now: new Date('2026-07-20T01:00:08.600Z'),
  })
  const safe = await store.markIntegrationRunCleanupSafeIfTerminal({
    runId: submittedRun.id,
    ...fence,
    now: new Date('2026-07-20T01:00:09.000Z'),
  })
  assert.equal(safe.safe, true)
  assert.ok(safe.run.cleanupSafeAt instanceof Date)
  assert.equal(
    (await store.listIntegrationCleanupCandidates({
      now: new Date('2026-07-20T01:00:09.500Z'),
    })).some((run) => run.id === submittedRun.id),
    false,
    'an execution claim that is still valid must fence cleanup claiming',
  )
  await store.releaseIntegrationRunClaim({
    runId: submittedRun.id,
    ...fence,
    now: new Date('2026-07-20T01:00:10.000Z'),
  })
  assert.equal(
    (await store.listIntegrationCleanupCandidates({
      now: new Date('2026-07-20T01:00:10.500Z'),
    })).some((run) => run.id === submittedRun.id),
    true,
    'a run must remain discoverable if the process crashes after markSafe',
  )

  const cleanupClaims = await Promise.all([
    store.claimIntegrationRunCleanup({
      runId: submittedRun.id,
      owner: 'cleaner-a',
      leaseMs: 60_000,
      now: new Date('2026-07-20T01:00:11.000Z'),
    }),
    store.claimIntegrationRunCleanup({
      runId: submittedRun.id,
      owner: 'cleaner-b',
      leaseMs: 60_000,
      now: new Date('2026-07-20T01:00:11.000Z'),
    }),
  ])
  assert.equal(cleanupClaims.filter(Boolean).length, 1)
  const cleanupClaim = cleanupClaims.find(Boolean)
  await store.failIntegrationRunCleanup({
    runId: submittedRun.id,
    ...claimOf(cleanupClaim),
    cleanupErrorCode: 'WORKTREE_CLEANUP_FAILED',
    cleanupError: 'temporary failure',
    now: new Date('2026-07-20T01:00:12.000Z'),
  })
  assert.equal(
    (await store.listIntegrationCleanupCandidates({
      now: new Date('2026-07-20T01:00:12.500Z'),
    })).some((run) => run.id === submittedRun.id),
    true,
    'a failed cleanup must be discoverable for retry after restart',
  )
  const cleanupRetry = await store.claimIntegrationRunCleanup({
    runId: submittedRun.id,
    owner: 'cleaner-retry',
    leaseMs: 60_000,
    now: new Date('2026-07-20T01:00:13.000Z'),
  })
  assert.ok(cleanupRetry.claimEpoch > cleanupClaim.claimEpoch)
  await expectFenced(() => store.finishIntegrationRunCleanup({
    runId: submittedRun.id,
    ...claimOf(cleanupClaim),
    now: new Date('2026-07-20T01:00:14.000Z'),
  }))
  const cleaned = await store.finishIntegrationRunCleanup({
    runId: submittedRun.id,
    ...claimOf(cleanupRetry),
    now: new Date('2026-07-20T01:00:14.000Z'),
  })
  assert.equal(cleaned.cleanupStatus, 'completed')
  assert.equal(cleaned.worktreeStatus, 'cleaned')
  assert.equal(cleaned.claimOwner, null)
  assert.equal(cleaned.claimExpiresAt, null)
  const cleanedAgain = await store.finishIntegrationRunCleanup({
    runId: submittedRun.id,
    owner: 'unrelated-idempotent-reader',
    epoch: cleanupRetry.claimEpoch + 99,
    now: new Date('2026-07-20T01:00:15.000Z'),
  })
  assert.equal(cleanedAgain.cleanupStatus, 'completed')

  const cleanupGuardTask = await store.createIntegrationTask({
    title: '运行中禁止清理',
    projectId: 'ktv',
    sourceBranch: 'feature/cleanup-status-guard',
    targetBranch: 'kan-develop',
  })
  const cleanupGuardRun = await store.createIntegrationRun({
    taskId: cleanupGuardTask.id,
    stage: 'pre_merge_review',
    triggerKey: `retry:${cleanupGuardTask.id}:1`,
  })
  await store.claimQueuedIntegrationRun({
    runId: cleanupGuardRun.id,
    owner: 'cleanup-guard-worker',
    leaseMs: 60_000,
    now,
  })
  // Simulate a partially corrupted historical row to prove the cleanup CAS
  // independently fences on terminal run status, not only cleanupSafeAt.
  await prisma.integrationRun.update({
    where: { id: cleanupGuardRun.id },
    data: {
      cleanupStatus: 'safe',
      cleanupSafeAt: now,
      claimOwner: null,
      claimExpiresAt: null,
    },
  })
  assert.equal(
    (await store.listIntegrationCleanupCandidates({ now }))
      .some((run) => run.id === cleanupGuardRun.id),
    false,
  )
  assert.equal(await store.claimIntegrationRunCleanup({
    runId: cleanupGuardRun.id,
    owner: 'must-not-clean-running',
    leaseMs: 60_000,
    now,
  }), null)
  await prisma.integrationTask.delete({ where: { id: cleanupGuardTask.id } })

  const failedArtifactRecoveryTask = await store.createIntegrationTask({
    title: '失败产物恢复元数据',
    projectId: 'ktv',
    sourceBranch: 'feature/failed-artifact-recovery',
    targetBranch: 'kan-develop',
  })
  const failedArtifactRecoveryRun = await store.createIntegrationRun({
    taskId: failedArtifactRecoveryTask.id,
    stage: 'pre_merge_review',
    triggerKey: `retry:${failedArtifactRecoveryTask.id}:1`,
  })
  const failedArtifactRecoveryClaim = await store.claimQueuedIntegrationRun({
    runId: failedArtifactRecoveryRun.id,
    owner: 'failed-artifact-recovery-worker',
    leaseMs: 60_000,
    now,
  })
  const failedArtifactRecoveryFence = claimOf(failedArtifactRecoveryClaim)
  const failedArtifactRecoveryArtifact =
    await prisma.integrationArtifact.findFirstOrThrow({
      where: { runId: failedArtifactRecoveryRun.id },
    })
  await store.markIntegrationArtifactRunning({
    artifactId: failedArtifactRecoveryArtifact.id,
    ...failedArtifactRecoveryFence,
    skillDigest: 'failed-artifact-recovery-digest',
    now,
  })
  await store.attachIntegrationArtifactSession({
    artifactId: failedArtifactRecoveryArtifact.id,
    ...failedArtifactRecoveryFence,
    opencodeSessionId: 'session-failed-artifact-recovery',
    now,
  })
  await store.markIntegrationArtifactPromptSubmitted({
    artifactId: failedArtifactRecoveryArtifact.id,
    ...failedArtifactRecoveryFence,
    now,
  })
  await store.finishIntegrationArtifactFailure({
    artifactId: failedArtifactRecoveryArtifact.id,
    ...failedArtifactRecoveryFence,
    errorCode: 'CURSOR_RUN_FAILED',
    error: 'Cursor 返回了多个 agent session',
    now,
  })
  await store.markIntegrationArtifactPromptAcceptanceUnknown({
    artifactId: failedArtifactRecoveryArtifact.id,
    ...failedArtifactRecoveryFence,
    now,
  })
  await store.markIntegrationArtifactAbortRequested({
    artifactId: failedArtifactRecoveryArtifact.id,
    ...failedArtifactRecoveryFence,
    now,
  })
  await store.recordIntegrationArtifactAbortFailure({
    artifactId: failedArtifactRecoveryArtifact.id,
    ...failedArtifactRecoveryFence,
    errorCode: 'ABORT_FAILED',
    error: '首次恢复中止失败',
    now,
  })
  await store.recordIntegrationArtifactAbortResponse({
    artifactId: failedArtifactRecoveryArtifact.id,
    ...failedArtifactRecoveryFence,
    abortAccepted: true,
    now,
  })
  const failedArtifactRecoveryState =
    await prisma.integrationArtifact.findUniqueOrThrow({
      where: { id: failedArtifactRecoveryArtifact.id },
    })
  assert.equal(failedArtifactRecoveryState.status, 'failed')
  assert.equal(failedArtifactRecoveryState.promptState, 'acceptance_unknown')
  assert.equal(failedArtifactRecoveryState.abortAccepted, true)
  assert.equal(failedArtifactRecoveryState.abortErrorCode, null)
  await prisma.integrationTask.delete({
    where: { id: failedArtifactRecoveryTask.id },
  })

  const recoveryTask = await store.createIntegrationTask({
    title: '过期租约恢复',
    projectId: 'ktv',
    sourceBranch: 'feature/recovery',
    targetBranch: 'kan-develop',
  })
  const recoveryRun = await store.createIntegrationRun({
    taskId: recoveryTask.id,
    stage: 'pre_merge_review',
    triggerKey: `retry:${recoveryTask.id}:1`,
  })
  const oldClaim = await store.claimQueuedIntegrationRun({
    runId: recoveryRun.id,
    owner: 'old-worker',
    leaseMs: 1_000,
    now: new Date('2026-07-20T02:00:00.000Z'),
  })
  assert.deepEqual(
    (await store.listIntegrationRunRecoveryCandidates({
      now: new Date('2026-07-20T02:00:00.500Z'),
    })).map((run) => run.id),
    [],
  )
  assert.deepEqual(
    (await store.listIntegrationRunRecoveryCandidates({
      now: new Date('2026-07-20T02:00:02.000Z'),
    })).map((run) => run.id),
    [recoveryRun.id],
  )
  const recovered = await store.claimIntegrationRunForRecovery({
    runId: recoveryRun.id,
    owner: 'recovery-worker',
    leaseMs: 60_000,
    now: new Date('2026-07-20T02:00:02.000Z'),
  })
  assert.equal(recovered.claimEpoch, oldClaim.claimEpoch + 1)
  await expectFenced(() => store.renewIntegrationRunClaim({
    runId: recoveryRun.id,
    ...claimOf(oldClaim),
    leaseMs: 60_000,
    now: new Date('2026-07-20T02:00:02.100Z'),
  }))
  await expectFenced(() => store.lockIntegrationRunSnapshot({
    runId: recoveryRun.id,
    ...claimOf(oldClaim),
    baseSha: 'old-base', headSha: 'old-head', targetTipSha: 'old-target', diffHash: 'old-hash',
    now: new Date('2026-07-20T02:00:02.100Z'),
  }))
  const recoveryArtifact = await prisma.integrationArtifact.findFirstOrThrow({
    where: { runId: recoveryRun.id },
  })
  await expectFenced(() => store.markIntegrationArtifactRunning({
    artifactId: recoveryArtifact.id,
    ...claimOf(oldClaim),
    skillDigest: 'old-digest',
    now: new Date('2026-07-20T02:00:02.100Z'),
  }))
  assert.equal(
    (await prisma.integrationArtifact.findUniqueOrThrow({ where: { id: recoveryArtifact.id } })).status,
    'queued',
  )

  const staleTask = await store.createIntegrationTask({
    title: '旧运行完成保护',
    projectId: 'ktv',
    sourceBranch: 'feature/stale',
    targetBranch: 'kan-develop',
  })
  const staleOldRun = await store.createIntegrationRun({
    taskId: staleTask.id,
    stage: 'pre_merge_review',
    triggerKey: `retry:${staleTask.id}:old`,
  })
  const staleClaim = await store.claimQueuedIntegrationRun({
    runId: staleOldRun.id,
    owner: 'stale-worker',
    leaseMs: 60_000,
    now,
  })
  const staleArtifact = await prisma.integrationArtifact.findFirstOrThrow({
    where: { runId: staleOldRun.id },
  })
  await store.markIntegrationArtifactRunning({
    artifactId: staleArtifact.id,
    ...claimOf(staleClaim),
    skillDigest: 'digest',
    now,
  })
  await store.attachIntegrationArtifactSession({
    artifactId: staleArtifact.id,
    ...claimOf(staleClaim),
    opencodeSessionId: 'session-stale-old-run',
    now,
  })
  await store.markIntegrationArtifactPromptSubmitted({
    artifactId: staleArtifact.id,
    ...claimOf(staleClaim),
    now,
  })
  await store.markIntegrationArtifactPromptAccepted({
    artifactId: staleArtifact.id,
    ...claimOf(staleClaim),
    now,
  })
  await store.acknowledgeIntegrationArtifactTerminal({
    artifactId: staleArtifact.id,
    ...claimOf(staleClaim),
    source: 'sse_session_idle',
    now,
  })
  await store.finishIntegrationArtifactSuccess({
    artifactId: staleArtifact.id,
    ...claimOf(staleClaim),
    content: '# old',
    conclusion: 'pass',
    now,
  })
  const latestRun = await store.createIntegrationRun({
    taskId: staleTask.id,
    stage: 'pre_merge_review',
    triggerKey: `retry:${staleTask.id}:new`,
  })
  await store.finishIntegrationRunFromArtifacts({
    runId: staleOldRun.id,
    ...claimOf(staleClaim),
    now,
  })
  assert.equal((await store.getIntegrationTask(staleTask.id)).automationStatus, 'queued')
  assert.equal((await prisma.integrationRun.findUniqueOrThrow({ where: { id: latestRun.id } })).status, 'queued')

  const listed = await store.listIntegrationTasks({ projectId: 'ktv' })
  assert.ok(listed.length >= 4)
  assert.equal('tokenHash' in listed.find((entry) => entry.id === task.id).creator, false)
} finally {
  await prisma?.$disconnect()
  rmSync(tempRoot, { recursive: true, force: true })
}

console.log('integration store contract tests passed')
