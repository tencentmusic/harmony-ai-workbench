import assert from 'node:assert/strict'

import { recoverClaimedIntegrationRun } from '../src/server/modules/integration/integration-recovery.ts'

function baseInput(overrides = {}) {
  return {
    run: {
      id: 'run-recovery-1',
      taskId: 'task-1',
      status: 'running',
      opencodeDisposedAt: null,
    },
    task: {
      id: 'task-1',
      projectId: 'project-1',
    },
    project: {
      id: 'project-1',
      repoRoot: '/repo',
      runtimeRoot: '/runtime',
    },
    claim: {
      owner: 'recovery-worker',
      epoch: 7,
    },
    worktreeLease: {
      repoRoot: '/repo',
      runtimeRoot: '/runtime',
      runId: 'run-recovery-1',
      leaseToken: 'a'.repeat(64),
    },
    artifacts: [{
      id: 'artifact-review',
      status: 'running',
      promptState: 'submitted',
      opencodeSessionId: 'ses_review',
      terminalAckAt: null,
      sessionDeletedAt: null,
    }],
    ...overrides,
  }
}

function successfulDependencies(events) {
  const fence = {
    owner: 'recovery-worker',
    epoch: 7,
  }
  return {
    async reclaimActiveIntegrationWorktreeLease(lease) {
      events.push(['reclaim', lease.runId])
      return { repoPath: '/runtime/run-recovery-1/repo' }
    },
    async createRecoveryOpencodeClient({ directory }) {
      events.push(['client', directory])
      return {
        async abortSession(sessionId) {
          events.push(['abort', sessionId])
          return true
        },
        async getSessionStatuses() {
          events.push(['status'])
          return {}
        },
        async promptAsync() {
          events.push(['prompt'])
        },
      }
    },
    async cleanupIntegrationOpencodeResources(input) {
      events.push(['remote-cleanup', [...input.sessionIds]])
      return {
        status: 'safe',
        sessionIds: [...input.sessionIds],
        deletedSessionIds: [...input.sessionIds],
        pendingSessionIds: [],
        dispose: { status: 'confirmed' },
        issues: [],
      }
    },
    async cleanupIntegrationWorktree(lease) {
      events.push(['local-cleanup', lease.runId])
    },
    store: {
      async markIntegrationArtifactPromptAcceptanceUnknown(input) {
        assert.deepEqual(input, { artifactId: 'artifact-review', ...fence })
        events.push(['acceptance-unknown'])
      },
      async markIntegrationArtifactAbortRequested(input) {
        assert.deepEqual(input, { artifactId: 'artifact-review', ...fence })
        events.push(['abort-requested'])
      },
      async recordIntegrationArtifactAbortResponse(input) {
        assert.deepEqual(input, {
          artifactId: 'artifact-review',
          ...fence,
          abortAccepted: true,
        })
        events.push(['abort-response', input.abortAccepted])
      },
      async recordIntegrationArtifactAbortFailure() {
        assert.fail('successful recovery must not persist abort failure')
      },
      async acknowledgeIntegrationArtifactTerminal(input) {
        assert.deepEqual(input, {
          artifactId: 'artifact-review',
          ...fence,
          source: 'status_endpoint_idle',
        })
        events.push(['terminal-ack'])
      },
      async failIntegrationRunExecution(input) {
        assert.deepEqual(input, {
          runId: 'run-recovery-1',
          ...fence,
          errorCode: 'RECOVERY_INTERRUPTED',
          error: '集成运行在 OpenCode 执行期间中断，已由恢复流程安全终止',
        })
        events.push(['terminalize'])
        return { status: 'failed' }
      },
      async finishIntegrationRunFromArtifacts() {
        assert.fail('running artifacts must be failed during recovery')
      },
      async recordIntegrationArtifactSessionDeleted(input) {
        assert.deepEqual(input, { artifactId: 'artifact-review', ...fence })
        events.push(['session-deleted'])
      },
      async recordIntegrationArtifactSessionDeleteFailure() {
        assert.fail('successful recovery must not persist delete failure')
      },
      async recordIntegrationRunOpencodeDisposed(input) {
        assert.deepEqual(input, { runId: 'run-recovery-1', ...fence })
        events.push(['disposed'])
      },
      async recordIntegrationRunOpencodeDisposeFailure() {
        assert.fail('successful recovery must not persist dispose failure')
      },
      async markIntegrationRunCleanupPending() {
        assert.fail('successful recovery must not remain pending')
      },
      async markIntegrationRunCleanupSafeIfTerminal(input) {
        assert.deepEqual(input, { runId: 'run-recovery-1', ...fence })
        events.push(['cleanup-safe'])
        return { safe: true }
      },
      async beginIntegrationRunCleanup(input) {
        assert.deepEqual(input, { runId: 'run-recovery-1', ...fence })
        events.push(['begin-local-cleanup'])
      },
      async finishIntegrationRunCleanup(input) {
        assert.deepEqual(input, { runId: 'run-recovery-1', ...fence })
        events.push(['finish-local-cleanup'])
      },
      async failIntegrationRunCleanup() {
        assert.fail('successful recovery must not fail local cleanup')
      },
    },
  }
}

