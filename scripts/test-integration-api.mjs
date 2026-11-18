#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  IntegrationApiContractError,
  parseCreateIntegrationTaskInput,
  parseIntegrationRerunInput,
  parseIntegrationRetryInput,
  parseIntegrationReviewNoteInput,
  parseIntegrationStatusUpdateInput,
  toIntegrationTaskDetailDto,
  toIntegrationTaskListDto,
} from '../src/server/modules/integration/integration-api.ts'
import {
  checkLatestIntegrationTaskConflicts,
  IntegrationConflictCheckBusyError,
} from '../src/server/modules/integration/integration-conflict-check.ts'
import {
  IntegrationHttpError,
  integrationErrorResponse,
  parseIntegrationTaskFilters,
  readIntegrationJsonBody,
  requireIntegrationResourceId,
} from '../src/server/modules/integration/integration-http.ts'
import { IntegrationStoreError } from '../src/server/modules/integration/integration-store.ts'

const projects = [{
  id: 'ktv',
  label: '酷狗 KTV',
  repoRoot: '/workspaces/hmkugou',
  defaultTargetBranch: 'kan-develop',
  scopePath: 'feature/ktvallinone',
}]

function deferred() {
  let resolve
  const promise = new Promise((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

const conflictTask = {
  id: 'task-conflict-single-flight',
  sourceBranch: 'feature/song-list',
  targetBranch: 'kan-develop',
}
const refreshGate = deferred()
let refreshCalls = 0
let conflictCalls = 0
const conflictDependencies = {
  async refreshBranchTips() {
    refreshCalls += 1
    return refreshGate.promise
  },
  async checkMergeConflicts() {
    conflictCalls += 1
    return {
      hasConflicts: false,
      conflictPaths: [],
      conflictPathCount: 0,
      conflictPathsTruncated: false,
    }
  },
  now: () => new Date('2026-08-03T10:00:00.000Z'),
}
const singleFlightA = checkLatestIntegrationTaskConflicts(
  { task: conflictTask, project: projects[0] },
  conflictDependencies,
)
const singleFlightB = checkLatestIntegrationTaskConflicts(
  { task: conflictTask, project: projects[0] },
  conflictDependencies,
)
assert.equal(singleFlightA, singleFlightB, '同一任务的并发检测必须合并')
refreshGate.resolve({ headSha: 'a'.repeat(40), targetTipSha: 'b'.repeat(40) })
const singleFlightResult = await singleFlightA
assert.equal(singleFlightResult.checkedAt, '2026-08-03T10:00:00.000Z')
assert.equal(refreshCalls, 1)
assert.equal(conflictCalls, 1)

const busyGates = [deferred(), deferred()]
const busyDependencies = busyGates.map((gate) => ({
  async refreshBranchTips() {
    return gate.promise
  },
  async checkMergeConflicts() {
    return {
      hasConflicts: false,
      conflictPaths: [],
      conflictPathCount: 0,
      conflictPathsTruncated: false,
    }
  },
  now: () => new Date('2026-08-03T10:00:00.000Z'),
}))
const busyA = checkLatestIntegrationTaskConflicts(
  { task: { ...conflictTask, id: 'task-busy-a' }, project: projects[0] },
  busyDependencies[0],
)
const busyB = checkLatestIntegrationTaskConflicts(
  { task: { ...conflictTask, id: 'task-busy-b' }, project: projects[0] },
  busyDependencies[1],
)
assert.throws(
  () => checkLatestIntegrationTaskConflicts(
    { task: { ...conflictTask, id: 'task-busy-c' }, project: projects[0] },
    conflictDependencies,
  ),
  (error) => error instanceof IntegrationConflictCheckBusyError,
)
for (const gate of busyGates) {
  gate.resolve({ headSha: 'c'.repeat(40), targetTipSha: 'd'.repeat(40) })
}
await Promise.all([busyA, busyB])

assert.deepEqual(
  parseCreateIntegrationTaskInput({
    title: '  点歌台迁移  ',
    projectId: 'ktv',
    sourceBranch: 'feature/song-list',
    featureDesc: '  补齐点歌台交互  ',
  }, projects),
  {
    title: '点歌台迁移',
    projectId: 'ktv',
    sourceBranch: 'feature/song-list',
    targetBranch: 'kan-develop',
    scopePath: 'feature/ktvallinone',
    featureDesc: '补齐点歌台交互',
  },
)

const multilineFeatureDesc = '显示问题\n2、修复评论输入\r\n3、补充测试\t注意事项'
assert.equal(
  parseCreateIntegrationTaskInput({
    title: '点歌台迁移',
    projectId: 'ktv',
    sourceBranch: 'feature/multiline-description',
    featureDesc: multilineFeatureDesc,
  }, projects).featureDesc,
  multilineFeatureDesc,
)

assert.equal(
  parseCreateIntegrationTaskInput({
    title: '点歌台迁移',
    projectId: 'ktv',
    sourceBranch: 'feature/feature-desc-limit',
    featureDesc: '需'.repeat(4_000),
  }, projects).featureDesc?.length,
  4_000,
)

function assertContractError(operation, code, field) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof IntegrationApiContractError)
    assert.equal(error.code, code)
    assert.equal(error.field, field)
    return true
  })
}

