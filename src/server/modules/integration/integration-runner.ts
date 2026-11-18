import { randomBytes } from 'node:crypto'

import type {
  IntegrationArtifactType,
  IntegrationStage,
} from './integration-domain'
import { encryptApiKey } from '@/lib/crypto'
import type {
  FreezeIntegrationGitSnapshotInput,
  IntegrationGitSnapshot,
  IntegrationWorktreeInput,
  IntegrationWorktreePaths,
  CreateIntegrationWorktreeInput,
} from './integration-git'
import type {
  ExecuteIntegrationArtifactsInput,
  IntegrationArtifactExecutionResults,
  IntegrationOpencodeLifecycleEvent,
  IntegrationOpencodeWorkspacePreparedState,
} from './integration-opencode'
import type {
  CleanupIntegrationOpencodeResourcesInput,
  IntegrationOpencodeRemoteCleanupResult,
} from './integration-opencode-cleanup'

export interface IntegrationRunnerRun {
  id: string
  taskId: string
  stage: IntegrationStage
  triggerKey: string
  status: string
}

export interface IntegrationRunnerTask {
  id: string
  projectId: string
  title: string
  sourceBranch: string
  targetBranch: string
  scopePath?: string | null
  featureDesc?: string | null
}

export interface IntegrationRunnerProject {
  id: string
  repoRoot: string
  runtimeRoot?: string
}

export interface IntegrationRunnerArtifact {
  id: string
  type: IntegrationArtifactType
  status: string
  outputPath: string
  skillName: string
}

export interface IntegrationRunnerInput {
  run: IntegrationRunnerRun
  task: IntegrationRunnerTask
  project: IntegrationRunnerProject
  artifacts: readonly IntegrationRunnerArtifact[]
}

interface IntegrationRunnerClaim {
  id: string
  claimOwner: string | null
  claimEpoch: number
  status?: string
}

interface RunFence {
  runId: string
  owner: string
  epoch: number
}

interface ArtifactFence {
  artifactId: string
  owner: string
  epoch: number
}

export interface IntegrationRunnerStore {
  claimQueuedIntegrationRun(input: {
    runId: string
    owner: string
    leaseMs: number
  }): Promise<IntegrationRunnerClaim | null>
  renewIntegrationRunClaim(input: RunFence & {
    leaseMs: number
  }): Promise<unknown>
  lockIntegrationRunSnapshot(input: RunFence & {
    baseSha: string
    headSha: string
    targetTipSha: string
    diffHash: string
  }): Promise<unknown>
  tryReuseIntegrationFinalReview(input: RunFence & {
    artifactId: string
    headSha: string
    diffHash: string
  }): Promise<boolean>
  prepareIntegrationRunWorktree(input: RunFence & {
    worktreeLeaseCipher: string
  }): Promise<unknown>
  markIntegrationRunWorktreeActive(input: RunFence & {
    worktreePath: string
    worktreeLeaseCipher: string
  }): Promise<unknown>
  markIntegrationArtifactRunning(input: ArtifactFence & {
    skillDigest: string
  }): Promise<unknown>
  attachIntegrationArtifactSession(input: ArtifactFence & {
    opencodeSessionId: string
  }): Promise<unknown>
  markIntegrationArtifactPromptSubmitted(input: ArtifactFence): Promise<unknown>
  markIntegrationArtifactPromptAccepted(input: ArtifactFence): Promise<unknown>
  markIntegrationArtifactPromptAcceptanceUnknown(input: ArtifactFence): Promise<unknown>
  markIntegrationArtifactPromptRejected(input: ArtifactFence): Promise<unknown>
  markIntegrationArtifactAbortRequested(input: ArtifactFence): Promise<unknown>
  recordIntegrationArtifactAbortResponse(input: ArtifactFence & {
    abortAccepted: boolean
  }): Promise<unknown>
  acknowledgeIntegrationArtifactTerminal(input: ArtifactFence & {
    source: 'sse_session_idle' | 'sse_session_status_idle' | 'status_endpoint_idle'
  }): Promise<unknown>
  finishIntegrationArtifactSuccess(input: ArtifactFence & {
    content: string
    conclusion?: string | null
  }): Promise<unknown>
  finishIntegrationArtifactFailure(input: ArtifactFence & {
    errorCode: string
    error: string
  }): Promise<unknown>
  finishIntegrationRunFromArtifacts(input: RunFence): Promise<{
    status?: string
  }>
  failIntegrationRunExecution(input: RunFence & {
    errorCode: string
    error: string
  }): Promise<{
    status?: string
  }>
  recordIntegrationArtifactSessionDeleted(input: ArtifactFence): Promise<unknown>
  recordIntegrationArtifactSessionDeleteFailure(input: ArtifactFence & {
    errorCode: string
    error: string
  }): Promise<unknown>
  recordIntegrationRunOpencodeDisposed(input: RunFence): Promise<unknown>
  recordIntegrationRunOpencodeDisposeFailure(input: RunFence & {
    errorCode: string
    error: string
  }): Promise<unknown>
  markIntegrationRunCleanupPending(input: RunFence & {
    cleanupErrorCode?: string | null
    cleanupError?: string | null
  }): Promise<unknown>
  markIntegrationRunCleanupSafeIfTerminal(input: RunFence): Promise<{
    safe: boolean
    run: { cleanupStatus?: string }
  }>
  releaseIntegrationRunClaim(input: RunFence): Promise<unknown>
  beginIntegrationRunCleanup(input: RunFence): Promise<unknown>
  finishIntegrationRunCleanup(input: RunFence): Promise<unknown>
  failIntegrationRunCleanup(input: RunFence & {
    cleanupErrorCode: string
    cleanupError: string
  }): Promise<unknown>
  recordIntegrationArtifactAbortFailure(input: ArtifactFence & {
    errorCode: string
    error: string
  }): Promise<unknown>
}