{
  const events = []
  const result = await recoverClaimedIntegrationRun(
    baseInput(),
    successfulDependencies(events),
  )

  assert.deepEqual(result, {
    runId: 'run-recovery-1',
    status: 'completed',
  })
  assert.equal(events.some(([event]) => event === 'prompt'), false)
  assert.deepEqual(events.map(([event]) => event), [
    'reclaim',
    'acceptance-unknown',
    'abort-requested',
    'client',
    'abort',
    'abort-response',
    'status',
    'terminal-ack',
    'terminalize',
    'remote-cleanup',
    'session-deleted',
    'disposed',
    'cleanup-safe',
    'begin-local-cleanup',
    'local-cleanup',
    'finish-local-cleanup',
  ])
}

{
  const events = []
  const result = await recoverClaimedIntegrationRun(baseInput(), {
    async reclaimActiveIntegrationWorktreeLease() {
      events.push('reclaim')
      return { repoPath: '/runtime/run-recovery-1/repo' }
    },
    async createRecoveryOpencodeClient() {
      return {
        async abortSession() {
          events.push('abort-false')
          return false
        },
        async getSessionStatuses() {
          assert.fail('abort=false 后不能把 status 当作可靠终态确认')
        },
      }
    },
    async cleanupIntegrationOpencodeResources() {
      assert.fail('session 未安全终止时不能清理远端资源')
    },
    async cleanupIntegrationWorktree() {
      assert.fail('session 未安全终止时不能清理 worktree')
    },
    store: {
      async markIntegrationArtifactPromptAcceptanceUnknown() {
        events.push('acceptance-unknown')
      },
      async markIntegrationArtifactAbortRequested() {
        events.push('abort-requested')
      },
      async recordIntegrationArtifactAbortResponse({ abortAccepted }) {
        events.push(`abort-response:${abortAccepted}`)
      },
      async markIntegrationRunCleanupPending({
        cleanupErrorCode,
      }) {
        events.push(`pending:${cleanupErrorCode}`)
      },
    },
  })

  assert.deepEqual(result, {
    runId: 'run-recovery-1',
    status: 'pending',
  })
  assert.deepEqual(events, [
    'reclaim',
    'acceptance-unknown',
    'abort-requested',
    'abort-false',
    'abort-response:false',
    'pending:RECOVERY_ABORT_NOT_CONFIRMED',
  ])
}