assertContractError(
  () => parseCreateIntegrationTaskInput(null, projects),
  'INVALID_INPUT',
  'body',
)

const safeCleanupAt = new Date('2026-07-17T01:50:00.000Z')
const reviewNoteUpdatedAt = new Date('2026-07-17T01:45:00.000Z')
const taskRecord = {
  id: 'task-1',
  title: '点歌台迁移',
  projectId: 'ktv',
  sourceBranch: 'feature/song-list',
  targetBranch: 'kan-develop',
  scopePath: 'feature/ktvallinone',
  featureDesc: '补齐点歌台交互',
  status: 'submitted',
  automationStatus: 'succeeded',
  createdByTokenId: 'token-secret-id',
  repoRoot: '/secret/repository',
  runtimeRoot: '/secret/runtime',
  createdAt: new Date('2026-07-17T01:00:00.000Z'),
  updatedAt: new Date('2026-07-17T02:00:00.000Z'),
  creator: {
    id: 'token-secret-id',
    personName: '张三',
    personCode: 'zhangsan',
    label: '驻场开发',
    tokenHash: 'secret-hash',
  },
  events: [{
    id: 'event-1',
    taskId: 'task-1',
    fromStatus: 'developing',
    toStatus: 'submitted',
    actorTokenId: 'token-secret-id',
    leaseOwner: 'secret-owner',
    createdAt: new Date('2026-07-17T01:30:00.000Z'),
  }],
  runs: [{
    id: 'run-1',
    taskId: 'task-1',
    stage: 'submit_review_and_tests',
    sequence: 1,
    triggerKey: 'transition-event:event-1',
    status: 'succeeded',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    targetTipSha: 'c'.repeat(40),
    diffHash: 'd'.repeat(64),
    claimOwner: null,
    claimEpoch: 7,
    claimExpiresAt: null,
    worktreeStatus: 'cleaned',
    worktreePath: null,
    worktreeLeaseCipher: null,
    opencodeDisposedAt: safeCleanupAt,
    cleanupStatus: 'completed',
    cleanupCompletedAt: safeCleanupAt,
    errorCode: 'OPENCODE_CONNECTION_LOST',
    error: '/secret/repository: OPENCODE_INTEGRATION_SERVER_PASSWORD=raw-secret',
    startedAt: new Date('2026-07-17T01:31:00.000Z'),
    finishedAt: new Date('2026-07-17T01:40:00.000Z'),
    createdAt: new Date('2026-07-17T01:30:00.000Z'),
    updatedAt: new Date('2026-07-17T01:40:00.000Z'),
    artifacts: [{
      id: 'artifact-1',
      runId: 'run-1',
      type: 'initial_review',
      status: 'succeeded',
      outputPath: 'artifacts/initial-review.md',
      skillName: 'harmony-branch-code-review',
      skillDigest: 'skill-secret',
      opencodeSessionId: 'session-secret',
      promptState: 'accepted',
      abortAccepted: null,
      terminalAckSource: 'status_endpoint_idle',
      sessionDeletedAt: safeCleanupAt,
      content: '# 首次 Review\n\n未发现阻断项。',
      conclusion: 'pass',
      reviewNote: '经人工确认，该告警属于既有兼容逻辑。',
      reviewNoteUpdatedAt,
      reviewNoteUpdatedByTokenId: 'token-secret-id',
      reviewNoteUpdatedBy: {
        id: 'token-secret-id',
        personName: '张三',
        personCode: 'zhangsan',
        label: '驻场开发',
        tokenHash: 'secret-hash',
      },
      errorCode: 'REPORT_MISSING',
      error: '/secret/runtime/run-1: sk_live_raw-secret',
      startedAt: new Date('2026-07-17T01:31:00.000Z'),
      finishedAt: new Date('2026-07-17T01:39:00.000Z'),
      createdAt: new Date('2026-07-17T01:30:00.000Z'),
      updatedAt: new Date('2026-07-17T01:39:00.000Z'),
    }],
  }],
}

