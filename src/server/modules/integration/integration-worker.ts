import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import { decryptApiKey } from '@/lib/crypto'
import { createDirectoryOpencodeClient } from '@/lib/opencode/opencode-client'
import {
  cleanupIntegrationWorktree,
  createDetachedIntegrationWorktree,
  freezeIntegrationGitSnapshot,
  reclaimActiveIntegrationWorktreeLease,
  reclaimIntegrationWorktreeLeaseForCleanup,
} from './integration-git'
import {
  cleanupIntegrationOpencodeResources,
} from './integration-opencode-cleanup'
import { executeIntegrationArtifacts } from './integration-opencode'
import {
  loadIntegrationProjects,
  type IntegrationProjectConfig,
} from './integration-projects'
import {
  recoverClaimedIntegrationRun,
  type IntegrationRecoveryArtifact,
  type IntegrationRecoveryPromptState,
} from './integration-recovery'
import { createIntegrationRunner } from './integration-runner'
import * as store from './integration-store'
import type {
  IntegrationArtifactType,
  IntegrationStage,
} from './integration-domain'

type WorkerRunKind = 'queued' | 'recovery' | 'cleanup'

export interface IntegrationWorkerErrorContext {
  kind: WorkerRunKind
  runId: string
}

export interface CreateIntegrationWorkerEngineInput {
  pollIntervalMs?: number
  maxConcurrency?: number
  listQueuedRunIds(): Promise<readonly string[]>
  listRecoveryRunIds(): Promise<readonly string[]>
  listCleanupRunIds(): Promise<readonly string[]>
  executeQueuedRun(runId: string): Promise<void>
  recoverRun(runId: string): Promise<void>
  cleanupRun(runId: string): Promise<void>
  onError?(error: unknown, context: IntegrationWorkerErrorContext): void
}

export interface IntegrationWorkerEngine {
  start(): void
  stop(): void
  enqueue(runId: string): void
  drainOnce(): Promise<void>
}

const DEFAULT_POLL_INTERVAL_MS = 5_000
const DEFAULT_WORKER_CONCURRENCY = 2
const MAX_WORKER_CONCURRENCY = 8
const DEFAULT_RECOVERY_CLAIM_LEASE_MS = 60_000
const DEFAULT_EXECUTION_CLAIM_LEASE_MS = 10 * 60 * 1_000
const DEFAULT_CANDIDATE_LIMIT = 50
const RECOVERY_RETRY_BACKOFF_MS = 15_000
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const INTEGRATION_STAGES = new Set<IntegrationStage>([
  'submit_review_and_tests',
  'pre_merge_review',
])
const INTEGRATION_ARTIFACT_TYPES = new Set<IntegrationArtifactType>([
  'initial_review',
  'test_cases',
  'final_review',
])
const RECOVERY_PROMPT_STATES = new Set<IntegrationRecoveryPromptState>([
  'not_submitted',
  'submitted',
  'accepted',
  'acceptance_unknown',
  'rejected',
])

function checkedPollInterval(value: number | undefined): number {
  const resolved = value ?? DEFAULT_POLL_INTERVAL_MS
  if (!Number.isSafeInteger(resolved) || resolved < 100) {
    throw new TypeError('pollIntervalMs 必须是至少 100ms 的整数')
  }
  return resolved
}

function checkedMaxConcurrency(value: number | undefined): number {
  const resolved = value ?? DEFAULT_WORKER_CONCURRENCY
  if (
    !Number.isSafeInteger(resolved)
    || resolved < 1
    || resolved > MAX_WORKER_CONCURRENCY
  ) {
    throw new TypeError(`maxConcurrency 必须是 1 到 ${MAX_WORKER_CONCURRENCY} 的整数`)
  }
  return resolved
}

export function resolveIntegrationWorkerConcurrency(
  rawValue: string | undefined,
): number {
  if (rawValue === undefined || rawValue === '') return DEFAULT_WORKER_CONCURRENCY
  if (!/^[1-8]$/.test(rawValue)) {
    throw new TypeError(
      `HARMONY_INTEGRATION_WORKER_CONCURRENCY 必须是 1 到 ${MAX_WORKER_CONCURRENCY} 的整数`,
    )
  }
  return Number(rawValue)
}