export interface IntegrationRunnerGit {
  freezeIntegrationGitSnapshot(
    input: FreezeIntegrationGitSnapshotInput,
  ): Promise<IntegrationGitSnapshot>
  createDetachedIntegrationWorktree(
    input: CreateIntegrationWorktreeInput,
  ): Promise<IntegrationWorktreePaths>
  cleanupIntegrationWorktree(input: IntegrationWorktreeInput): Promise<void>
}

export interface IntegrationRunnerOpencode {
  executeIntegrationArtifacts(
    input: ExecuteIntegrationArtifactsInput,
  ): Promise<IntegrationArtifactExecutionResults>
}

export interface CreateIntegrationRunnerInput {
  store: IntegrationRunnerStore
  git: IntegrationRunnerGit
  opencode: IntegrationRunnerOpencode
  releaseOpenCodeResources(
    input: CleanupIntegrationOpencodeResourcesInput,
  ): Promise<IntegrationOpencodeRemoteCleanupResult>
  owner: string
  claimLeaseMs?: number
}

export interface IntegrationRunnerResult {
  runId: string
  triggerKey: string
  status: 'skipped' | 'succeeded' | 'failed'
  cleanupStatus: 'not_started' | 'pending' | 'failed' | 'completed'
}

interface ActiveRun {
  runId: string
  promise: Promise<IntegrationRunnerResult>
}

const DEFAULT_CLAIM_LEASE_MS = 10 * 60 * 1_000

const ARTIFACT_TYPES_BY_STAGE = Object.freeze({
  submit_review_and_tests: ['initial_review', 'test_cases'],
  pre_merge_review: ['final_review'],
} as const satisfies Readonly<Record<IntegrationStage, readonly IntegrationArtifactType[]>>)

function requireNonEmpty(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${name} 不能为空`)
  return normalized
}

function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`)
  }
  return value
}

function validateRunnerInput(input: IntegrationRunnerInput): void {
  if (input.run.taskId !== input.task.id) {
    throw new Error('run.taskId 与 task.id 不一致')
  }
  if (input.task.projectId !== input.project.id) {
    throw new Error('task.projectId 与 project.id 不一致')
  }
  requireNonEmpty('run.id', input.run.id)
  requireNonEmpty('run.triggerKey', input.run.triggerKey)
  requireNonEmpty('project.repoRoot', input.project.repoRoot)

  const expectedTypes = ARTIFACT_TYPES_BY_STAGE[input.run.stage]
  const actualTypes = input.artifacts.map((artifact) => artifact.type)
  if (
    actualTypes.length !== expectedTypes.length ||
    expectedTypes.some((type) => actualTypes.filter((actual) => actual === type).length !== 1)
  ) {
    throw new Error(
      `运行阶段 ${input.run.stage} 的产物必须为 ${expectedTypes.join(', ')}`,
    )
  }
  const artifactIds = new Set(input.artifacts.map((artifact) => artifact.id))
  if (artifactIds.size !== input.artifacts.length) {
    throw new Error('运行产物 id 不能重复')
  }
}