const expectedTaskSummary = {
  id: 'task-1',
  title: '点歌台迁移',
  projectId: 'ktv',
  sourceBranch: 'feature/song-list',
  targetBranch: 'kan-develop',
  scopePath: 'feature/ktvallinone',
  featureDesc: '补齐点歌台交互',
  status: 'submitted',
  automationStatus: 'succeeded',
  canRetry: false,
  retryBlockedReason: null,
  rerunnableStages: ['submit_review_and_tests'],
  rerunBlockedReason: null,
  canDelete: true,
  deleteBlockedReason: null,
  creator: {
    personName: '张三',
    personCode: 'zhangsan',
    label: '驻场开发',
  },
  createdAt: '2026-07-17T01:00:00.000Z',
  updatedAt: '2026-07-17T02:00:00.000Z',
  runs: [{
    id: 'run-1',
    stage: 'submit_review_and_tests',
    sequence: 1,
    status: 'succeeded',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    targetTipSha: 'c'.repeat(40),
    diffHash: 'd'.repeat(64),
    errorCode: 'OPENCODE_CONNECTION_LOST',
    error: 'OpenCode 服务连接中断，请稍后重试。',
    startedAt: '2026-07-17T01:31:00.000Z',
    finishedAt: '2026-07-17T01:40:00.000Z',
    createdAt: '2026-07-17T01:30:00.000Z',
    updatedAt: '2026-07-17T01:40:00.000Z',
    artifacts: [{
      id: 'artifact-1',
      type: 'initial_review',
      status: 'succeeded',
      conclusion: 'pass',
      errorCode: 'REPORT_MISSING',
      error: '自动化报告未生成，请重试。',
      startedAt: '2026-07-17T01:31:00.000Z',
      finishedAt: '2026-07-17T01:39:00.000Z',
      createdAt: '2026-07-17T01:30:00.000Z',
      updatedAt: '2026-07-17T01:39:00.000Z',
    }],
  }],
}

const listDto = toIntegrationTaskListDto([taskRecord])
assert.deepEqual(listDto, [expectedTaskSummary])
assert.equal('content' in listDto[0].runs[0].artifacts[0], false)
assert.equal('reviewNote' in listDto[0].runs[0].artifacts[0], false)
assert.equal('reviewNoteUpdatedAt' in listDto[0].runs[0].artifacts[0], false)
assert.equal('reviewNoteUpdatedBy' in listDto[0].runs[0].artifacts[0], false)

const detailDto = toIntegrationTaskDetailDto(taskRecord)
assert.deepEqual(detailDto, {
  ...expectedTaskSummary,
  events: [{
    id: 'event-1',
    fromStatus: 'developing',
    toStatus: 'submitted',
    createdAt: '2026-07-17T01:30:00.000Z',
  }],
  runs: [{
    ...expectedTaskSummary.runs[0],
    artifacts: [{
      ...expectedTaskSummary.runs[0].artifacts[0],
      content: '# 首次 Review\n\n未发现阻断项。',
      reviewNote: '经人工确认，该告警属于既有兼容逻辑。',
      reviewNoteUpdatedAt: '2026-07-17T01:45:00.000Z',
      reviewNoteUpdatedBy: '张三',
    }],
  }],
})

const deletionSafeAt = safeCleanupAt
const mistakenTaskDto = toIntegrationTaskListDto([{
  ...taskRecord,
  status: 'developing',
  runs: [],
}])[0]
assert.equal(mistakenTaskDto.canDelete, true)
assert.equal(mistakenTaskDto.deleteBlockedReason, null)

const deletableTaskDto = toIntegrationTaskListDto([{
  ...taskRecord,
  status: 'submitted',
  runs: [{
    ...taskRecord.runs[0],
    claimOwner: null,
    claimExpiresAt: null,
    worktreeStatus: 'cleaned',
    worktreePath: null,
    worktreeLeaseCipher: null,
    opencodeDisposedAt: deletionSafeAt,
    cleanupStatus: 'completed',
    cleanupCompletedAt: deletionSafeAt,
    artifacts: [{
      ...taskRecord.runs[0].artifacts[0],
      sessionDeletedAt: deletionSafeAt,
    }],
  }],
}])[0]
assert.equal(deletableTaskDto.canDelete, true)
assert.equal(deletableTaskDto.deleteBlockedReason, null)