function checkedRunId(runId: string): string {
  if (!SAFE_RUN_ID_PATTERN.test(runId)) {
    throw new TypeError('runId 格式无效')
  }
  return runId
}

function safeNotifyError(
  callback: CreateIntegrationWorkerEngineInput['onError'],
  error: unknown,
  context: IntegrationWorkerErrorContext,
): void {
  try {
    callback?.(error, context)
  } catch {
    // 错误观察器不能制造未处理的后台 Promise。
  }
}

export function createIntegrationWorkerEngine(
  input: CreateIntegrationWorkerEngineInput,
): IntegrationWorkerEngine {
  const pollIntervalMs = checkedPollInterval(input.pollIntervalMs)
  const maxConcurrency = checkedMaxConcurrency(input.maxConcurrency)
  const activeRuns = new Map<string, {
    kind: WorkerRunKind
    promise: Promise<void>
  }>()
  const pendingRuns: Array<{
    kind: WorkerRunKind
    runId: string
    promise: Promise<void>
    complete: () => void
  }> = []
  let runningCount = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let drainPromise: Promise<void> | undefined

  const operationFor = (kind: WorkerRunKind): ((runId: string) => Promise<void>) => {
    if (kind === 'queued') return input.executeQueuedRun
    if (kind === 'recovery') return input.recoverRun
    return input.cleanupRun
  }

  const priorityOf = (kind: WorkerRunKind): number => {
    if (kind === 'cleanup') return 0
    if (kind === 'recovery') return 1
    return 2
  }

  const pump = (): void => {
    while (runningCount < maxConcurrency && pendingRuns.length > 0) {
      let selectedIndex = 0
      for (let index = 1; index < pendingRuns.length; index += 1) {
        if (
          priorityOf(pendingRuns[index]!.kind)
          < priorityOf(pendingRuns[selectedIndex]!.kind)
        ) {
          selectedIndex = index
        }
      }
      const [scheduled] = pendingRuns.splice(selectedIndex, 1)
      if (!scheduled) return
      runningCount += 1
      void Promise.resolve()
        .then(() => operationFor(scheduled.kind)(scheduled.runId))
        .catch((error) => {
          safeNotifyError(input.onError, error, {
            kind: scheduled.kind,
            runId: scheduled.runId,
          })
        })
        .finally(() => {
          runningCount -= 1
          if (activeRuns.get(scheduled.runId)?.promise === scheduled.promise) {
            activeRuns.delete(scheduled.runId)
          }
          scheduled.complete()
          pump()
        })
    }
  }

  const schedule = (kind: WorkerRunKind, rawRunId: string): Promise<void> => {
    let runId: string
    try {
      runId = checkedRunId(rawRunId)
    } catch (error) {
      safeNotifyError(input.onError, error, { kind, runId: String(rawRunId) })
      return Promise.resolve()
    }
    const active = activeRuns.get(runId)
    if (active) return active.promise

    let complete!: () => void
    const promise = new Promise<void>((resolve) => {
      complete = resolve
    })
    activeRuns.set(runId, { kind, promise })
    pendingRuns.push({ kind, runId, promise, complete })
    pump()
    return promise
  }

  const drainOnce = (): Promise<void> => {
    if (drainPromise) return drainPromise
    const currentDrain = (async () => {
      const listings = await Promise.allSettled([
        input.listQueuedRunIds(),
        input.listRecoveryRunIds(),
        input.listCleanupRunIds(),
      ])
      const listingKinds: readonly WorkerRunKind[] = ['queued', 'recovery', 'cleanup']
      const listedRunIds = new Map<WorkerRunKind, readonly string[]>()
      listings.forEach((listing, index) => {
        const kind = listingKinds[index]!
        if (listing.status === 'rejected') {
          safeNotifyError(input.onError, listing.reason, {
            kind,
            runId: '*',
          })
          return
        }
        listedRunIds.set(kind, listing.value)
      })
      const scheduled: Promise<void>[] = []
      const schedulingOrder: readonly WorkerRunKind[] = ['cleanup', 'recovery', 'queued']
      for (const kind of schedulingOrder) {
        for (const runId of listedRunIds.get(kind) ?? []) {
          scheduled.push(schedule(kind, runId))
        }
      }
      await Promise.all(scheduled)
    })()
    drainPromise = currentDrain
    void currentDrain.finally(() => {
      if (drainPromise === currentDrain) drainPromise = undefined
    })
    return currentDrain
  }

  return {
    start() {
      if (timer) return
      void drainOnce()
      timer = setInterval(() => {
        void drainOnce()
      }, pollIntervalMs)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
    enqueue(runId: string) {
      void schedule('queued', runId)
    },
    drainOnce,
  }
}

type IntegrationExecutionRecord = NonNullable<
  Awaited<ReturnType<typeof store.getIntegrationRunForExecution>>
>

const workerOwner = [
  'harmony-integration',
  hostname().replace(/[^A-Za-z0-9_.-]/g, '_'),
  process.pid,
  randomUUID(),
].join(':')

const runner = createIntegrationRunner({
  store,
  git: {
    freezeIntegrationGitSnapshot,
    createDetachedIntegrationWorktree,
    cleanupIntegrationWorktree,
  },
  opencode: { executeIntegrationArtifacts },
  releaseOpenCodeResources: cleanupIntegrationOpencodeResources,
  owner: workerOwner,
  claimLeaseMs: DEFAULT_EXECUTION_CLAIM_LEASE_MS,
})

function configuredProjects(): ReadonlyMap<
  string,
  IntegrationProjectConfig & { runtimeRoot?: string }
> {
  const runtimeRoot = process.env.HARMONY_INTEGRATION_RUNTIME_ROOT?.trim() || undefined
  return new Map(loadIntegrationProjects().map((project) => [
    project.id,
    { ...project, runtimeRoot },
  ]))
}

function publicWorkerErrorCode(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String(error.code)
    if (/^[A-Z0-9_]{1,64}$/.test(code)) return code
  }
  return fallback
}

