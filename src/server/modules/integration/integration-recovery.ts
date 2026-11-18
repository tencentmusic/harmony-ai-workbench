import type {
  IntegrationWorktreeInput,
  ValidateIntegrationWorktreeInput,
} from './integration-git'
import type {
  CleanupIntegrationOpencodeResourcesInput,
  IntegrationOpencodeRemoteCleanupResult,
} from './integration-opencode-cleanup'
import { isValidOpencodeSessionId } from '@/lib/opencode/opencode-session'

export type IntegrationRecoveryPromptState =
  | 'not_submitted'
  | 'submitted'
  | 'accepted'
  | 'acceptance_unknown'
  | 'rejected'

export interface IntegrationRecoveryRun {
  id: string
  taskId: string
  status: string
  opencodeDisposedAt?: Date | string | null
}

export interface IntegrationRecoveryTask {
  id: string
  projectId: string
}

export interface IntegrationRecoveryProject {
  id: string
  repoRoot: string
  runtimeRoot?: string
}

export interface IntegrationRecoveryArtifact {
  id: string
  status: string
  promptState: IntegrationRecoveryPromptState
  opencodeSessionId?: string | null
  terminalAckAt?: Date | string | null
  sessionDeletedAt?: Date | string | null
}

export interface IntegrationRecoveryClaim {
  owner: string
  epoch: number
}

export interface ClaimedIntegrationRecoveryInput {
  run: IntegrationRecoveryRun
  task: IntegrationRecoveryTask
  project: IntegrationRecoveryProject
  artifacts: readonly IntegrationRecoveryArtifact[]
  claim: IntegrationRecoveryClaim
  worktreeLease: ValidateIntegrationWorktreeInput
  signal?: AbortSignal
}

export interface IntegrationRecoveryRunFence {
  runId: string
  owner: string
  epoch: number
}

export interface IntegrationRecoveryArtifactFence {
  artifactId: string
  owner: string
  epoch: number
}

export interface IntegrationRecoveryStore {
  markIntegrationArtifactPromptAcceptanceUnknown(
    input: IntegrationRecoveryArtifactFence,
  ): Promise<unknown>
  markIntegrationArtifactAbortRequested(
    input: IntegrationRecoveryArtifactFence,
  ): Promise<unknown>
  recordIntegrationArtifactAbortResponse(
    input: IntegrationRecoveryArtifactFence & { abortAccepted: boolean },
  ): Promise<unknown>
  recordIntegrationArtifactAbortFailure(
    input: IntegrationRecoveryArtifactFence & {
      errorCode: string
      error: string
    },
  ): Promise<unknown>
  acknowledgeIntegrationArtifactTerminal(
    input: IntegrationRecoveryArtifactFence & {
      source: 'status_endpoint_idle'
    },
  ): Promise<unknown>
  failIntegrationRunExecution(
    input: IntegrationRecoveryRunFence & { errorCode: string; error: string },
  ): Promise<{ status?: string }>
  finishIntegrationRunFromArtifacts(
    input: IntegrationRecoveryRunFence,
  ): Promise<{ status?: string }>
  recordIntegrationArtifactSessionDeleted(
    input: IntegrationRecoveryArtifactFence,
  ): Promise<unknown>
  recordIntegrationArtifactSessionDeleteFailure(
    input: IntegrationRecoveryArtifactFence & {
      errorCode: string
      error: string
    },
  ): Promise<unknown>
  recordIntegrationRunOpencodeDisposed(
    input: IntegrationRecoveryRunFence,
  ): Promise<unknown>
  recordIntegrationRunOpencodeDisposeFailure(
    input: IntegrationRecoveryRunFence & {
      errorCode: string
      error: string
    },
  ): Promise<unknown>
  markIntegrationRunCleanupPending(
    input: IntegrationRecoveryRunFence & {
      cleanupErrorCode?: string | null
      cleanupError?: string | null
    },
  ): Promise<unknown>
  markIntegrationRunCleanupSafeIfTerminal(
    input: IntegrationRecoveryRunFence,
  ): Promise<{ safe: boolean }>
  beginIntegrationRunCleanup(
    input: IntegrationRecoveryRunFence,
  ): Promise<unknown>
  finishIntegrationRunCleanup(
    input: IntegrationRecoveryRunFence,
  ): Promise<unknown>
  failIntegrationRunCleanup(
    input: IntegrationRecoveryRunFence & {
      cleanupErrorCode: string
      cleanupError: string
    },
  ): Promise<unknown>
}