{
  const events = []
  const result = await recoverClaimedIntegrationRun(baseInput({
    artifacts: [{
      id: 'artifact-review',
      status: 'running',
      promptState: 'accepted',
      opencodeSessionId: 'ses_review',
      terminalAckAt: null,
      sessionDeletedAt: null,
    }],
  }), {
    async reclaimActiveIntegrationWorktreeLease() {
      return { repoPath: '/runtime/run-recovery-1/repo' }
    },
    async createRecoveryOpencodeClient() {
      return {
        async abortSession() {
          throw Object.assign(new Error('Authorization: Basic secret-value'), {
            code: 'ABORT_FAILED',
          })
        },
        async getSessionStatuses() {
          assert.fail('abort 异常后不能请求 status 并确认终态')
        },
      }
    },
    async cleanupIntegrationOpencodeResources() {
      assert.fail('abort 异常后不能清理远端资源')
    },
    async cleanupIntegrationWorktree() {
      assert.fail('abort 异常后不能清理 worktree')
    },
    store: {
      async markIntegrationArtifactAbortRequested() {
        events.push('abort-requested')
      },
      async recordIntegrationArtifactAbortFailure({
        errorCode,
        error,
      }) {
        events.push(`abort-failure:${errorCode}:${error}`)
      },
      async markIntegrationRunCleanupPending({
        cleanupErrorCode,
      }) {
        events.push(`pending:${cleanupErrorCode}`)
      },
    },
  })

  assert.deepEqual(result, {
    runId: 'run-recovery-1',
    status: 'pending',
  })
  assert.deepEqual(events, [
    'abort-requested',
    'abort-failure:ABORT_FAILED:OpenCode abort 请求失败',
    'pending:RECOVERY_ABORT_FAILED',
  ])
  assert.equal(JSON.stringify(events).includes('secret-value'), false)
}

{
  const events = []
  const result = await recoverClaimedIntegrationRun(baseInput({
    run: {
      id: 'run-recovery-1',
      taskId: 'task-1',
      status: 'failed',
      opencodeDisposedAt: null,
    },
    artifacts: [
      {
        id: 'artifact-review',
        status: 'failed',
        promptState: 'accepted',
        opencodeSessionId: 'ses_review',
        terminalAckAt: '2026-07-29T10:00:00.000Z',
        sessionDeletedAt: null,
      },
      {
        id: 'artifact-tests',
        status: 'failed',
        promptState: 'rejected',
        opencodeSessionId: 'ses_tests',
        terminalAckAt: null,
        sessionDeletedAt: null,
      },
    ],
  }), {
    async reclaimActiveIntegrationWorktreeLease() {
      events.push('reclaim')
      return { repoPath: '/runtime/run-recovery-1/repo' }
    },
    async createRecoveryOpencodeClient() {
      assert.fail('已有终态确认或 rejected 的 session 不应再次 abort')
    },
    async cleanupIntegrationOpencodeResources({ sessionIds }) {
      assert.deepEqual(sessionIds, ['ses_review', 'ses_tests'])
      events.push('remote-cleanup')
      return {
        status: 'pending',
        sessionIds: ['ses_review', 'ses_tests'],
        deletedSessionIds: ['ses_review'],
        pendingSessionIds: ['ses_tests'],
        dispose: { status: 'not_attempted' },
        issues: [{
          operation: 'session_delete',
          sessionId: 'ses_tests',
          errorCode: 'SESSION_DELETE_FAILED',
          error: 'delete transport failed',
        }],
      }
    },
    async cleanupIntegrationWorktree() {
      assert.fail('部分 session 删除失败时不能清理 worktree')
    },
    store: {
      async recordIntegrationArtifactSessionDeleted({ artifactId }) {
        events.push(`deleted:${artifactId}`)
      },
      async recordIntegrationArtifactSessionDeleteFailure({
        artifactId,
        errorCode,
        error,
      }) {
        events.push(`delete-failed:${artifactId}:${errorCode}:${error}`)
      },
      async markIntegrationRunCleanupPending({ cleanupErrorCode }) {
        events.push(`pending:${cleanupErrorCode}`)
      },
      async beginIntegrationRunCleanup() {
        assert.fail('部分远端清理失败时不能 begin 本地清理')
      },
    },
  })

  assert.deepEqual(result, {
    runId: 'run-recovery-1',
    status: 'pending',
  })
  assert.deepEqual(events, [
    'reclaim',
    'remote-cleanup',
    'deleted:artifact-review',
    'delete-failed:artifact-tests:SESSION_DELETE_FAILED:delete transport failed',
    'pending:RECOVERY_REMOTE_CLEANUP_PENDING',
  ])
}