export function startWorkerClaimHeartbeat(input: {
  runId: string
  owner: string
  epoch: number
  leaseMs: number
  controller?: AbortController
}, dependencies: {
  renewIntegrationRunClaim?: typeof store.renewIntegrationRunClaim
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
} = {}): {
  assertActive(): void
  stop(): Promise<void>
} {
  let stopped = false
  let renewalFailed = false
  let renewalFailure: unknown
  let inFlight: Promise<void> | undefined
  const renewClaim = dependencies.renewIntegrationRunClaim
    ?? store.renewIntegrationRunClaim
  const tick = () => {
    if (stopped || inFlight) return
    inFlight = renewClaim({
      ...input,
    }).then(
      () => {},
      (error) => {
        renewalFailed = true
        renewalFailure = error
        input.controller?.abort()
      },
    ).finally(() => {
      inFlight = undefined
    })
  }
  const scheduleInterval = dependencies.setInterval ?? setInterval
  const cancelInterval = dependencies.clearInterval ?? clearInterval
  const timer = scheduleInterval(
    tick,
    Math.max(1_000, Math.floor(input.leaseMs / 3)),
  )
  timer.unref?.()
  return {
    assertActive() {
      if (!renewalFailed && !input.controller?.signal.aborted) return
      throw Object.assign(
        new Error('集成 worker claim 续租失败，已停止后续写入', {
          cause: renewalFailure,
        }),
        { code: 'CLAIM_STALE' },
      )
    },
    async stop() {
      stopped = true
      cancelInterval(timer)
      await inFlight
    },
  }
}

async function releaseClaimQuietly(input: {
  runId: string
  owner: string
  epoch: number
}): Promise<void> {
  await store.releaseIntegrationRunClaim(input).catch(() => {})
}

async function failQueuedRun(
  runId: string,
  errorCode: string,
  error: string,
): Promise<void> {
  const claimed = await store.claimQueuedIntegrationRun({
    runId,
    owner: workerOwner,
    leaseMs: DEFAULT_EXECUTION_CLAIM_LEASE_MS,
  })
  if (!claimed?.claimOwner) return
  const fence = {
    runId,
    owner: claimed.claimOwner,
    epoch: claimed.claimEpoch,
  }
  try {
    await store.failIntegrationRunExecution({
      ...fence,
      errorCode,
      error,
    })
  } finally {
    await releaseClaimQuietly(fence)
  }
}