export interface IntegrationRecoveryOpencodeClient {
  abortSession(
    sessionId: string,
    options?: { signal?: AbortSignal },
  ): Promise<boolean>
  getSessionStatuses(options?: { signal?: AbortSignal }): Promise<unknown>
}

export interface IntegrationRecoveryDependencies {
  store: IntegrationRecoveryStore
  reclaimActiveIntegrationWorktreeLease(
    input: ValidateIntegrationWorktreeInput,
  ): Promise<{ repoPath: string }>
  createRecoveryOpencodeClient(input: {
    directory: string
  }): Promise<IntegrationRecoveryOpencodeClient>
  cleanupIntegrationOpencodeResources(
    input: CleanupIntegrationOpencodeResourcesInput,
  ): Promise<IntegrationOpencodeRemoteCleanupResult>
  cleanupIntegrationWorktree(input: IntegrationWorktreeInput): Promise<void>
}

export interface IntegrationRecoveryResult {
  runId: string
  status: 'pending' | 'completed' | 'local_cleanup_failed'
}

const RECOVERY_ERROR_CODE = 'RECOVERY_INTERRUPTED'
const RECOVERY_ERROR =
  '集成运行在 OpenCode 执行期间中断，已由恢复流程安全终止'

function requireNonEmpty(name: string, value: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${name} 不能为空`)
  }
}

function validateRecoveryInput(input: ClaimedIntegrationRecoveryInput): void {
  requireNonEmpty('run.id', input.run.id)
  requireNonEmpty('task.id', input.task.id)
  requireNonEmpty('project.id', input.project.id)
  requireNonEmpty('claim.owner', input.claim.owner)
  if (!Number.isSafeInteger(input.claim.epoch) || input.claim.epoch <= 0) {
    throw new TypeError('claim.epoch 必须是正整数')
  }
  if (input.run.taskId !== input.task.id) {
    throw new TypeError('run.taskId 与 task.id 不一致')
  }
  if (input.task.projectId !== input.project.id) {
    throw new TypeError('task.projectId 与 project.id 不一致')
  }
  if (input.worktreeLease.runId !== input.run.id) {
    throw new TypeError('worktreeLease.runId 与 run.id 不一致')
  }
  if (input.worktreeLease.repoRoot !== input.project.repoRoot) {
    throw new TypeError('worktreeLease.repoRoot 与 project.repoRoot 不一致')
  }
  if (
    (input.worktreeLease.runtimeRoot ?? undefined) !==
      (input.project.runtimeRoot ?? undefined)
  ) {
    throw new TypeError(
      'worktreeLease.runtimeRoot 与 project.runtimeRoot 不一致',
    )
  }
  if (input.artifacts.length === 0) {
    throw new TypeError('恢复运行至少需要一个产物')
  }
  const artifactIds = new Set<string>()
  const sessionIds = new Set<string>()
  for (const artifact of input.artifacts) {
    requireNonEmpty('artifact.id', artifact.id)
    if (artifactIds.has(artifact.id)) {
      throw new TypeError(`恢复运行包含重复产物：${artifact.id}`)
    }
    artifactIds.add(artifact.id)
    if (artifact.opencodeSessionId) {
      if (!isValidOpencodeSessionId(artifact.opencodeSessionId)) {
        throw new TypeError(`产物 ${artifact.id} 的 OpenCode session id 无效`)
      }
      if (sessionIds.has(artifact.opencodeSessionId)) {
        throw new TypeError(
          `恢复运行包含重复 OpenCode session：${artifact.opencodeSessionId}`,
        )
      }
      sessionIds.add(artifact.opencodeSessionId)
    } else if (
      artifact.promptState === 'submitted' ||
      artifact.promptState === 'accepted' ||
      artifact.promptState === 'acceptance_unknown'
    ) {
      throw new TypeError(
        `产物 ${artifact.id} 的 prompt 状态需要 OpenCode session`,
      )
    }
  }
}

function runFence(
  input: ClaimedIntegrationRecoveryInput,
): IntegrationRecoveryRunFence {
  return {
    runId: input.run.id,
    owner: input.claim.owner,
    epoch: input.claim.epoch,
  }
}

function artifactFence(
  input: ClaimedIntegrationRecoveryInput,
  artifact: IntegrationRecoveryArtifact,
): IntegrationRecoveryArtifactFence {
  return {
    artifactId: artifact.id,
    owner: input.claim.owner,
    epoch: input.claim.epoch,
  }
}

function statusOmitsSession(statuses: unknown, sessionId: string): boolean {
  return !!statuses &&
    typeof statuses === 'object' &&
    !Array.isArray(statuses) &&
    !Object.prototype.hasOwnProperty.call(statuses, sessionId)
}

async function terminalizeInterruptedRun(
  input: ClaimedIntegrationRecoveryInput,
  store: IntegrationRecoveryStore,
  fence: IntegrationRecoveryRunFence,
): Promise<void> {
  const allArtifactsTerminal = input.artifacts.every(
    (artifact) => artifact.status === 'succeeded' || artifact.status === 'failed',
  )
  if (allArtifactsTerminal) {
    if (input.run.status !== 'succeeded' && input.run.status !== 'failed') {
      await store.finishIntegrationRunFromArtifacts(fence)
    }
    return
  }
  await store.failIntegrationRunExecution({
    ...fence,
    errorCode: RECOVERY_ERROR_CODE,
    error: RECOVERY_ERROR,
  })
}

/**
 * Executes one recovery attempt for an already-fenced claim. It never submits
 * or re-submits a prompt. Claim scheduling, renewal, and release after a
 * `pending` result remain the caller's responsibility.
 */
export async function recoverClaimedIntegrationRun(
  input: ClaimedIntegrationRecoveryInput,
  dependencies: IntegrationRecoveryDependencies,
): Promise<IntegrationRecoveryResult> {
  validateRecoveryInput(input)
  const fence = runFence(input)
  const worktree = await dependencies.reclaimActiveIntegrationWorktreeLease(
    input.worktreeLease,
  )
  let client: IntegrationRecoveryOpencodeClient | undefined

  for (const artifact of input.artifacts) {
    if (!artifact.opencodeSessionId || artifact.terminalAckAt) continue
    let promptState = artifact.promptState
    const artifactClaim = artifactFence(input, artifact)
    if (promptState === 'submitted') {
      await dependencies.store.markIntegrationArtifactPromptAcceptanceUnknown(
        artifactClaim,
      )
      promptState = 'acceptance_unknown'
    }
    if (promptState !== 'accepted' && promptState !== 'acceptance_unknown') {
      continue
    }

    await dependencies.store.markIntegrationArtifactAbortRequested(artifactClaim)
    let abortAccepted: boolean
    try {
      client ??= await dependencies.createRecoveryOpencodeClient({
        directory: worktree.repoPath,
      })
      abortAccepted = await client.abortSession(
        artifact.opencodeSessionId,
        { signal: input.signal },
      )
    } catch {
      await dependencies.store.recordIntegrationArtifactAbortFailure({
        ...artifactClaim,
        errorCode: 'ABORT_FAILED',
        error: 'OpenCode abort 请求失败',
      })
      await dependencies.store.markIntegrationRunCleanupPending({
        ...fence,
        cleanupErrorCode: 'RECOVERY_ABORT_FAILED',
        cleanupError: 'OpenCode abort 请求失败，session 终态尚未确认',
      })
      return { runId: input.run.id, status: 'pending' }
    }
    await dependencies.store.recordIntegrationArtifactAbortResponse({
      ...artifactClaim,
      abortAccepted,
    })
    if (!abortAccepted) {
      await dependencies.store.markIntegrationRunCleanupPending({
        ...fence,
        cleanupErrorCode: 'RECOVERY_ABORT_NOT_CONFIRMED',
        cleanupError: 'OpenCode 未确认终止恢复中的 session',
      })
      return { runId: input.run.id, status: 'pending' }
    }
    let statuses: unknown
    try {
      statuses = await client.getSessionStatuses({ signal: input.signal })
    } catch {
      await dependencies.store.markIntegrationRunCleanupPending({
        ...fence,
        cleanupErrorCode: 'RECOVERY_STATUS_FAILED',
        cleanupError: 'OpenCode session 终态查询失败，请稍后重试恢复',
      })
      return { runId: input.run.id, status: 'pending' }
    }
    if (!statusOmitsSession(statuses, artifact.opencodeSessionId)) {
      await dependencies.store.markIntegrationRunCleanupPending({
        ...fence,
        cleanupErrorCode: 'RECOVERY_SESSION_STILL_ACTIVE',
        cleanupError: 'OpenCode session 在 abort 后仍未确认终态',
      })
      return { runId: input.run.id, status: 'pending' }
    }
    await dependencies.store.acknowledgeIntegrationArtifactTerminal({
      ...artifactClaim,
      source: 'status_endpoint_idle',
    })
  }

  await terminalizeInterruptedRun(input, dependencies.store, fence)

  const sessionArtifacts = input.artifacts.filter(
    (artifact) => !!artifact.opencodeSessionId,
  )
  const sessionIds = sessionArtifacts.map(
    (artifact) => artifact.opencodeSessionId!,
  )
  const remoteReleaseCheckpointComplete =
    !!input.run.opencodeDisposedAt &&
    sessionArtifacts.every((artifact) => !!artifact.sessionDeletedAt)
  if (!remoteReleaseCheckpointComplete) {
    const remoteCleanup =
      await dependencies.cleanupIntegrationOpencodeResources({
        worktreeLease: input.worktreeLease,
        sessionIds,
        confirmedDeletedSessionIds: sessionArtifacts
          .filter((artifact) => !!artifact.sessionDeletedAt)
          .map((artifact) => artifact.opencodeSessionId!),
        signal: input.signal,
      })

    for (const sessionId of remoteCleanup.deletedSessionIds) {
      const artifact = sessionArtifacts.find(
        (candidate) => candidate.opencodeSessionId === sessionId,
      )
      if (artifact && !artifact.sessionDeletedAt) {
        await dependencies.store.recordIntegrationArtifactSessionDeleted(
          artifactFence(input, artifact),
        )
      }
    }
    for (const sessionId of remoteCleanup.pendingSessionIds) {
      const artifact = sessionArtifacts.find(
        (candidate) => candidate.opencodeSessionId === sessionId,
      )
      if (!artifact || artifact.sessionDeletedAt) continue
      const issue = remoteCleanup.issues.find(
        (candidate) =>
          candidate.operation === 'session_delete' &&
          candidate.sessionId === sessionId,
      ) ?? remoteCleanup.issues.find(
        (candidate) => candidate.operation === 'client_create',
      )
      await dependencies.store.recordIntegrationArtifactSessionDeleteFailure({
        ...artifactFence(input, artifact),
        errorCode: issue?.errorCode ?? 'SESSION_DELETE_NOT_CONFIRMED',
        error: issue?.error ?? 'OpenCode 未确认删除恢复中的 session',
      })
    }
    if (remoteCleanup.dispose.status === 'confirmed') {
      await dependencies.store.recordIntegrationRunOpencodeDisposed(fence)
    } else if (remoteCleanup.dispose.status === 'pending') {
      await dependencies.store.recordIntegrationRunOpencodeDisposeFailure({
        ...fence,
        errorCode: remoteCleanup.dispose.errorCode,
        error: remoteCleanup.dispose.error,
      })
    }
    if (remoteCleanup.status !== 'safe') {
      await dependencies.store.markIntegrationRunCleanupPending({
        ...fence,
        cleanupErrorCode: 'RECOVERY_REMOTE_CLEANUP_PENDING',
        cleanupError: 'OpenCode 远端资源尚未全部确认释放',
      })
      return { runId: input.run.id, status: 'pending' }
    }
  }

  const cleanupGate =
    await dependencies.store.markIntegrationRunCleanupSafeIfTerminal(fence)
  if (!cleanupGate.safe) {
    await dependencies.store.markIntegrationRunCleanupPending({
      ...fence,
      cleanupErrorCode: 'RECOVERY_CLEANUP_GATE_PENDING',
      cleanupError: '运行或产物尚未满足本地清理条件',
    })
    return { runId: input.run.id, status: 'pending' }
  }

  await dependencies.store.beginIntegrationRunCleanup(fence)
  try {
    await dependencies.cleanupIntegrationWorktree(input.worktreeLease)
    await dependencies.store.finishIntegrationRunCleanup(fence)
    return { runId: input.run.id, status: 'completed' }
  } catch (error) {
    const message = error instanceof Error && error.message
      ? error.message
      : '集成 worktree 清理失败'
    await dependencies.store.failIntegrationRunCleanup({
      ...fence,
      cleanupErrorCode: 'WORKTREE_CLEANUP_FAILED',
      cleanupError: message,
    })
    return { runId: input.run.id, status: 'local_cleanup_failed' }
  }
}