const staleClaimTaskDto = toIntegrationTaskListDto([{
  ...taskRecord,
  runs: [{
    ...taskRecord.runs[0],
    claimOwner: 'crashed-worker',
    claimExpiresAt: new Date('2000-01-01T00:00:00.000Z'),
    worktreeStatus: 'cleaned',
    worktreePath: null,
    worktreeLeaseCipher: null,
    opencodeDisposedAt: deletionSafeAt,
    cleanupStatus: 'completed',
    cleanupCompletedAt: deletionSafeAt,
    artifacts: [{
      ...taskRecord.runs[0].artifacts[0],
      sessionDeletedAt: deletionSafeAt,
    }],
  }],
}])[0]
assert.equal(staleClaimTaskDto.canDelete, true)
assert.equal(staleClaimTaskDto.deleteBlockedReason, null)

const cleanupBlockedDeleteDto = toIntegrationTaskListDto([{
  ...taskRecord,
  status: 'submitted',
  runs: [{
    ...taskRecord.runs[0],
    claimOwner: null,
    claimExpiresAt: null,
    cleanupStatus: 'pending',
  }],
}])[0]
assert.equal(cleanupBlockedDeleteDto.canDelete, false)
assert.equal(
  cleanupBlockedDeleteDto.deleteBlockedReason,
  '自动化执行或隔离资源清理完成后可删除。',
)

function assertNoInternalKeys(value) {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    assert.doesNotMatch(
      key,
      /repoRoot|runtime|worktree|session|lease|token|claim|triggerKey|outputPath|skillDigest|promptState|abort|terminalAck/i,
      `public DTO leaked internal field ${key}`,
    )
    assertNoInternalKeys(child)
  }
}

assertNoInternalKeys(listDto)
assertNoInternalKeys(detailDto)

function collectStringValues(value, values = []) {
  if (typeof value === 'string') {
    values.push(value)
    return values
  }
  if (!value || typeof value !== 'object') return values
  for (const child of Object.values(value)) collectStringValues(child, values)
  return values
}

for (const value of collectStringValues([listDto, detailDto])) {
  assert.doesNotMatch(
    value,
    /\/secret\/|raw-secret|sk_live_|OPENCODE_INTEGRATION_SERVER_PASSWORD/i,
    `public DTO leaked a sensitive string: ${value}`,
  )
}

const retryReadyDto = toIntegrationTaskListDto([{
  ...taskRecord,
  automationStatus: 'failed',
  runs: [{
    ...taskRecord.runs[0],
    sequence: 2,
    status: 'failed',
    cleanupStatus: 'completed',
  }],
}])[0]
assert.equal(retryReadyDto.canRetry, true)
assert.equal(retryReadyDto.retryBlockedReason, null)

const cleanupPendingDto = toIntegrationTaskListDto([{
  ...taskRecord,
  automationStatus: 'failed',
  runs: [{
    ...taskRecord.runs[0],
    sequence: 2,
    status: 'failed',
    cleanupStatus: 'cleaning',
  }],
}])[0]
assert.equal(cleanupPendingDto.canRetry, false)
assert.equal(cleanupPendingDto.retryBlockedReason, '隔离资源正在清理，完成后可重试。')

const rerunStagePolicies = [
  ['developing', [], null],
  ['submitted', ['submit_review_and_tests'], null],
  ['merge_pending', ['submit_review_and_tests', 'pre_merge_review'], null],
  ['merged', ['submit_review_and_tests', 'pre_merge_review'], null],
  ['closed', [], null],
]
for (const [status, rerunnableStages, rerunBlockedReason] of rerunStagePolicies) {
  const finalReviewRun = {
    ...taskRecord.runs[0],
    id: 'run-final',
    sequence: 2,
    stage: 'pre_merge_review',
    artifacts: [{
      ...taskRecord.runs[0].artifacts[0],
      id: 'artifact-final',
      type: 'final_review',
      opencodeSessionId: 'session-final-secret',
    }],
  }
  const dto = toIntegrationTaskListDto([{
    ...taskRecord,
    status,
    runs: status === 'merge_pending' || status === 'merged'
      ? [taskRecord.runs[0], finalReviewRun]
      : taskRecord.runs,
  }])[0]
  assert.deepEqual(
    dto.rerunnableStages,
    rerunnableStages,
    `${status} 必须只开放约定阶段的主动重跑`,
  )
  assert.equal(dto.rerunBlockedReason, rerunBlockedReason)
}