{
  const events = []
  const artifacts = [
    {
      id: 'artifact-review',
      status: 'running',
      promptState: 'not_submitted',
      opencodeSessionId: 'ses_review',
      terminalAckAt: null,
      sessionDeletedAt: null,
    },
    {
      id: 'artifact-tests',
      status: 'running',
      promptState: 'rejected',
      opencodeSessionId: 'ses_tests',
      terminalAckAt: null,
      sessionDeletedAt: null,
    },
  ]
  const result = await recoverClaimedIntegrationRun(baseInput({ artifacts }), {
    async reclaimActiveIntegrationWorktreeLease() {
      events.push('reclaim')
      return { repoPath: '/runtime/run-recovery-1/repo' }
    },
    async createRecoveryOpencodeClient() {
      assert.fail('not_submitted/rejected session 不应 abort 或重新提交 prompt')
    },
    async cleanupIntegrationOpencodeResources({ sessionIds }) {
      events.push('remote-cleanup')
      return {
        status: 'safe',
        sessionIds: [...sessionIds],
        deletedSessionIds: [...sessionIds],
        pendingSessionIds: [],
        dispose: { status: 'confirmed' },
        issues: [],
      }
    },
    async cleanupIntegrationWorktree() {
      events.push('local-cleanup')
    },
    store: {
      async failIntegrationRunExecution() {
        events.push('terminalize')
        return { status: 'failed' }
      },
      async recordIntegrationArtifactSessionDeleted({ artifactId }) {
        events.push(`deleted:${artifactId}`)
      },
      async recordIntegrationRunOpencodeDisposed() {
        events.push('disposed')
      },
      async markIntegrationRunCleanupSafeIfTerminal() {
        events.push('cleanup-safe')
        return { safe: true }
      },
      async beginIntegrationRunCleanup() {
        events.push('begin-local-cleanup')
      },
      async finishIntegrationRunCleanup() {
        events.push('finish-local-cleanup')
      },
    },
  })

  assert.deepEqual(result, {
    runId: 'run-recovery-1',
    status: 'completed',
  })
  assert.deepEqual(events, [
    'reclaim',
    'terminalize',
    'remote-cleanup',
    'deleted:artifact-review',
    'deleted:artifact-tests',
    'disposed',
    'cleanup-safe',
    'begin-local-cleanup',
    'local-cleanup',
    'finish-local-cleanup',
  ])
}

{
  const events = []
  const result = await recoverClaimedIntegrationRun(baseInput({
    run: {
      id: 'run-recovery-1',
      taskId: 'task-1',
      status: 'failed',
      opencodeDisposedAt: null,
    },
    artifacts: [{
      id: 'artifact-review',
      status: 'failed',
      promptState: 'accepted',
      opencodeSessionId: 'ses_review',
      terminalAckAt: '2026-07-29T10:00:00.000Z',
      sessionDeletedAt: null,
    }],
  }), {
    async reclaimActiveIntegrationWorktreeLease() {
      return { repoPath: '/runtime/run-recovery-1/repo' }
    },
    async createRecoveryOpencodeClient() {
      assert.fail('已有 terminal ack 时不应再次 abort')
    },
    async cleanupIntegrationOpencodeResources() {
      return {
        status: 'pending',
        sessionIds: ['ses_review'],
        deletedSessionIds: ['ses_review'],
        pendingSessionIds: [],
        dispose: {
          status: 'pending',
          errorCode: 'INSTANCE_DISPOSE_FAILED',
          error: 'OpenCode directory instance 释放请求失败',
        },
        issues: [{
          operation: 'instance_dispose',
          errorCode: 'INSTANCE_DISPOSE_FAILED',
          error: 'OpenCode directory instance 释放请求失败',
        }],
      }
    },
    async cleanupIntegrationWorktree() {
      assert.fail('dispose 未确认时不能清理 worktree')
    },
    store: {
      async recordIntegrationArtifactSessionDeleted({ artifactId }) {
        events.push(`deleted:${artifactId}`)
      },
      async recordIntegrationRunOpencodeDisposeFailure({
        errorCode,
        error,
      }) {
        events.push(`dispose-failed:${errorCode}:${error}`)
      },
      async markIntegrationRunCleanupPending({ cleanupErrorCode }) {
        events.push(`pending:${cleanupErrorCode}`)
      },
      async beginIntegrationRunCleanup() {
        assert.fail('dispose 未确认时不能 begin 本地清理')
      },
    },
  })

  assert.deepEqual(result, {
    runId: 'run-recovery-1',
    status: 'pending',
  })
  assert.deepEqual(events, [
    'deleted:artifact-review',
    'dispose-failed:INSTANCE_DISPOSE_FAILED:OpenCode directory instance 释放请求失败',
    'pending:RECOVERY_REMOTE_CLEANUP_PENDING',
  ])
}