function artifactMap(
  artifacts: readonly IntegrationRunnerArtifact[],
): ReadonlyMap<IntegrationArtifactType, IntegrationRunnerArtifact> {
  return new Map(artifacts.map((artifact) => [artifact.type, artifact]))
}

function errorCode(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String(error.code).trim()
    if (code) return code
  }
  return fallback
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  const message = String(error).trim()
  return message && message !== '[object Object]' ? message : fallback
}

function validateClaim(
  claim: IntegrationRunnerClaim,
  runId: string,
  owner: string,
): RunFence {
  if (
    claim.id !== runId ||
    claim.claimOwner !== owner ||
    !Number.isSafeInteger(claim.claimEpoch) ||
    claim.claimEpoch <= 0
  ) {
    throw new Error(`运行 ${runId} 返回了无效 claim`)
  }
  return {
    runId,
    owner,
    epoch: claim.claimEpoch,
  }
}

function artifactFence(
  artifact: IntegrationRunnerArtifact,
  runFence: RunFence,
): ArtifactFence {
  return {
    artifactId: artifact.id,
    owner: runFence.owner,
    epoch: runFence.epoch,
  }
}

function startClaimHeartbeat(input: {
  store: IntegrationRunnerStore
  runFence: RunFence
  leaseMs: number
  controller: AbortController
}): {
  assertActive(): void
  stop(): Promise<void>
} {
  const intervalMs = Math.max(100, Math.floor(input.leaseMs / 3))
  let stopped = false
  let claimError: unknown
  let inFlight: Promise<void> | undefined
  const tick = () => {
    if (stopped || inFlight) return
    inFlight = input.store.renewIntegrationRunClaim({
      ...input.runFence,
      leaseMs: input.leaseMs,
    }).then(
      () => {},
      (error) => {
        claimError = error
        input.controller.abort()
      },
    ).finally(() => {
      inFlight = undefined
    })
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()

  return {
    assertActive() {
      if (!claimError) return
      throw Object.assign(new Error('集成运行 claim 续租失败，已停止当前执行'), {
        code: 'CLAIM_LOST',
        cause: claimError,
      })
    },
    async stop() {
      stopped = true
      clearInterval(timer)
      await inFlight
    },
  }
}

async function persistWorkspacePrepared(
  store: IntegrationRunnerStore,
  artifacts: ReadonlyMap<IntegrationArtifactType, IntegrationRunnerArtifact>,
  runFence: RunFence,
  expectedTypes: readonly IntegrationArtifactType[],
  state: IntegrationOpencodeWorkspacePreparedState,
): Promise<void> {
  for (const type of expectedTypes) {
    const artifact = artifacts.get(type)
    const prepared = state.artifacts[type]
    if (!artifact || !prepared) {
      throw new Error(`OpenCode workspace 缺少产物配置：${type}`)
    }
    if (
      prepared.reportPath !== artifact.outputPath ||
      prepared.skillName !== artifact.skillName
    ) {
      throw new Error(`OpenCode workspace 产物契约不一致：${type}`)
    }
    await store.markIntegrationArtifactRunning({
      ...artifactFence(artifact, runFence),
      skillDigest: prepared.skillDigest,
    })
  }
}

async function persistLifecycleEvent(
  store: IntegrationRunnerStore,
  artifact: IntegrationRunnerArtifact,
  runFence: RunFence,
  event: IntegrationOpencodeLifecycleEvent,
): Promise<void> {
  const fence = artifactFence(artifact, runFence)
  switch (event.type) {
    case 'session_created':
      await store.attachIntegrationArtifactSession({
        ...fence,
        opencodeSessionId: event.sessionId,
      })
      return
    case 'prompt_submitting':
      await store.markIntegrationArtifactPromptSubmitted(fence)
      return
    case 'prompt_accepted':
      await store.markIntegrationArtifactPromptAccepted(fence)
      return
    case 'prompt_acceptance_unknown':
      await store.markIntegrationArtifactPromptAcceptanceUnknown(fence)
      return
    case 'prompt_rejected':
      await store.markIntegrationArtifactPromptRejected(fence)
      return
    case 'abort_requested':
      await store.markIntegrationArtifactAbortRequested(fence)
      return
    case 'abort_responded':
      await store.recordIntegrationArtifactAbortResponse({
        ...fence,
        abortAccepted: event.accepted,
      })
      return
    case 'abort_failed':
      await store.recordIntegrationArtifactAbortFailure({
        ...fence,
        errorCode: event.errorCode,
        error: event.error,
      })
      return
    case 'terminal_acknowledged':
      await store.acknowledgeIntegrationArtifactTerminal({
        ...fence,
        source: event.source,
      })
      return
  }
}

async function persistArtifactResults(input: {
  store: IntegrationRunnerStore
  artifacts: ReadonlyMap<IntegrationArtifactType, IntegrationRunnerArtifact>
  expectedTypes: readonly IntegrationArtifactType[]
  runFence: RunFence
  results: IntegrationArtifactExecutionResults
}): Promise<void> {
  const persisted = await Promise.allSettled(input.expectedTypes.map(async (type) => {
    const artifact = input.artifacts.get(type)
    if (!artifact) throw new Error(`运行缺少产物：${type}`)
    const fence = artifactFence(artifact, input.runFence)
    const result = input.results[type]
    if (
      result?.artifact.status === 'succeeded' &&
      typeof result.artifact.content === 'string'
    ) {
      await input.store.finishIntegrationArtifactSuccess({
        ...fence,
        content: result.artifact.content,
      })
      return
    }
    await input.store.finishIntegrationArtifactFailure({
      ...fence,
      errorCode: result?.artifact.errorCode || 'OPENCODE_RESULT_MISSING',
      error: result?.artifact.error || `OpenCode 未返回 ${type} 的有效报告`,
    })
  }))
  const failures = persisted
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason)
  if (failures.length > 0) {
    throw new AggregateError(failures, '一个或多个集成产物无法持久化')
  }
}