const rerunActiveDto = toIntegrationTaskListDto([{
  ...taskRecord,
  status: 'merge_pending',
  automationStatus: 'running',
  runs: [{
    ...taskRecord.runs[0],
    sequence: 2,
    stage: 'pre_merge_review',
    status: 'running',
    cleanupStatus: 'not_ready',
  }],
}])[0]
assert.deepEqual(rerunActiveDto.rerunnableStages, [])
assert.ok(rerunActiveDto.rerunBlockedReason, '活动运行期间必须解释主动重跑为何不可用')

const rerunCleanupPendingDto = toIntegrationTaskListDto([{
  ...taskRecord,
  status: 'merge_pending',
  runs: [{
    ...taskRecord.runs[0],
    sequence: 2,
    stage: 'pre_merge_review',
    status: 'succeeded',
    cleanupStatus: 'cleaning',
  }],
}])[0]
assert.deepEqual(rerunCleanupPendingDto.rerunnableStages, [])
assert.ok(
  rerunCleanupPendingDto.rerunBlockedReason,
  '终态运行清理完成前必须解释主动重跑为何不可用',
)

const malformedErrorCodeDto = toIntegrationTaskListDto([{
  ...taskRecord,
  runs: [{
    ...taskRecord.runs[0],
    errorCode: '/secret/raw-secret-code',
    error: '/secret/raw-secret-error',
  }],
}])[0]
assert.equal(malformedErrorCodeDto.runs[0].errorCode, 'INTERNAL_ERROR')
assert.equal(
  malformedErrorCodeDto.runs[0].error,
  '自动化执行失败，请联系集成人员查看服务端日志。',
)
for (const value of collectStringValues(malformedErrorCodeDto)) {
  assert.doesNotMatch(value, /\/secret\/|raw-secret/i)
}

assert.deepEqual(parseIntegrationRetryInput({}), {})
assert.deepEqual(
  parseIntegrationRetryInput({ expectedRunId: 'cm7run_123' }),
  { expectedRunId: 'cm7run_123' },
)
assertContractError(
  () => parseIntegrationRetryInput({ expectedRunId: ' ' }),
  'INVALID_INPUT',
  'expectedRunId',
)

assert.deepEqual(
  parseIntegrationRerunInput({
    stage: 'submit_review_and_tests',
    expectedRunId: 'cm7run_123',
  }),
  {
    stage: 'submit_review_and_tests',
    expectedRunId: 'cm7run_123',
  },
)
assert.deepEqual(
  parseIntegrationRerunInput({
    stage: 'pre_merge_review',
    expectedRunId: 'cm7run_final_123',
  }),
  {
    stage: 'pre_merge_review',
    expectedRunId: 'cm7run_final_123',
  },
)
for (const [body, field] of [
  [{ expectedRunId: 'cm7run_123' }, 'stage'],
  [{ stage: 'submit_review_and_tests' }, 'expectedRunId'],
  [{ stage: 'unknown', expectedRunId: 'cm7run_123' }, 'stage'],
  [{ stage: 'submit_review_and_tests', expectedRunId: '../run' }, 'expectedRunId'],
  [{ stage: 'submit_review_and_tests', expectedRunId: 'cm7run_123', force: true }, 'body'],
]) {
  assertContractError(
    () => parseIntegrationRerunInput(body),
    'INVALID_INPUT',
    field,
  )
}

const reviewNoteInput = '  该问题是 Android 与鸿蒙交互差异，已与测试确认。\n保留当前实现。  '
assert.deepEqual(
  parseIntegrationReviewNoteInput({
    note: reviewNoteInput,
    expectedUpdatedAt: '2026-07-17T01:45:00.000Z',
  }),
  {
    note: reviewNoteInput.trim(),
    expectedUpdatedAt: new Date('2026-07-17T01:45:00.000Z'),
  },
)
assert.deepEqual(
  parseIntegrationReviewNoteInput({ note: '  ', expectedUpdatedAt: null }),
  { note: null, expectedUpdatedAt: null },
  '空白说明必须归一化为 null，以支持清空说明',
)
assert.equal(
  parseIntegrationReviewNoteInput({
    note: '说'.repeat(4_000),
    expectedUpdatedAt: null,
  }).note?.length,
  4_000,
)
for (const [body, field] of [
  [{ note: '说'.repeat(4_001), expectedUpdatedAt: null }, 'note'],
  [{ note: 1, expectedUpdatedAt: null }, 'note'],
  [{ note: '说明' }, 'expectedUpdatedAt'],
  [{ note: '说明', expectedUpdatedAt: '2026-07-17' }, 'expectedUpdatedAt'],
  [{ note: '说明', expectedUpdatedAt: 'not-a-date' }, 'expectedUpdatedAt'],
  [{ note: '说明', expectedUpdatedAt: null, artifactId: 'forbidden' }, 'body'],
]) {
  assertContractError(
    () => parseIntegrationReviewNoteInput(body),
    'INVALID_INPUT',
    field,
  )
}
assertContractError(
  () => parseIntegrationRetryInput({ expectedRunId: 'run/../../etc' }),
  'INVALID_INPUT',
  'expectedRunId',
)
assertContractError(
  () => parseIntegrationRetryInput({ runId: 'cm7run_123' }),
  'INVALID_INPUT',
  'body',
)