{
  const events = []
  const result = await recoverClaimedIntegrationRun(baseInput({
    artifacts: [{
      id: 'artifact-review',
      status: 'running',
      promptState: 'acceptance_unknown',
      opencodeSessionId: 'ses_review',
      terminalAckAt: null,
      sessionDeletedAt: null,
    }],
  }), {
    async reclaimActiveIntegrationWorktreeLease() {
      return { repoPath: '/runtime/run-recovery-1/repo' }
    },
    async createRecoveryOpencodeClient() {
      return {
        async abortSession() {
          events.push('abort-true')
          return true
        },
        async getSessionStatuses() {
          events.push('fresh-status')
          return { ses_review: { type: 'busy' } }
        },
      }
    },
    async cleanupIntegrationOpencodeResources() {
      assert.fail('fresh status 仍包含 session 时不能清理远端资源')
    },
    async cleanupIntegrationWorktree() {
      assert.fail('fresh status 仍包含 session 时不能清理 worktree')
    },
    store: {
      async markIntegrationArtifactAbortRequested() {
        events.push('abort-requested')
      },
      async recordIntegrationArtifactAbortResponse() {
        events.push('abort-response')
      },
      async acknowledgeIntegrationArtifactTerminal() {
        assert.fail('fresh status 仍包含 session 时不能持久化 terminal ack')
      },
      async markIntegrationRunCleanupPending({ cleanupErrorCode }) {
        events.push(`pending:${cleanupErrorCode}`)
      },
    },
  })

  assert.deepEqual(result, {
    runId: 'run-recovery-1',
    status: 'pending',
  })
  assert.deepEqual(events, [
    'abort-requested',
    'abort-true',
    'abort-response',
    'fresh-status',
    'pending:RECOVERY_SESSION_STILL_ACTIVE',
  ])
}

{
  await assert.rejects(
    recoverClaimedIntegrationRun(baseInput({
      worktreeLease: {
        repoRoot: '/repo',
        runtimeRoot: '/runtime',
        runId: 'different-run',
        leaseToken: 'a'.repeat(64),
      },
    }), {
      async reclaimActiveIntegrationWorktreeLease() {
        assert.fail('输入身份不一致时不能接管 worktree lease')
      },
    }),
    /worktreeLease\.runId 与 run\.id 不一致/,
  )
}

{
  const events = []
  const result = await recoverClaimedIntegrationRun(baseInput({
    run: {
      id: 'run-recovery-1',
      taskId: 'task-1',
      status: 'failed',
      opencodeDisposedAt: '2026-07-29T10:02:00.000Z',
    },
    artifacts: [{
      id: 'artifact-review',
      status: 'failed',
      promptState: 'accepted',
      opencodeSessionId: 'ses_review',
      terminalAckAt: '2026-07-29T10:00:00.000Z',
      sessionDeletedAt: '2026-07-29T10:01:00.000Z',
    }],
  }), {
    async reclaimActiveIntegrationWorktreeLease() {
      events.push('reclaim')
      return { repoPath: '/runtime/run-recovery-1/repo' }
    },
    async createRecoveryOpencodeClient() {
      assert.fail('已确认 terminal ack 的 session 不应再次访问 OpenCode')
    },
    async cleanupIntegrationOpencodeResources() {
      assert.fail('远端删除与 dispose checkpoint 已持久化时不能重复清理')
    },
    async cleanupIntegrationWorktree() {
      events.push('local-cleanup')
    },
    store: {
      async markIntegrationRunCleanupSafeIfTerminal() {
        events.push('cleanup-safe')
        return { safe: true }
      },
      async beginIntegrationRunCleanup() {
        events.push('begin-local-cleanup')
      },
      async finishIntegrationRunCleanup() {
        events.push('finish-local-cleanup')
      },
    },
  })

  assert.deepEqual(result, {
    runId: 'run-recovery-1',
    status: 'completed',
  })
  assert.deepEqual(events, [
    'reclaim',
    'cleanup-safe',
    'begin-local-cleanup',
    'local-cleanup',
    'finish-local-cleanup',
  ])
}