interface CleanupPendingReason {
  errorCode: string
  error: string
}

function rememberArtifactSession(input: {
  artifact: IntegrationRunnerArtifact
  sessionId: string
  sessionByArtifactType: Map<IntegrationArtifactType, string>
  artifactBySessionId: Map<string, IntegrationRunnerArtifact>
}): void {
  const existingForArtifact = input.sessionByArtifactType.get(input.artifact.type)
  if (existingForArtifact && existingForArtifact !== input.sessionId) {
    throw new Error(`产物 ${input.artifact.type} 返回了多个 OpenCode session`)
  }
  const existingArtifact = input.artifactBySessionId.get(input.sessionId)
  if (existingArtifact && existingArtifact.id !== input.artifact.id) {
    throw new Error(`OpenCode session ${input.sessionId} 被多个产物复用`)
  }
  input.sessionByArtifactType.set(input.artifact.type, input.sessionId)
  input.artifactBySessionId.set(input.sessionId, input.artifact)
}

async function persistOpenCodeResourceCleanup(input: {
  store: IntegrationRunnerStore
  runFence: RunFence
  artifactBySessionId: ReadonlyMap<string, IntegrationRunnerArtifact>
  result: IntegrationOpencodeRemoteCleanupResult
}): Promise<void> {
  const deletedSessionIds = new Set(input.result.deletedSessionIds)
  for (const sessionId of deletedSessionIds) {
    const artifact = input.artifactBySessionId.get(sessionId)
    if (!artifact) {
      throw new Error(`OpenCode 清理返回了未知 session：${sessionId}`)
    }
    await input.store.recordIntegrationArtifactSessionDeleted(
      artifactFence(artifact, input.runFence),
    )
  }

  for (const issue of input.result.issues) {
    if (issue.operation === 'session_delete' && issue.sessionId) {
      if (deletedSessionIds.has(issue.sessionId)) continue
      const artifact = input.artifactBySessionId.get(issue.sessionId)
      if (!artifact) {
        throw new Error(`OpenCode 清理错误指向未知 session：${issue.sessionId}`)
      }
      await input.store.recordIntegrationArtifactSessionDeleteFailure({
        ...artifactFence(artifact, input.runFence),
        errorCode: issue.errorCode,
        error: issue.error,
      })
      continue
    }
    await input.store.recordIntegrationRunOpencodeDisposeFailure({
      ...input.runFence,
      errorCode: issue.errorCode,
      error: issue.error,
    })
  }

  if (input.result.dispose.status === 'confirmed') {
    await input.store.recordIntegrationRunOpencodeDisposed(input.runFence)
  } else if (input.result.dispose.status === 'pending') {
    await input.store.recordIntegrationRunOpencodeDisposeFailure({
      ...input.runFence,
      errorCode: input.result.dispose.errorCode,
      error: input.result.dispose.error,
    })
  }
}

