import {
  createDirectoryOpencodeClient,
  DirectoryOpencodeError,
} from '@/lib/opencode/opencode-client'
import type { OpencodeConfig } from '@/lib/opencode/opencode-config'
import { isValidOpencodeSessionId } from '@/lib/opencode/opencode-session'
import {
  validateActiveIntegrationWorktree,
  type ValidateIntegrationWorktreeInput,
} from './integration-git'

export interface CleanupIntegrationOpencodeResourcesInput {
  worktreeLease: ValidateIntegrationWorktreeInput
  sessionIds: readonly string[]
  /**
   * Retry checkpoint. Only pass `deletedSessionIds` returned by an earlier
   * pending result for the same run and complete `sessionIds` set.
   */
  confirmedDeletedSessionIds?: readonly string[]
  cfg?: OpencodeConfig
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

export interface IntegrationOpencodeRemoteCleanupResult {
  status: 'safe' | 'pending'
  sessionIds: readonly string[]
  deletedSessionIds: readonly string[]
  pendingSessionIds: readonly string[]
  dispose: IntegrationOpencodeRemoteDisposeResult
  issues: readonly IntegrationOpencodeRemoteCleanupIssue[]
}

export type IntegrationOpencodeRemoteDisposeResult =
  | { status: 'confirmed' | 'not_attempted' }
  | {
    status: 'pending'
    errorCode: string
    error: string
  }

export interface IntegrationOpencodeRemoteCleanupIssue {
  operation: 'client_create' | 'session_delete' | 'instance_dispose'
  sessionId?: string
  errorCode: string
  error: string
}

export async function cleanupIntegrationOpencodeResources(
  input: CleanupIntegrationOpencodeResourcesInput,
): Promise<IntegrationOpencodeRemoteCleanupResult> {
  const validatedWorktree = await validateActiveIntegrationWorktree(
    input.worktreeLease,
  )
  const sessionIds = [...new Set(input.sessionIds)]
  if (!sessionIds.every(isValidOpencodeSessionId)) {
    throw new TypeError('OpenCode sessionIds 包含无效值')
  }
  const confirmedDeletedSessionIds = [
    ...new Set(input.confirmedDeletedSessionIds ?? []),
  ]
  const requestedSessionIdSet = new Set(sessionIds)
  if (
    !confirmedDeletedSessionIds.every(isValidOpencodeSessionId) ||
    !confirmedDeletedSessionIds.every((sessionId) =>
      requestedSessionIdSet.has(sessionId))
  ) {
    throw new TypeError('confirmedDeletedSessionIds 必须是 sessionIds 的有效子集')
  }

  const deletedSessionIdSet = new Set(confirmedDeletedSessionIds)
  let client
  try {
    client = await createDirectoryOpencodeClient({
      cfg: input.cfg,
      directory: validatedWorktree.repoPath,
      fetchImpl: input.fetchImpl,
    })
  } catch {
    return {
      status: 'pending',
      sessionIds,
      deletedSessionIds: sessionIds.filter((sessionId) =>
        deletedSessionIdSet.has(sessionId)),
      pendingSessionIds: sessionIds.filter((sessionId) =>
        !deletedSessionIdSet.has(sessionId)),
      dispose: { status: 'not_attempted' },
      issues: [{
        operation: 'client_create',
        errorCode: 'OPENCODE_CLIENT_CREATE_FAILED',
        error: 'OpenCode 清理客户端初始化失败',
      }],
    }
  }
  const pendingSessionIds: string[] = []
  const issues: IntegrationOpencodeRemoteCleanupIssue[] = []
  for (const sessionId of sessionIds) {
    if (deletedSessionIdSet.has(sessionId)) continue
    try {
      if (await client.deleteSession(sessionId, { signal: input.signal })) {
        deletedSessionIdSet.add(sessionId)
        continue
      }
      pendingSessionIds.push(sessionId)
      issues.push({
        operation: 'session_delete',
        sessionId,
        errorCode: 'SESSION_DELETE_NOT_CONFIRMED',
        error: 'OpenCode 未确认删除会话',
      })
    } catch (error) {
      pendingSessionIds.push(sessionId)
      issues.push({
        operation: 'session_delete',
        sessionId,
        errorCode: error instanceof DirectoryOpencodeError
          ? error.code
          : 'SESSION_DELETE_FAILED',
        error: 'OpenCode 会话删除请求失败',
      })
    }
  }
  if (pendingSessionIds.length > 0) {
    const deletedSessionIds = sessionIds.filter((sessionId) =>
      deletedSessionIdSet.has(sessionId))
    return {
      status: 'pending',
      sessionIds,
      deletedSessionIds,
      pendingSessionIds,
      dispose: { status: 'not_attempted' },
      issues,
    }
  }
  const deletedSessionIds = sessionIds.filter((sessionId) =>
    deletedSessionIdSet.has(sessionId))
  let instanceDisposed: boolean
  try {
    instanceDisposed = await client.disposeInstance({ signal: input.signal })
  } catch (error) {
    const issue: IntegrationOpencodeRemoteCleanupIssue = {
      operation: 'instance_dispose',
      errorCode: error instanceof DirectoryOpencodeError
        ? error.code
        : 'INSTANCE_DISPOSE_FAILED',
      error: 'OpenCode directory instance 释放请求失败',
    }
    return {
      status: 'pending',
      sessionIds,
      deletedSessionIds,
      pendingSessionIds: [],
      dispose: {
        status: 'pending',
        errorCode: issue.errorCode,
        error: issue.error,
      },
      issues: [issue],
    }
  }
  if (!instanceDisposed) {
    const issue: IntegrationOpencodeRemoteCleanupIssue = {
      operation: 'instance_dispose',
      errorCode: 'INSTANCE_DISPOSE_NOT_CONFIRMED',
      error: 'OpenCode 未确认释放 directory instance',
    }
    return {
      status: 'pending',
      sessionIds,
      deletedSessionIds,
      pendingSessionIds: [],
      dispose: {
        status: 'pending',
        errorCode: issue.errorCode,
        error: issue.error,
      },
      issues: [issue],
    }
  }

  return {
    status: 'safe',
    sessionIds,
    deletedSessionIds,
    pendingSessionIds: [],
    dispose: { status: 'confirmed' },
    issues: [],
  }
}