assert.deepEqual(
  parseIntegrationStatusUpdateInput({
    expectedStatus: 'developing',
    status: 'submitted',
  }),
  {
    expectedStatus: 'developing',
    status: 'submitted',
  },
)
assert.deepEqual(
  parseIntegrationStatusUpdateInput({
    expectedStatus: 'submitted',
    status: 'submitted',
  }),
  {
    expectedStatus: 'submitted',
    status: 'submitted',
  },
)
assertContractError(
  () => parseIntegrationStatusUpdateInput({ status: 'submitted' }),
  'INVALID_STATUS',
  'expectedStatus',
)
assertContractError(
  () => parseIntegrationStatusUpdateInput({
    expectedStatus: 'developing',
    status: 'unknown',
  }),
  'INVALID_STATUS',
  'status',
)
assertContractError(
  () => parseIntegrationStatusUpdateInput({
    expectedStatus: 'developing',
    status: 'merge_pending',
  }),
  'INVALID_STATUS_TRANSITION',
  'status',
)
assertContractError(
  () => parseIntegrationStatusUpdateInput({
    expectedStatus: 'developing',
    status: 'submitted',
    force: true,
  }),
  'INVALID_INPUT',
  'body',
)
assertContractError(
  () => parseCreateIntegrationTaskInput({
    title: ' ',
    projectId: 'ktv',
    sourceBranch: 'feature/song-list',
  }, projects),
  'INVALID_INPUT',
  'title',
)
assertContractError(
  () => parseCreateIntegrationTaskInput({
    title: '点歌台\n迁移',
    projectId: 'ktv',
    sourceBranch: 'feature/song-list',
  }, projects),
  'INVALID_INPUT',
  'title',
)
assertContractError(
  () => parseCreateIntegrationTaskInput({
    title: '点歌台迁移',
    projectId: 'missing',
    sourceBranch: 'feature/song-list',
  }, projects),
  'PROJECT_NOT_FOUND',
  'projectId',
)
assertContractError(
  () => parseCreateIntegrationTaskInput({
    title: '点歌台迁移',
    projectId: 'ktv',
    sourceBranch: 'feature/$(whoami)',
  }, projects),
  'INVALID_BRANCH',
  'sourceBranch',
)
assertContractError(
  () => parseCreateIntegrationTaskInput({
    title: '点歌台迁移',
    projectId: 'ktv',
    sourceBranch: 'feature/song-list',
    targetBranch: 'feature/song-list',
  }, projects),
  'INVALID_BRANCH',
  'targetBranch',
)
assertContractError(
  () => parseCreateIntegrationTaskInput({
    title: '点歌台迁移',
    projectId: 'ktv',
    sourceBranch: 'feature/song-list',
    status: 'submitted',
  }, projects),
  'INVALID_INPUT',
  'body',
)
assertContractError(
  () => parseCreateIntegrationTaskInput({
    title: '点歌台迁移',
    projectId: 'ktv',
    sourceBranch: 'feature/feature-desc-over-limit',
    featureDesc: '需'.repeat(4_001),
  }, projects),
  'INVALID_INPUT',
  'featureDesc',
)

async function assertJsonError(response, status, error, field) {
  assert.equal(response.status, status)
  assert.match(response.headers.get('content-type') || '', /^application\/json\b/)
  const payload = await response.json()
  assert.equal(payload.error, error)
  if (field === undefined) {
    assert.equal('field' in payload, false)
  } else {
    assert.equal(payload.field, field)
  }
  assert.equal('message' in payload, false)
  return payload
}