function cleanupPendingReason(
  result: IntegrationOpencodeRemoteCleanupResult,
): CleanupPendingReason | undefined {
  if (result.status === 'safe') return undefined
  const issue = result.issues[0]
  return issue
    ? { errorCode: issue.errorCode, error: issue.error }
    : {
      errorCode: 'OPENCODE_RESOURCE_CLEANUP_PENDING',
      error: 'OpenCode session 或 directory instance 尚未确认释放',
    }
}

function pendingSessionCleanupReason(input: {
  expectedTypes: readonly IntegrationArtifactType[]
  sessionByArtifactType: ReadonlyMap<IntegrationArtifactType, string>
  results?: IntegrationArtifactExecutionResults
}): CleanupPendingReason | undefined {
  for (const type of input.expectedTypes) {
    const sessionId = input.sessionByArtifactType.get(type)
    if (!sessionId) continue
    const result = input.results?.[type]
    if (
      result?.sessionId === sessionId &&
      result.cleanup.status === 'safe'
    ) {
      continue
    }
    return {
      errorCode: result?.cleanup.errorCode ?? 'OPENCODE_SESSION_CLEANUP_PENDING',
      error: result?.cleanup.error ??
        `OpenCode session ${sessionId} 尚未确认终态，交由 recovery 继续处理`,
    }
  }
  return undefined
}

async function finalizeCleanup(input: {
  store: IntegrationRunnerStore
  git: IntegrationRunnerGit
  runFence: RunFence
  project: IntegrationRunnerProject
  worktree?: IntegrationWorktreePaths
  worktreePrepared: boolean
  executionError?: unknown
  remoteResourcesSafe: boolean
  cleanupPendingReason?: CleanupPendingReason
}): Promise<IntegrationRunnerResult['cleanupStatus']> {
  if (!input.remoteResourcesSafe) {
    const cleanupFailure = input.cleanupPendingReason ??
      (input.executionError
        ? {
          errorCode: errorCode(input.executionError, 'RUNNER_EXECUTION_FAILED'),
          error: errorMessage(input.executionError, '集成运行未安全结束'),
        }
        : {
          errorCode: 'OPENCODE_RESOURCE_CLEANUP_PENDING',
          error: 'OpenCode 资源尚未确认释放',
        })
    try {
      await input.store.markIntegrationRunCleanupPending({
        ...input.runFence,
        cleanupErrorCode: cleanupFailure.errorCode,
        cleanupError: cleanupFailure.error,
      })
    } catch {
      // 当前 claim 仍会在下面显式释放，后续 recovery 可重试门禁。
    }
    try {
      await input.store.releaseIntegrationRunClaim(input.runFence)
    } catch {
      // claim 已失效时不能再安全推进 cleanup。
    }
    return 'pending'
  }

  let safe = false
  let cleanupAlreadyCompleted = false
  try {
    const gate = await input.store.markIntegrationRunCleanupSafeIfTerminal(input.runFence)
    safe = gate.safe
    cleanupAlreadyCompleted = gate.run.cleanupStatus === 'completed'
    if (!safe) {
      const cleanupFailure = input.executionError
        ? {
          cleanupErrorCode: errorCode(input.executionError, 'RUNNER_EXECUTION_FAILED'),
          cleanupError: errorMessage(input.executionError, '集成运行未安全结束'),
        }
        : {}
      await input.store.markIntegrationRunCleanupPending({
        ...input.runFence,
        ...cleanupFailure,
      })
    }
  } catch {
    safe = false
  }

  if (!safe) {
    try {
      await input.store.releaseIntegrationRunClaim(input.runFence)
    } catch {
      // claim 已失效时保持 pending，禁止无 fencing 清理 worktree。
    }
    return 'pending'
  }

  if (!input.worktree && !input.worktreePrepared) {
    try {
      if (!cleanupAlreadyCompleted) {
        await input.store.beginIntegrationRunCleanup(input.runFence)
        await input.store.finishIntegrationRunCleanup(input.runFence)
        return 'completed'
      }
      await input.store.releaseIntegrationRunClaim(input.runFence)
    } catch {
      return 'pending'
    }
    return 'completed'
  }

  try {
    await input.store.beginIntegrationRunCleanup(input.runFence)
  } catch {
    try {
      await input.store.releaseIntegrationRunClaim(input.runFence)
    } catch {
      // claim 已变化，交由持有新 claim 的 recovery runner 继续。
    }
    return 'pending'
  }

  try {
    await input.git.cleanupIntegrationWorktree({
      repoRoot: input.project.repoRoot,
      runtimeRoot: input.project.runtimeRoot,
      runId: input.runFence.runId,
      ...(input.worktree
        ? { leaseToken: input.worktree.leaseToken }
        : {}),
    })
    await input.store.finishIntegrationRunCleanup(input.runFence)
    return 'completed'
  } catch (error) {
    try {
      await input.store.failIntegrationRunCleanup({
        ...input.runFence,
        cleanupErrorCode: errorCode(error, 'WORKTREE_CLEANUP_FAILED'),
        cleanupError: errorMessage(error, '集成 worktree 清理失败'),
      })
    } catch {
      // 原始清理错误更能解释待人工恢复的原因；状态由 recovery runner 再协调。
    }
    return 'failed'
  }
}