{
  const events = []
  const result = await recoverClaimedIntegrationRun(baseInput({
    artifacts: [{
      id: 'artifact-review',
      status: 'running',
      promptState: 'accepted',
      opencodeSessionId: 'ses_review',
      terminalAckAt: null,
      sessionDeletedAt: null,
    }],
  }), {
    async reclaimActiveIntegrationWorktreeLease() {
      return { repoPath: '/runtime/run-recovery-1/repo' }
    },
    async createRecoveryOpencodeClient() {
      return {
        async abortSession() {
          return true
        },
        async getSessionStatuses() {
          throw new Error('Authorization: Basic secret-value')
        },
      }
    },
    async cleanupIntegrationOpencodeResources() {
      assert.fail('status 查询异常时不能清理远端资源')
    },
    async cleanupIntegrationWorktree() {
      assert.fail('status 查询异常时不能清理 worktree')
    },
    store: {
      async markIntegrationArtifactAbortRequested() {
        events.push('abort-requested')
      },
      async recordIntegrationArtifactAbortResponse({ abortAccepted }) {
        events.push(`abort-response:${abortAccepted}`)
      },
      async acknowledgeIntegrationArtifactTerminal() {
        assert.fail('status 查询异常时不能持久化 terminal ack')
      },
      async markIntegrationRunCleanupPending({
        cleanupErrorCode,
        cleanupError,
      }) {
        events.push(`pending:${cleanupErrorCode}:${cleanupError}`)
      },
    },
  })

  assert.deepEqual(result, {
    runId: 'run-recovery-1',
    status: 'pending',
  })
  assert.deepEqual(events, [
    'abort-requested',
    'abort-response:true',
    'pending:RECOVERY_STATUS_FAILED:OpenCode session 终态查询失败，请稍后重试恢复',
  ])
  assert.equal(
    JSON.stringify(events).includes('secret-value'),
    false,
    '持久化消息不能泄露 transport 细节',
  )
}

{
  const events = []
  const result = await recoverClaimedIntegrationRun(baseInput({
    artifacts: [{
      id: 'artifact-review',
      status: 'running',
      promptState: 'accepted',
      opencodeSessionId: 'ses_review',
      terminalAckAt: null,
      sessionDeletedAt: null,
    }],
  }), {
    async reclaimActiveIntegrationWorktreeLease() {
      return { repoPath: '/runtime/run-recovery-1/repo' }
    },
    async createRecoveryOpencodeClient() {
      throw new Error('password=secret-value')
    },
    async cleanupIntegrationOpencodeResources() {
      assert.fail('client 初始化失败时不能清理远端资源')
    },
    async cleanupIntegrationWorktree() {
      assert.fail('client 初始化失败时不能清理 worktree')
    },
    store: {
      async markIntegrationArtifactAbortRequested() {
        events.push('abort-requested')
      },
      async recordIntegrationArtifactAbortFailure({
        errorCode,
        error,
      }) {
        events.push(`abort-failure:${errorCode}:${error}`)
      },
      async markIntegrationRunCleanupPending({
        cleanupErrorCode,
        cleanupError,
      }) {
        events.push(`pending:${cleanupErrorCode}:${cleanupError}`)
      },
    },
  })

  assert.deepEqual(result, {
    runId: 'run-recovery-1',
    status: 'pending',
  })
  assert.deepEqual(events, [
    'abort-requested',
    'abort-failure:ABORT_FAILED:OpenCode abort 请求失败',
    'pending:RECOVERY_ABORT_FAILED:OpenCode abort 请求失败，session 终态尚未确认',
  ])
  assert.equal(JSON.stringify(events).includes('secret-value'), false)
}

console.log('integration recovery tests passed')