function runnerInput(
  record: IntegrationExecutionRecord,
  project: IntegrationProjectConfig & { runtimeRoot?: string },
) {
  if (!INTEGRATION_STAGES.has(record.stage as IntegrationStage)) {
    throw Object.assign(new Error('运行阶段配置无效'), {
      code: 'RUN_STAGE_INVALID',
    })
  }
  if (!record.artifacts.every((artifact) =>
    INTEGRATION_ARTIFACT_TYPES.has(artifact.type as IntegrationArtifactType))) {
    throw Object.assign(new Error('运行产物配置无效'), {
      code: 'RUN_ARTIFACT_INVALID',
    })
  }
  return {
    run: {
      id: record.id,
      taskId: record.taskId,
      stage: record.stage as IntegrationStage,
      triggerKey: record.triggerKey,
      status: record.status,
    },
    task: {
      id: record.task.id,
      projectId: record.task.projectId,
      title: record.task.title,
      sourceBranch: record.task.sourceBranch,
      targetBranch: record.task.targetBranch,
      scopePath: record.task.scopePath,
      featureDesc: record.task.featureDesc,
    },
    project: {
      id: project.id,
      repoRoot: project.repoRoot,
      runtimeRoot: project.runtimeRoot,
    },
    artifacts: record.artifacts.map((artifact) => ({
      id: artifact.id,
      type: artifact.type as IntegrationArtifactType,
      status: artifact.status,
      outputPath: artifact.outputPath,
      skillName: artifact.skillName,
    })),
  }
}

async function executeQueuedRun(runId: string): Promise<void> {
  const record = await store.getIntegrationRunForExecution(runId)
  if (!record || record.status !== 'queued') return
  let project: IntegrationProjectConfig & { runtimeRoot?: string } | undefined
  try {
    project = configuredProjects().get(record.task.projectId)
  } catch {
    await failQueuedRun(
      runId,
      'PROJECT_CONFIG_INVALID',
      '鸿蒙集成项目配置不可用',
    )
    return
  }
  if (!project) {
    await failQueuedRun(
      runId,
      'PROJECT_NOT_CONFIGURED',
      '该鸿蒙集成项目已不在服务端配置中',
    )
    return
  }

  try {
    await runner.run(runnerInput(record, project))
  } catch (error) {
    await failQueuedRun(
      runId,
      publicWorkerErrorCode(error, 'RUNNER_EXECUTION_FAILED'),
      '鸿蒙集成自动化执行失败',
    )
    throw error
  }
}

async function markRecoveryBlocked(input: {
  record: IntegrationExecutionRecord
  owner: string
  epoch: number
  errorCode: string
  error: string
}): Promise<void> {
  const fence = {
    runId: input.record.id,
    owner: input.owner,
    epoch: input.epoch,
  }
  if (input.record.status === 'running') {
    await store.failIntegrationRunExecution({
      ...fence,
      errorCode: input.errorCode,
      error: input.error,
    }).catch(() => {})
  }
  if (input.record.cleanupStatus === 'cleaning') {
    await store.failIntegrationRunCleanup({
      ...fence,
      cleanupErrorCode: input.errorCode,
      cleanupError: input.error,
    }).catch(() => {})
    return
  }
  await store.markIntegrationRunCleanupPending({
    ...fence,
    cleanupErrorCode: input.errorCode,
    cleanupError: input.error,
  }).catch(() => {})
  await releaseClaimQuietly(fence)
}

function recoveryArtifacts(
  record: IntegrationExecutionRecord,
): IntegrationRecoveryArtifact[] {
  return record.artifacts.map((artifact) => {
    if (!RECOVERY_PROMPT_STATES.has(
      artifact.promptState as IntegrationRecoveryPromptState,
    )) {
      throw Object.assign(new Error('产物 prompt 状态无效'), {
        code: 'RECOVERY_PROMPT_STATE_INVALID',
      })
    }
    return {
      id: artifact.id,
      status: artifact.status,
      promptState: artifact.promptState as IntegrationRecoveryPromptState,
      opencodeSessionId: artifact.opencodeSessionId,
      terminalAckAt: artifact.terminalAckAt,
      sessionDeletedAt: artifact.sessionDeletedAt,
    }
  })
}