class IntegrationRunner {
  private readonly store: IntegrationRunnerStore
  private readonly git: IntegrationRunnerGit
  private readonly opencode: IntegrationRunnerOpencode
  private readonly releaseOpenCodeResources: CreateIntegrationRunnerInput['releaseOpenCodeResources']
  private readonly owner: string
  private readonly claimLeaseMs: number
  private readonly activeByTrigger = new Map<string, ActiveRun>()

  constructor(input: CreateIntegrationRunnerInput) {
    this.store = input.store
    this.git = input.git
    this.opencode = input.opencode
    this.releaseOpenCodeResources = input.releaseOpenCodeResources
    this.owner = requireNonEmpty('owner', input.owner)
    this.claimLeaseMs = requirePositiveInteger(
      'claimLeaseMs',
      input.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS,
    )
  }

  run(input: IntegrationRunnerInput): Promise<IntegrationRunnerResult> {
    validateRunnerInput(input)
    const active = this.activeByTrigger.get(input.run.triggerKey)
    if (active) {
      if (active.runId !== input.run.id) {
        return Promise.reject(
          new Error(`triggerKey ${input.run.triggerKey} 已绑定其他运行`),
        )
      }
      return active.promise
    }

    const promise = this.execute(input)
    this.activeByTrigger.set(input.run.triggerKey, {
      runId: input.run.id,
      promise,
    })
    void promise.then(
      () => this.deleteActive(input.run.triggerKey, promise),
      () => this.deleteActive(input.run.triggerKey, promise),
    )
    return promise
  }

  private deleteActive(
    triggerKey: string,
    promise: Promise<IntegrationRunnerResult>,
  ): void {
    if (this.activeByTrigger.get(triggerKey)?.promise === promise) {
      this.activeByTrigger.delete(triggerKey)
    }
  }