assert.deepEqual(
  await readIntegrationJsonBody(new Request('http://localhost/api/integration/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ title: '点歌台迁移' }),
  })),
  { title: '点歌台迁移' },
)

await assert.rejects(
  readIntegrationJsonBody(new Request('http://localhost/api/integration/tasks', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{}',
  })),
  (error) => error instanceof IntegrationHttpError &&
    error.code === 'UNSUPPORTED_MEDIA_TYPE' &&
    error.httpStatus === 415,
)

await assert.rejects(
  readIntegrationJsonBody(new Request('http://localhost/api/integration/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"title":',
  })),
  (error) => error instanceof IntegrationHttpError &&
    error.code === 'INVALID_JSON' &&
    error.httpStatus === 400,
)

await assert.rejects(
  readIntegrationJsonBody(new Request('http://localhost/api/integration/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '',
  })),
  (error) => error instanceof IntegrationHttpError &&
    error.code === 'INVALID_JSON' &&
    error.httpStatus === 400,
)

await assert.rejects(
  readIntegrationJsonBody(new Request('http://localhost/api/integration/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ featureDesc: 'x'.repeat(512) }),
  }), { maxBytes: 128 }),
  (error) => error instanceof IntegrationHttpError &&
    error.code === 'BODY_TOO_LARGE' &&
    error.httpStatus === 413,
)

await assert.rejects(
  readIntegrationJsonBody(new Request('http://localhost/api/integration/tasks', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': '999999',
    },
    body: '{}',
  }), { maxBytes: 128 }),
  (error) => error instanceof IntegrationHttpError &&
    error.code === 'BODY_TOO_LARGE' &&
    error.httpStatus === 413,
)

assert.deepEqual(
  parseIntegrationTaskFilters(
    new URL('http://localhost/api/integration/tasks?projectId=ktv&status=submitted'),
    projects,
  ),
  { projectId: 'ktv', status: 'submitted' },
)
assert.deepEqual(
  parseIntegrationTaskFilters(
    new URL('http://localhost/api/integration/tasks'),
    projects,
  ),
  {},
)
assert.throws(
  () => parseIntegrationTaskFilters(
    new URL('http://localhost/api/integration/tasks?projectId=missing'),
    projects,
  ),
  (error) => error instanceof IntegrationApiContractError &&
    error.code === 'PROJECT_NOT_FOUND' &&
    error.field === 'projectId',
)
assert.throws(
  () => parseIntegrationTaskFilters(
    new URL('http://localhost/api/integration/tasks?status=unknown'),
    projects,
  ),
  (error) => error instanceof IntegrationApiContractError &&
    error.code === 'INVALID_STATUS' &&
    error.field === 'status',
)
assert.throws(
  () => parseIntegrationTaskFilters(
    new URL('http://localhost/api/integration/tasks?status=submitted&status=closed'),
    projects,
  ),
  (error) => error instanceof IntegrationHttpError &&
    error.code === 'INVALID_QUERY',
)
assert.throws(
  () => parseIntegrationTaskFilters(
    new URL('http://localhost/api/integration/tasks?include=repoRoot'),
    projects,
  ),
  (error) => error instanceof IntegrationHttpError &&
    error.code === 'INVALID_QUERY',
)

assert.equal(requireIntegrationResourceId('cm7task_123'), 'cm7task_123')
assert.throws(
  () => requireIntegrationResourceId('../secret'),
  (error) => error instanceof IntegrationHttpError &&
    error.code === 'INVALID_RESOURCE_ID',
)

await assertJsonError(
  integrationErrorResponse(
    new IntegrationApiContractError('INVALID_BRANCH', '内部输入细节', 'sourceBranch'),
  ),
  400,
  'INVALID_BRANCH',
  'sourceBranch',
)
await assertJsonError(
  integrationErrorResponse(
    new IntegrationStoreError('STATUS_CAS_CONFLICT', '内部状态细节'),
  ),
  409,
  'STATUS_CAS_CONFLICT',
)
await assertJsonError(
  integrationErrorResponse(
    new IntegrationStoreError('TASK_NOT_FOUND', '包含敏感任务标识'),
  ),
  404,
  'TASK_NOT_FOUND',
)
await assertJsonError(
  integrationErrorResponse(
    new IntegrationStoreError('TASK_DELETE_BLOCKED', '内部清理状态'),
  ),
  409,
  'TASK_DELETE_BLOCKED',
)
for (const code of [
  'RERUN_STAGE_NOT_ALLOWED',
  'RUN_ACTIVE',
  'RUN_CLEANUP_PENDING',
  'RUN_CAS_CONFLICT',
  'ARTIFACT_NOT_REVIEW',
  'ARTIFACT_NOT_SUCCEEDED',
  'REVIEW_NOTE_CAS_CONFLICT',
]) {
  await assertJsonError(
    integrationErrorResponse(new IntegrationStoreError(code, '内部状态细节')),
    409,
    code,
  )
}
await assertJsonError(
  integrationErrorResponse(new IntegrationStoreError('ARTIFACT_NOT_FOUND', '内部产物标识')),
  404,
  'ARTIFACT_NOT_FOUND',
)
const internalPayload = await assertJsonError(
  integrationErrorResponse(new Error('/secret/repo: database unavailable')),
  500,
  'INTERNAL_ERROR',
)
assert.doesNotMatch(JSON.stringify(internalPayload), /secret|database unavailable/i)