export async function recoverMissingPreparingWorktreeIfAbsent(input: {
  record: {
    id: string
    status: string
    worktreeStatus: string
  }
  project: {
    repoRoot: string
    runtimeRoot?: string
  }
  fence: {
    runId: string
    owner: string
    epoch: number
  }
}, dependencies: {
  cleanupIntegrationWorktree(input: {
    repoRoot: string
    runtimeRoot?: string
    runId: string
  }): Promise<void>
  failIntegrationRunExecution(input: {
    runId: string
    owner: string
    epoch: number
    errorCode: string
    error: string
  }): Promise<unknown>
  markIntegrationRunCleanupSafeIfTerminal(input: {
    runId: string
    owner: string
    epoch: number
  }): Promise<{ safe: boolean }>
  beginIntegrationRunCleanup(input: {
    runId: string
    owner: string
    epoch: number
  }): Promise<unknown>
  finishIntegrationRunCleanup(input: {
    runId: string
    owner: string
    epoch: number
  }): Promise<unknown>
}): Promise<boolean> {
  if (
    input.record.worktreeStatus !== 'preparing'
    || (input.record.status !== 'running' && input.record.status !== 'failed')
  ) {
    return false
  }

  try {
    // Without a capability this function is a fail-closed absence probe: it
    // returns only when lock, manifest, run root, registration and quarantines
    // are all confirmed absent. Any remaining or uncertain resource must
    // continue through the token-authenticated reclaim path.
    await dependencies.cleanupIntegrationWorktree({
      repoRoot: input.project.repoRoot,
      runtimeRoot: input.project.runtimeRoot,
      runId: input.record.id,
    })
  } catch {
    return false
  }

  if (input.record.status === 'running') {
    await dependencies.failIntegrationRunExecution({
      ...input.fence,
      errorCode: 'RECOVERY_INTERRUPTED',
      error: '集成运行在隔离工作树准备阶段中断',
    })
  }
  const cleanupGate = await dependencies.markIntegrationRunCleanupSafeIfTerminal(
    input.fence,
  )
  if (!cleanupGate.safe) {
    throw Object.assign(new Error('隔离资源已确认不存在，但 cleanup 安全门尚未满足'), {
      code: 'RECOVERY_CLEANUP_GATE_PENDING',
    })
  }
  await dependencies.beginIntegrationRunCleanup(input.fence)
  await dependencies.finishIntegrationRunCleanup(input.fence)
  return true
}