  private async execute(
    input: IntegrationRunnerInput,
  ): Promise<IntegrationRunnerResult> {
    const claim = await this.store.claimQueuedIntegrationRun({
      runId: input.run.id,
      owner: this.owner,
      leaseMs: this.claimLeaseMs,
    })
    if (!claim) {
      return {
        runId: input.run.id,
        triggerKey: input.run.triggerKey,
        status: 'skipped',
        cleanupStatus: 'not_started',
      }
    }

    const runFence = validateClaim(claim, input.run.id, this.owner)
    const executionController = new AbortController()
    const claimHeartbeat = startClaimHeartbeat({
      store: this.store,
      runFence,
      leaseMs: this.claimLeaseMs,
      controller: executionController,
    })
    const expectedTypes = ARTIFACT_TYPES_BY_STAGE[input.run.stage]
    const artifacts = artifactMap(input.artifacts)
    const sessionByArtifactType = new Map<IntegrationArtifactType, string>()
    const artifactBySessionId = new Map<string, IntegrationRunnerArtifact>()
    let worktree: IntegrationWorktreePaths | undefined
    let worktreePrepared = false
    let worktreeRecorded = false
    let executionTerminalPersisted = false
    let runStatus: 'succeeded' | 'failed' = 'failed'
    let executionError: unknown
    let artifactResults: IntegrationArtifactExecutionResults | undefined
    let remoteResourcesSafe = true
    let pendingCleanupReason: CleanupPendingReason | undefined

    try {
      const snapshot = await this.git.freezeIntegrationGitSnapshot({
        repoRoot: input.project.repoRoot,
        runtimeRoot: input.project.runtimeRoot,
        sourceBranch: input.task.sourceBranch,
        targetBranch: input.task.targetBranch,
        scopePath: input.task.scopePath || undefined,
      })
      claimHeartbeat.assertActive()
      await this.store.lockIntegrationRunSnapshot({
        ...runFence,
        baseSha: snapshot.baseSha,
        headSha: snapshot.headSha,
        targetTipSha: snapshot.targetTipSha,
        diffHash: snapshot.diffHash,
      })
      const finalReview = input.run.stage === 'pre_merge_review'
        ? artifacts.get('final_review')
        : undefined
      const reusedFinalReview = finalReview
        ? await this.store.tryReuseIntegrationFinalReview({
          ...runFence,
          artifactId: finalReview.id,
          headSha: snapshot.headSha,
          diffHash: snapshot.diffHash,
        })
        : false

      if (!reusedFinalReview) {
        const worktreeLeaseToken = randomBytes(32).toString('hex')
        const worktreeLeaseCipher = encryptApiKey(worktreeLeaseToken)
        await this.store.prepareIntegrationRunWorktree({
          ...runFence,
          worktreeLeaseCipher,
        })
        worktreePrepared = true
        worktree = await this.git.createDetachedIntegrationWorktree({
          repoRoot: input.project.repoRoot,
          runtimeRoot: input.project.runtimeRoot,
          runId: input.run.id,
          headSha: snapshot.headSha,
          leaseToken: worktreeLeaseToken,
        })
        claimHeartbeat.assertActive()
        await this.store.markIntegrationRunWorktreeActive({
          ...runFence,
          worktreePath: worktree.repoPath,
          worktreeLeaseCipher,
        })
        worktreeRecorded = true

        const results = await this.opencode.executeIntegrationArtifacts({
          worktreeLease: {
            repoRoot: input.project.repoRoot,
            runtimeRoot: input.project.runtimeRoot,
            runId: input.run.id,
            leaseToken: worktree.leaseToken,
          },
          artifactTypes: expectedTypes,
          sourceBranch: input.task.sourceBranch,
          targetBranch: input.task.targetBranch,
          feature: input.task.featureDesc?.trim() || input.task.title,
          scopePath: input.task.scopePath || undefined,
          snapshot: {
            baseSha: snapshot.baseSha,
            headSha: snapshot.headSha,
            diffHash: snapshot.diffHash,
          },
          signal: executionController.signal,
          onWorkspacePrepared: async (state) => {
            await persistWorkspacePrepared(
              this.store,
              artifacts,
              runFence,
              expectedTypes,
              state,
            )
          },
          onArtifactLifecycleEvent: async (artifactType, event) => {
            const artifact = artifacts.get(artifactType)
            if (!artifact) throw new Error(`收到未知产物的生命周期事件：${artifactType}`)
            await persistLifecycleEvent(this.store, artifact, runFence, event)
            if (event.type === 'session_created') {
              rememberArtifactSession({
                artifact,
                sessionId: event.sessionId,
                sessionByArtifactType,
                artifactBySessionId,
              })
            }
          },
        })
        artifactResults = results
        claimHeartbeat.assertActive()
        for (const type of expectedTypes) {
          const artifact = artifacts.get(type)
          const sessionId = results[type]?.sessionId
          if (artifact && sessionId) {
            rememberArtifactSession({
              artifact,
              sessionId,
              sessionByArtifactType,
              artifactBySessionId,
            })
          }
        }
        await persistArtifactResults({
          store: this.store,
          artifacts,
          expectedTypes,
          runFence,
          results,
        })
      }
      const aggregate = await this.store.finishIntegrationRunFromArtifacts(runFence)
      runStatus = aggregate.status === 'succeeded' ? 'succeeded' : 'failed'
      executionTerminalPersisted = true
    } catch (error) {
      executionError = error
      if (worktree && !worktreeRecorded) {
        try {
          await this.git.cleanupIntegrationWorktree({
            repoRoot: input.project.repoRoot,
            runtimeRoot: input.project.runtimeRoot,
            runId: input.run.id,
            leaseToken: worktree.leaseToken,
          })
          worktree = undefined
        } catch (cleanupError) {
          executionError = new AggregateError(
            [error, cleanupError],
            '集成执行失败，且未登记 worktree 的安全回滚也失败',
          )
        }
      }
      try {
        await this.store.failIntegrationRunExecution({
          ...runFence,
          errorCode: errorCode(error, 'RUNNER_EXECUTION_FAILED'),
          error: errorMessage(error, '集成执行失败'),
        })
        runStatus = 'failed'
        executionTerminalPersisted = true
      } catch (failurePersistError) {
        executionError = new AggregateError(
          [executionError, failurePersistError],
          '集成执行失败，且运行失败状态无法持久化',
        )
      }
    }

    if (worktree && worktreeRecorded && executionTerminalPersisted) {
      const worktreeLease = {
        repoRoot: input.project.repoRoot,
        runtimeRoot: input.project.runtimeRoot,
        runId: input.run.id,
        leaseToken: worktree.leaseToken,
      }
      const sessionIds = expectedTypes.flatMap((type) => {
        const sessionId = sessionByArtifactType.get(type)
        return sessionId ? [sessionId] : []
      })
      pendingCleanupReason = pendingSessionCleanupReason({
        expectedTypes,
        sessionByArtifactType,
        results: artifactResults,
      })
      if (pendingCleanupReason) {
        remoteResourcesSafe = false
      } else {
        try {
          const cleanupResult = await this.releaseOpenCodeResources({
            worktreeLease,
            sessionIds,
          })
          await persistOpenCodeResourceCleanup({
            store: this.store,
            runFence,
            artifactBySessionId,
            result: cleanupResult,
          })
          remoteResourcesSafe = cleanupResult.status === 'safe'
          pendingCleanupReason = cleanupPendingReason(cleanupResult)
        } catch (error) {
          remoteResourcesSafe = false
          pendingCleanupReason = {
            errorCode: errorCode(error, 'OPENCODE_RESOURCE_CLEANUP_FAILED'),
            error: errorMessage(error, 'OpenCode 资源释放失败'),
          }
          try {
            await this.store.recordIntegrationRunOpencodeDisposeFailure({
              ...runFence,
              errorCode: pendingCleanupReason.errorCode,
              error: pendingCleanupReason.error,
            })
          } catch {
            // cleanup gate 会保持 pending；恢复 worker 使用同一 claim fencing 重试。
          }
        }
      }
    } else if (worktree) {
      remoteResourcesSafe = false
      pendingCleanupReason = {
        errorCode: 'RUN_TERMINAL_STATE_NOT_PERSISTED',
        error: '运行终态尚未可靠持久化，不能释放 OpenCode 或 worktree',
      }
    }

    let cleanupStatus: IntegrationRunnerResult['cleanupStatus']
    try {
      cleanupStatus = await finalizeCleanup({
        store: this.store,
        git: this.git,
        runFence,
        project: input.project,
        worktree,
        worktreePrepared,
        executionError,
        remoteResourcesSafe,
        cleanupPendingReason: pendingCleanupReason,
      })
    } finally {
      await claimHeartbeat.stop()
    }

    if (executionError) throw executionError
    return {
      runId: input.run.id,
      triggerKey: input.run.triggerKey,
      status: runStatus,
      cleanupStatus,
    }
  }
}

export function createIntegrationRunner(
  input: CreateIntegrationRunnerInput,
): Pick<IntegrationRunner, 'run'> {
  return new IntegrationRunner(input)
}