const routeContracts = [
  {
    path: 'src/app/api/integration/projects/route.ts',
    methods: ['GET'],
    patterns: [/verifyBearer/, /toPublicIntegrationProjects/],
  },
  {
    path: 'src/app/api/integration/tasks/route.ts',
    methods: ['GET', 'POST'],
    patterns: [
      /verifyBearer/,
      /readIntegrationJsonBody/,
      /parseCreateIntegrationTaskInput/,
      /toIntegrationTask(?:List|Summary)Dto/,
    ],
  },
  {
    path: 'src/app/api/integration/tasks/[id]/route.ts',
    methods: ['GET', 'PATCH', 'DELETE'],
    patterns: [
      /verifyBearer/,
      /readIntegrationJsonBody/,
      /parseIntegrationStatusUpdateInput/,
      /transitionIntegrationTaskStatus/,
      /deleteIntegrationTask/,
      /enqueueIntegrationRun\s*\(\s*result\.run\.id\s*\)/,
      /status:\s*result\.run\s*\?\s*202\s*:\s*200/,
      /status:\s*204/,
      /toIntegrationTaskDetailDto/,
    ],
  },
  {
    path: 'src/app/api/integration/tasks/[id]/retry/route.ts',
    methods: ['POST'],
    patterns: [
      /verifyBearer/,
      /readIntegrationJsonBody/,
      /parseIntegrationRetryInput/,
      /retryLatestIntegrationRun/,
      /expectedRunId/,
      /enqueueIntegrationRun\s*\(\s*run\.id\s*\)/,
      /status:\s*202/,
    ],
  },
  {
    path: 'src/app/api/integration/tasks/[id]/rerun/route.ts',
    methods: ['POST'],
    patterns: [
      /verifyBearer/,
      /readIntegrationJsonBody/,
      /parseIntegrationRerunInput/,
      /rerunIntegrationStage/,
      /stage/,
      /expectedRunId/,
      /enqueueIntegrationRun\s*\(\s*run\.id\s*\)/,
      /status:\s*202/,
      /toIntegrationTaskSummaryDto/,
    ],
  },
  {
    path: 'src/app/api/integration/tasks/[id]/artifacts/[artifactId]/note/route.ts',
    methods: ['PATCH'],
    patterns: [
      /verifyBearer/,
      /readIntegrationJsonBody/,
      /requireIntegrationResourceId/,
      /parseIntegrationReviewNoteInput/,
      /updateIntegrationArtifactReviewNote/,
      /actorTokenId:\s*token\.id/,
      /toIntegrationTaskDetailDto/,
    ],
  },
  {
    path: 'src/app/api/integration/tasks/[id]/conflicts/route.ts',
    methods: ['POST'],
    patterns: [
      /verifyBearer/,
      /requireIntegrationResourceId/,
      /getIntegrationTask/,
      /task\.status\s*!==\s*['"]merge_pending['"]/,
      /loadIntegrationProjects/,
      /checkLatestIntegrationTaskConflicts/,
      /cache-control['"]:\s*['"]no-store/,
    ],
  },
]

for (const contract of routeContracts) {
  const source = await readFile(new URL(`../${contract.path}`, import.meta.url), 'utf8')
  assert.match(source, /export const runtime\s*=\s*['"]nodejs['"]/)
  for (const method of contract.methods) {
    assert.match(source, new RegExp(`export async function ${method}\\b`))
  }
  for (const pattern of contract.patterns) {
    assert.match(source, pattern, `${contract.path} 缺少契约 ${pattern}`)
  }
  assert.doesNotMatch(source, /repoRoot\s*:/, `${contract.path} 不得直接返回 repoRoot`)
}