async function recoverRun(runId: string): Promise<void> {
  const claimed = await store.claimIntegrationRunForRecovery({
    runId,
    owner: workerOwner,
    leaseMs: DEFAULT_RECOVERY_CLAIM_LEASE_MS,
  })
  if (!claimed?.claimOwner) return
  const record = await store.getIntegrationRunForExecution(runId)
  if (!record) {
    await releaseClaimQuietly({
      runId,
      owner: claimed.claimOwner,
      epoch: claimed.claimEpoch,
    })
    return
  }
  const owner = claimed.claimOwner
  const epoch = claimed.claimEpoch
  const recoveryController = new AbortController()
  const claimHeartbeat = startWorkerClaimHeartbeat({
    runId,
    owner,
    epoch,
    leaseMs: DEFAULT_RECOVERY_CLAIM_LEASE_MS,
    controller: recoveryController,
  })

  let project: (IntegrationProjectConfig & { runtimeRoot?: string }) | undefined
  try {
    project = configuredProjects().get(record.task.projectId)
  } catch {
    await claimHeartbeat.stop()
    await markRecoveryBlocked({
      record,
      owner,
      epoch,
      errorCode: 'PROJECT_CONFIG_INVALID',
      error: '鸿蒙集成项目配置不可用，隔离资源已保留',
    })
    return
  }
  if (!project) {
    await claimHeartbeat.stop()
    await markRecoveryBlocked({
      record,
      owner,
      epoch,
      errorCode: 'PROJECT_NOT_CONFIGURED',
      error: '该鸿蒙集成项目已不在服务端配置中，隔离资源已保留',
    })
    return
  }

  if (record.worktreeStatus === 'none') {
    const fence = { runId, owner, epoch }
    if (record.status === 'running') {
      await store.failIntegrationRunExecution({
        ...fence,
        errorCode: 'RECOVERY_INTERRUPTED',
        error: '集成运行在创建隔离工作树前中断',
      })
    }
    await claimHeartbeat.stop()
    await releaseClaimQuietly(fence)
    return
  }
  if (!record.worktreeLeaseCipher) {
    await claimHeartbeat.stop()
    await markRecoveryBlocked({
      record,
      owner,
      epoch,
      errorCode: 'RECOVERY_CAPABILITY_MISSING',
      error: '隔离工作树恢复凭据缺失，资源已保留待人工处理',
    })
    return
  }

  let leaseToken: string
  let artifacts: IntegrationRecoveryArtifact[]
  try {
    leaseToken = decryptApiKey(record.worktreeLeaseCipher)
    if (!/^[a-f0-9]{64}$/.test(leaseToken)) {
      throw new Error('invalid lease capability')
    }
    artifacts = recoveryArtifacts(record)
  } catch (error) {
    await claimHeartbeat.stop()
    await markRecoveryBlocked({
      record,
      owner,
      epoch,
      errorCode: publicWorkerErrorCode(error, 'RECOVERY_CAPABILITY_INVALID'),
      error: '隔离工作树恢复数据无效，资源已保留待人工处理',
    })
    return
  }

  try {
    const preparingRunConverged = await recoverMissingPreparingWorktreeIfAbsent({
      record,
      project,
      fence: { runId, owner, epoch },
    }, {
      cleanupIntegrationWorktree,
      failIntegrationRunExecution: store.failIntegrationRunExecution,
      markIntegrationRunCleanupSafeIfTerminal:
        store.markIntegrationRunCleanupSafeIfTerminal,
      beginIntegrationRunCleanup: store.beginIntegrationRunCleanup,
      finishIntegrationRunCleanup: store.finishIntegrationRunCleanup,
    })
    if (preparingRunConverged) {
      await claimHeartbeat.stop()
      recoveryRetryAfter.delete(runId)
      return
    }

    const result = await recoverClaimedIntegrationRun({
      run: {
        id: record.id,
        taskId: record.taskId,
        status: record.status,
        opencodeDisposedAt: record.opencodeDisposedAt,
      },
      task: {
        id: record.task.id,
        projectId: record.task.projectId,
      },
      project: {
        id: project.id,
        repoRoot: project.repoRoot,
        runtimeRoot: project.runtimeRoot,
      },
      artifacts,
      claim: { owner, epoch },
      worktreeLease: {
        repoRoot: project.repoRoot,
        runtimeRoot: project.runtimeRoot,
        runId,
        leaseToken,
      },
      signal: recoveryController.signal,
    }, {
      store,
      reclaimActiveIntegrationWorktreeLease,
      createRecoveryOpencodeClient: ({ directory }) =>
        createDirectoryOpencodeClient({ directory }),
      cleanupIntegrationOpencodeResources,
      cleanupIntegrationWorktree,
    })
    await claimHeartbeat.stop()
    if (result.status === 'pending') {
      recoveryRetryAfter.set(runId, Date.now() + RECOVERY_RETRY_BACKOFF_MS)
      await releaseClaimQuietly({ runId, owner, epoch })
    } else {
      recoveryRetryAfter.delete(runId)
    }
  } catch (error) {
    await claimHeartbeat.stop()
    if (
      record.cleanupStatus === 'cleaning' &&
      record.opencodeDisposedAt &&
      record.artifacts.every((artifact) =>
        !artifact.opencodeSessionId || artifact.sessionDeletedAt)
    ) {
      try {
        await cleanupIntegrationWorktree({
          repoRoot: project.repoRoot,
          runtimeRoot: project.runtimeRoot,
          runId,
        })
        await store.finishIntegrationRunCleanup({ runId, owner, epoch })
        recoveryRetryAfter.delete(runId)
        return
      } catch {
        // 保留原始 recovery 失败，由下方的安全 pending 路径处理。
      }
    }
    recoveryRetryAfter.set(runId, Date.now() + RECOVERY_RETRY_BACKOFF_MS)
    await markRecoveryBlocked({
      record,
      owner,
      epoch,
      errorCode: publicWorkerErrorCode(error, 'RECOVERY_ATTEMPT_FAILED'),
      error: '集成恢复尝试失败，隔离资源已保留',
    })
    throw error
  }
}

async function cleanupRun(runId: string): Promise<void> {
  const claimed = await store.claimIntegrationRunCleanup({
    runId,
    owner: workerOwner,
    leaseMs: DEFAULT_RECOVERY_CLAIM_LEASE_MS,
  })
  if (!claimed?.claimOwner) return
  const fence = {
    runId,
    owner: claimed.claimOwner,
    epoch: claimed.claimEpoch,
  }
  const cleanupController = new AbortController()
  const claimHeartbeat = startWorkerClaimHeartbeat({
    ...fence,
    leaseMs: DEFAULT_RECOVERY_CLAIM_LEASE_MS,
    controller: cleanupController,
  })
  try {
    const record = await store.getIntegrationRunForExecution(runId)
    if (!record) {
      claimHeartbeat.assertActive()
      await releaseClaimQuietly(fence)
      return
    }
    if (record.worktreeStatus === 'none' || record.worktreeStatus === 'cleaned') {
      claimHeartbeat.assertActive()
      await store.finishIntegrationRunCleanup(fence)
      return
    }
    const project = configuredProjects().get(record.task.projectId)
    const leaseToken = record.worktreeLeaseCipher
      ? decryptApiKey(record.worktreeLeaseCipher)
      : undefined
    if (!project || !leaseToken || !/^[a-f0-9]{64}$/.test(leaseToken)) {
      throw new Error('cleanup capability unavailable')
    }
    const lease = {
      repoRoot: project.repoRoot,
      runtimeRoot: project.runtimeRoot,
      runId,
      leaseToken,
    }
    try {
      await reclaimIntegrationWorktreeLeaseForCleanup(lease)
      claimHeartbeat.assertActive()
    } catch {
      claimHeartbeat.assertActive()
      // 上一进程可能已删除全部 worktree 资源、但在写回 completed 前崩溃。
      // 无 capability 的 fail-closed 检查只会在确认资源已完全消失时成功。
      await cleanupIntegrationWorktree({
        repoRoot: project.repoRoot,
        runtimeRoot: project.runtimeRoot,
        runId,
      })
      claimHeartbeat.assertActive()
      await store.finishIntegrationRunCleanup(fence)
      return
    }
    await cleanupIntegrationWorktree(lease)
    claimHeartbeat.assertActive()
    await store.finishIntegrationRunCleanup(fence)
  } catch {
    if (cleanupController.signal.aborted) return
    claimHeartbeat.assertActive()
    await store.failIntegrationRunCleanup({
      ...fence,
      cleanupErrorCode: 'WORKTREE_CLEANUP_FAILED',
      cleanupError: '隔离工作树清理失败，资源已安全保留',
    }).catch(() => {})
  } finally {
    await claimHeartbeat.stop()
  }
}

function logWorkerError(error: unknown, context: IntegrationWorkerErrorContext): void {
  console.error('[harmony-integration-worker]', {
    kind: context.kind,
    runId: context.runId,
    code: publicWorkerErrorCode(error, 'INTEGRATION_WORKER_FAILED'),
  })
}

const globalWorkerState = globalThis as typeof globalThis & {
  __harmonyIntegrationWorker?: IntegrationWorkerEngine
}

const recoveryRetryAfter = new Map<string, number>()

function defaultWorker(): IntegrationWorkerEngine {
  if (globalWorkerState.__harmonyIntegrationWorker) {
    return globalWorkerState.__harmonyIntegrationWorker
  }
  const engine = createIntegrationWorkerEngine({
    maxConcurrency: resolveIntegrationWorkerConcurrency(
      process.env.HARMONY_INTEGRATION_WORKER_CONCURRENCY,
    ),
    async listQueuedRunIds() {
      return (await store.listQueuedIntegrationRuns({
        limit: DEFAULT_CANDIDATE_LIMIT,
      })).map((run) => run.id)
    },
    async listRecoveryRunIds() {
      return (await store.listIntegrationRunRecoveryCandidates({
        limit: DEFAULT_CANDIDATE_LIMIT,
      })).map((run) => run.id).filter((runId) =>
        (recoveryRetryAfter.get(runId) ?? 0) <= Date.now())
    },
    async listCleanupRunIds() {
      return (await store.listIntegrationCleanupCandidates({
        limit: DEFAULT_CANDIDATE_LIMIT,
      })).map((run) => run.id)
    },
    executeQueuedRun,
    recoverRun,
    cleanupRun,
    onError: logWorkerError,
  })
  globalWorkerState.__harmonyIntegrationWorker = engine
  return engine
}

export function startIntegrationWorker(): void {
  defaultWorker().start()
}

export function enqueueIntegrationRun(runId: string): void {
  defaultWorker().enqueue(runId)
}
