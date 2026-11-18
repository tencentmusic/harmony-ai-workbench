import type { Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'
import {
  hasUnsafeMultilineControlCharacters,
  INTEGRATION_REVIEW_NOTE_MAX_LENGTH,
  isAllowedIntegrationTransition,
  isIntegrationReviewArtifact,
  resolveTriggeredStage,
  resolveRerunnableIntegrationStages,
  type IntegrationArtifactType,
  type IntegrationStage,
  type IntegrationTaskStatus,
} from '@/server/modules/integration/integration-domain'

export type IntegrationAutomationStatus = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed'
export type IntegrationRunStatus = 'queued' | 'running' | 'succeeded' | 'failed'
export type IntegrationArtifactStatus = 'queued' | 'running' | 'succeeded' | 'failed'
export type IntegrationCleanupStatus =
  | 'not_ready'
  | 'pending'
  | 'safe'
  | 'cleaning'
  | 'failed'
  | 'completed'

export class IntegrationStoreError extends Error {
  readonly code: string

  constructor(
    code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options)
    this.name = 'IntegrationStoreError'
    this.code = code
  }
}

const integrationTaskInclude = {
  creator: {
    select: {
      id: true,
      personName: true,
      personCode: true,
      label: true,
    },
  },
  events: {
    orderBy: { createdAt: 'desc' },
  },
  runs: {
    orderBy: { sequence: 'desc' },
    include: {
      artifacts: {
        orderBy: { createdAt: 'asc' },
        include: {
          reviewNoteUpdatedBy: {
            select: { personName: true },
          },
        },
      },
    },
  },
} satisfies Prisma.IntegrationTaskInclude

export type IntegrationTaskWithRuns = Prisma.IntegrationTaskGetPayload<{
  include: typeof integrationTaskInclude
}>

type IntegrationStatusUpdateInput = {
  taskId: string
  expectedStatus?: IntegrationTaskStatus
  status: IntegrationTaskStatus
  actorTokenId?: string | null
}

type ClaimIdentity = {
  owner: string
  epoch: number
  now?: Date
}

type ClaimRequest = {
  runId: string
  owner: string
  leaseMs: number
  now?: Date
}

type FencedRunInput = ClaimIdentity & {
  runId: string
}

type FencedArtifactInput = ClaimIdentity & {
  artifactId: string
}

const TRANSACTION_RETRY_LIMIT = 8

function currentTime(now?: Date): Date {
  return now ? new Date(now) : new Date()
}

function claimExpiry(now: Date, leaseMs: number): Date {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new IntegrationStoreError('CLAIM_INVALID_LEASE', 'leaseMs 必须是正整数')
  }
  return new Date(now.getTime() + leaseMs)
}

function requireNonEmpty(field: string, value: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new IntegrationStoreError('INVALID_INPUT', `${field} 不能为空`)
  }
  return normalized
}

function artifactsForStage(stage: IntegrationStage): Array<{
  type: IntegrationArtifactType
  outputPath: string
  skillName: string
}> {
  return stage === 'submit_review_and_tests'
    ? [
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
    ]
    : [{
      type: 'final_review',
      outputPath: 'artifacts/final-review.md',
      skillName: 'harmony-branch-code-review',
    }]
}

function isRetryableTransactionError(error: unknown): boolean {
  if (error instanceof IntegrationStoreError && error.code === 'STATUS_CAS_CONFLICT') {
    return true
  }
  if (!error || typeof error !== 'object') return false
  const code = 'code' in error ? String(error.code) : ''
  return code === 'P2002' || code === 'P2028' || code === 'P2034'
}

async function withTransactionRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < TRANSACTION_RETRY_LIMIT; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!isRetryableTransactionError(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, attempt * 5))
    }
  }
  throw lastError
}

async function syncAutomationForRun(
  tx: Prisma.TransactionClient,
  run: { taskId: string, sequence: number, status: string },
): Promise<void> {
  await tx.integrationTask.updateMany({
    where: {
      id: run.taskId,
      runs: {
        none: { sequence: { gt: run.sequence } },
      },
    },
    data: { automationStatus: run.status },
  })
}

async function fenceRunClaim(
  tx: Prisma.TransactionClient,
  input: FencedRunInput,
) {
  const now = currentTime(input.now)
  const fenced = await tx.integrationRun.updateMany({
    where: {
      id: input.runId,
      claimOwner: input.owner,
      claimEpoch: input.epoch,
      claimExpiresAt: { gt: now },
    },
    // A same-value update deliberately obtains the row write lock before a
    // dependent artifact/run mutation in this transaction.
    data: { claimOwner: input.owner },
  })
  if (fenced.count !== 1) {
    throw new IntegrationStoreError(
      'CLAIM_STALE',
      `运行 ${input.runId} 的 owner/epoch 已变化或租约已过期`,
    )
  }
  return tx.integrationRun.findUniqueOrThrow({ where: { id: input.runId } })
}

async function fenceArtifactClaim(
  tx: Prisma.TransactionClient,
  input: FencedArtifactInput,
) {
  const artifact = await tx.integrationArtifact.findUnique({
    where: { id: input.artifactId },
  })
  if (!artifact) {
    throw new IntegrationStoreError('ARTIFACT_NOT_FOUND', `产物不存在：${input.artifactId}`)
  }
  const run = await fenceRunClaim(tx, {
    runId: artifact.runId,
    owner: input.owner,
    epoch: input.epoch,
    now: input.now,
  })
  return { artifact, run }
}

export async function listIntegrationTasks(filters: {
  projectId?: string
  status?: IntegrationTaskStatus
} = {}): Promise<IntegrationTaskWithRuns[]> {
  return prisma.integrationTask.findMany({
    where: {
      projectId: filters.projectId,
      status: filters.status,
    },
    orderBy: { updatedAt: 'desc' },
    include: integrationTaskInclude,
  })
}

export async function getIntegrationTask(id: string): Promise<IntegrationTaskWithRuns | null> {
  return prisma.integrationTask.findUnique({
    where: { id },
    include: integrationTaskInclude,
  })
}

export async function getIntegrationRunForExecution(id: string) {
  return prisma.integrationRun.findUnique({
    where: { id },
    include: {
      task: true,
      artifacts: {
        orderBy: { createdAt: 'asc' },
      },
    },
  })
}

export async function createIntegrationTask(input: {
  id?: string
  title: string
  projectId: string
  sourceBranch: string
  targetBranch: string
  scopePath?: string | null
  featureDesc?: string | null
  createdByTokenId?: string | null
}): Promise<IntegrationTaskWithRuns> {
  return prisma.integrationTask.create({
    data: {
      ...(input.id ? { id: input.id } : {}),
      title: input.title,
      projectId: input.projectId,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      scopePath: input.scopePath ?? null,
      featureDesc: input.featureDesc ?? null,
      status: 'developing',
      automationStatus: 'idle',
      createdByTokenId: input.createdByTokenId ?? null,
    },
    include: integrationTaskInclude,
  })
}

export async function deleteIntegrationTask(taskId: string): Promise<void> {
  const id = requireNonEmpty('taskId', taskId)
  const now = new Date()
  const deleted = await prisma.integrationTask.deleteMany({
    where: {
      id,
      runs: {
        none: {
          OR: [
            { status: { notIn: ['succeeded', 'failed'] } },
            { cleanupStatus: { not: 'completed' } },
            { cleanupCompletedAt: null },
            {
              AND: [
                { claimOwner: { not: null } },
                {
                  OR: [
                    { claimExpiresAt: null },
                    { claimExpiresAt: { gt: now } },
                  ],
                },
              ],
            },
            { worktreeStatus: { notIn: ['none', 'cleaned'] } },
            { worktreePath: { not: null } },
            { worktreeLeaseCipher: { not: null } },
            {
              artifacts: {
                some: { status: { notIn: ['succeeded', 'failed'] } },
              },
            },
            {
              artifacts: {
                some: {
                  opencodeSessionId: { not: null },
                  sessionDeletedAt: null,
                },
              },
            },
            {
              AND: [
                {
                  artifacts: {
                    some: { opencodeSessionId: { not: null } },
                  },
                },
                { opencodeDisposedAt: null },
              ],
            },
          ],
        },
      },
    },
  })
  if (deleted.count === 1) return

  const task = await prisma.integrationTask.findUnique({
    where: { id },
    select: { id: true },
  })
  if (!task) {
    throw new IntegrationStoreError('TASK_NOT_FOUND', `集成任务不存在：${id}`)
  }
  throw new IntegrationStoreError(
    'TASK_DELETE_BLOCKED',
    `任务 ${id} 的自动化仍在执行，或隔离资源尚未完成清理`,
  )
}

async function createRunInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    taskId: string
    stage: IntegrationStage
    triggerKey: string
  },
) {
  const triggerKey = requireNonEmpty('triggerKey', input.triggerKey)
  const existing = await tx.integrationRun.findUnique({ where: { triggerKey } })
  if (existing) {
    if (existing.taskId !== input.taskId || existing.stage !== input.stage) {
      throw new IntegrationStoreError(
        'TRIGGER_KEY_CONFLICT',
        `triggerKey 已属于其他运行：${triggerKey}`,
      )
    }
    return existing
  }

  const task = await tx.integrationTask.findUnique({
    where: { id: input.taskId },
    select: { id: true },
  })
  if (!task) {
    throw new IntegrationStoreError('TASK_NOT_FOUND', `集成任务不存在：${input.taskId}`)
  }
  const latestRun = await tx.integrationRun.findFirst({
    where: { taskId: input.taskId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  })
  const run = await tx.integrationRun.create({
    data: {
      taskId: input.taskId,
      stage: input.stage,
      sequence: (latestRun?.sequence ?? 0) + 1,
      triggerKey,
      status: 'queued',
      artifacts: {
        create: artifactsForStage(input.stage),
      },
    },
  })
  await tx.integrationTask.update({
    where: { id: input.taskId },
    data: { automationStatus: 'queued' },
  })
  return run
}

async function findTransitionReplay(
  tx: Prisma.TransactionClient,
  taskId: string,
  status: IntegrationTaskStatus,
) {
  const event = await tx.integrationTaskEvent.findFirst({
    where: { taskId, toStatus: status, fromStatus: { not: null } },
    orderBy: { createdAt: 'desc' },
  })
  if (!event || !event.fromStatus) return null
  const stage = resolveTriggeredStage(event.fromStatus as IntegrationTaskStatus, status)
  if (!stage) return null
  return tx.integrationRun.findUnique({ where: { triggerKey: `transition-event:${event.id}` } })
}

async function transitionInTransaction(
  tx: Prisma.TransactionClient,
  input: IntegrationStatusUpdateInput,
  createTriggeredRun: boolean,
) {
  const current = await tx.integrationTask.findUnique({
    where: { id: input.taskId },
    select: { status: true },
  })
  if (!current) {
    throw new IntegrationStoreError('TASK_NOT_FOUND', `集成任务不存在：${input.taskId}`)
  }
  const fromStatus = current.status as IntegrationTaskStatus
  if (
    input.expectedStatus &&
    fromStatus !== input.expectedStatus &&
    fromStatus !== input.status
  ) {
    throw new IntegrationStoreError(
      'STATUS_CAS_CONFLICT',
      `任务状态已从预期的 ${input.expectedStatus} 变化为 ${fromStatus}`,
    )
  }
  if (!isAllowedIntegrationTransition(fromStatus, input.status)) {
    throw new IntegrationStoreError(
      'INVALID_STATUS_TRANSITION',
      `非法的集成任务状态跳转：${fromStatus} -> ${input.status}`,
    )
  }
  if (fromStatus === input.status) {
    const run = createTriggeredRun
      ? await findTransitionReplay(tx, input.taskId, input.status)
      : null
    return { changed: false, run }
  }

  const changed = await tx.integrationTask.updateMany({
    where: { id: input.taskId, status: fromStatus },
    data: { status: input.status },
  })
  if (changed.count !== 1) {
    throw new IntegrationStoreError('STATUS_CAS_CONFLICT', `任务状态已并发变化：${input.taskId}`)
  }
  const event = await tx.integrationTaskEvent.create({
    data: {
      taskId: input.taskId,
      fromStatus,
      toStatus: input.status,
      actorTokenId: input.actorTokenId ?? null,
    },
  })
  const stage = createTriggeredRun ? resolveTriggeredStage(fromStatus, input.status) : null
  const run = stage
    ? await createRunInTransaction(tx, {
      taskId: input.taskId,
      stage,
      triggerKey: `transition-event:${event.id}`,
    })
    : null
  return { changed: true, run }
}

export async function transitionIntegrationTaskStatus(input: IntegrationStatusUpdateInput) {
  return withTransactionRetry(() => prisma.$transaction(async (tx) => {
    const current = await tx.integrationTask.findUnique({ where: { id: input.taskId }, select: { id: true, featureDesc: true, sourceBranch: true, targetBranch: true } })
    const cloud = current?.id.startsWith('cloud-') ? await tx.cloudAgentTask.findUnique({ where: { id: current.id.slice(6) }, select: { harnessJson: true } }) : null
    const saved = cloud ? JSON.parse(cloud.harnessJson) : null
    const delivery = saved?.delivery, candidate = delivery?.codeCandidate || delivery?.code
    const registered = delivery?.integrationId === current?.id && candidate?.branch === current?.sourceBranch && candidate?.target === current?.targetBranch &&
      typeof delivery?.codeSnapshot?.sha === 'string' && current?.featureDesc?.includes(`验收快照：${delivery.codeSnapshot.sha}\n`)
    const handoff = registered || current?.id.startsWith('cloud-') && current.featureDesc?.includes('已通过云Agent独立代码审查与Harness交付门禁')
    const transition = await transitionInTransaction(tx, input, !handoff)
    const task = await tx.integrationTask.findUniqueOrThrow({
      where: { id: input.taskId },
      include: integrationTaskInclude,
    })
    return { task, run: transition.run }
  }))
}

export async function listIntegrationHandoffs(ids: string[]) {
  return prisma.integrationTask.findMany({ where: { id: { in: ids } }, select: {
    id: true, status: true, projectId: true, sourceBranch: true, targetBranch: true, featureDesc: true,
    events: { where: { fromStatus: 'developing', toStatus: 'submitted' }, orderBy: { createdAt: 'desc' }, take: 1,
      select: { createdAt: true, actorToken: { select: { personName: true } } } },
  } })
}

// Share the caller's transaction: confirmation and its cloud audit must commit together.
export async function confirmIntegrationHandoff(tx: Prisma.TransactionClient, input: {
  id: string; projectId: string; branch: string; target: string; sha: string; actorId: string
  create?: { title: string; featureDesc: string; createdByTokenId: string | null }
}) {
  let task = await tx.integrationTask.findUnique({ where: { id: input.id } })
  if (!task && input.create) task = await tx.integrationTask.create({ data: { id: input.id, title: input.create.title, featureDesc: input.create.featureDesc,
    createdByTokenId: input.create.createdByTokenId, projectId: input.projectId, sourceBranch: input.branch, targetBranch: input.target, status: 'developing', automationStatus: 'idle' } })
  if (!task || task.projectId !== input.projectId || task.sourceBranch !== input.branch || task.targetBranch !== input.target || !task.featureDesc?.includes(`验收快照：${input.sha}\n`)) throw new IntegrationStoreError('HANDOFF_MISMATCH', '集成记录与交付快照不一致')
  if (task.status === 'closed') throw new IntegrationStoreError('HANDOFF_CLOSED', '集成记录已关闭，不能确认提测')
  if (['submitted', 'merge_pending', 'merged'].includes(task.status)) return false
  if (task.status !== 'developing') throw new IntegrationStoreError('HANDOFF_STATE', '集成记录状态不支持确认提测')
  await transitionInTransaction(tx, { taskId: task.id, status: 'submitted', expectedStatus: 'developing', actorTokenId: input.actorId }, false)
  return true
}

export async function createIntegrationRun(input: {
  taskId: string
  stage: IntegrationStage
  triggerKey: string
}) {
  try {
    return await withTransactionRetry(() => prisma.$transaction(
      (tx) => createRunInTransaction(tx, input),
    ))
  } catch (error) {
    if (!isRetryableTransactionError(error)) throw error
    const existing = await prisma.integrationRun.findUnique({
      where: { triggerKey: input.triggerKey },
    })
    if (existing && existing.taskId === input.taskId && existing.stage === input.stage) {
      return existing
    }
    throw error
  }
}

export async function retryLatestIntegrationRun(input: {
  taskId: string
  expectedRunId?: string
}) {
  return withTransactionRetry(() => prisma.$transaction(async (tx) => {
    const task = await tx.integrationTask.findUnique({
      where: { id: input.taskId },
      select: { id: true },
    })
    if (!task) {
      throw new IntegrationStoreError('TASK_NOT_FOUND', `集成任务不存在：${input.taskId}`)
    }

    if (input.expectedRunId) {
      const replay = await tx.integrationRun.findUnique({
        where: { triggerKey: `retry-run:${input.expectedRunId}` },
      })
      if (replay) {
        if (replay.taskId !== input.taskId) {
          throw new IntegrationStoreError(
            'RUN_CAS_CONFLICT',
            `运行 ${input.expectedRunId} 不属于任务 ${input.taskId}`,
          )
        }
        return replay
      }
    }

    const latestRun = await tx.integrationRun.findFirst({
      where: { taskId: input.taskId },
      orderBy: { sequence: 'desc' },
    })
    if (!latestRun) {
      throw new IntegrationStoreError('RUN_NOT_FOUND', `任务 ${input.taskId} 尚无可重试运行`)
    }
    if (input.expectedRunId && latestRun.id !== input.expectedRunId) {
      throw new IntegrationStoreError(
        'RUN_CAS_CONFLICT',
        `任务最新运行已从 ${input.expectedRunId} 变化为 ${latestRun.id}`,
      )
    }
    if (
      !input.expectedRunId &&
      latestRun.triggerKey.startsWith('retry-run:') &&
      (latestRun.status === 'queued' || latestRun.status === 'running')
    ) {
      return latestRun
    }
    if (latestRun.status !== 'failed') {
      throw new IntegrationStoreError(
        'RUN_NOT_FAILED',
        `运行 ${latestRun.id} 当前为 ${latestRun.status}，不能重试`,
      )
    }
    if (latestRun.cleanupStatus !== 'completed') {
      throw new IntegrationStoreError(
        'RUN_CLEANUP_PENDING',
        `运行 ${latestRun.id} 的隔离资源尚未清理完成`,
      )
    }

    return createRunInTransaction(tx, {
      taskId: input.taskId,
      stage: latestRun.stage as IntegrationStage,
      triggerKey: `retry-run:${latestRun.id}`,
    })
  }))
}

export async function rerunIntegrationStage(input: {
  taskId: string
  stage: IntegrationStage
  expectedRunId: string
}) {
  const taskId = requireNonEmpty('taskId', input.taskId)
  const expectedRunId = requireNonEmpty('expectedRunId', input.expectedRunId)
  const triggerKey = `rerun-run:${expectedRunId}`

  return withTransactionRetry(() => prisma.$transaction(async (tx) => {
    // Replaying a committed command must succeed even if task state changes
    // after the original response was lost.
    const replay = await tx.integrationRun.findUnique({ where: { triggerKey } })
    if (replay) {
      if (replay.taskId !== taskId || replay.stage !== input.stage) {
        throw new IntegrationStoreError(
          'RUN_CAS_CONFLICT',
          `重跑命令 ${triggerKey} 已属于其他任务或阶段`,
        )
      }
      return replay
    }

    const task = await tx.integrationTask.findUnique({
      where: { id: taskId },
      select: { status: true },
    })
    if (!task) {
      throw new IntegrationStoreError('TASK_NOT_FOUND', `集成任务不存在：${taskId}`)
    }
    const allowedStages = resolveRerunnableIntegrationStages(
      task.status as IntegrationTaskStatus,
    )
    if (!allowedStages.includes(input.stage)) {
      throw new IntegrationStoreError(
        'RERUN_STAGE_NOT_ALLOWED',
        `任务状态 ${task.status} 不允许重跑阶段 ${input.stage}`,
      )
    }

    const latestStageRun = await tx.integrationRun.findFirst({
      where: { taskId, stage: input.stage },
      orderBy: { sequence: 'desc' },
    })
    if (!latestStageRun) {
      throw new IntegrationStoreError(
        'RUN_NOT_FOUND',
        `任务 ${taskId} 的阶段 ${input.stage} 尚无可重跑运行`,
      )
    }
    if (latestStageRun.id !== expectedRunId) {
      throw new IntegrationStoreError(
        'RUN_CAS_CONFLICT',
        `阶段最新运行已从 ${expectedRunId} 变化为 ${latestStageRun.id}`,
      )
    }

    const activeRun = await tx.integrationRun.findFirst({
      where: { taskId, status: { in: ['queued', 'running'] } },
      select: { id: true },
    })
    if (activeRun) {
      throw new IntegrationStoreError(
        'RUN_ACTIVE',
        `任务 ${taskId} 仍有运行 ${activeRun.id} 正在执行`,
      )
    }
    if (latestStageRun.status !== 'succeeded' && latestStageRun.status !== 'failed') {
      throw new IntegrationStoreError(
        'RUN_ACTIVE',
        `运行 ${latestStageRun.id} 当前为 ${latestStageRun.status}，不能重跑`,
      )
    }
    if (latestStageRun.cleanupStatus !== 'completed') {
      throw new IntegrationStoreError(
        'RUN_CLEANUP_PENDING',
        `运行 ${latestStageRun.id} 的隔离资源尚未清理完成`,
      )
    }

    const newerUncleanRun = await tx.integrationRun.findFirst({
      where: {
        taskId,
        sequence: { gt: latestStageRun.sequence },
        cleanupStatus: { not: 'completed' },
      },
      select: { id: true },
    })
    if (newerUncleanRun) {
      throw new IntegrationStoreError(
        'RUN_CLEANUP_PENDING',
        `较新的运行 ${newerUncleanRun.id} 尚未清理完成`,
      )
    }

    return createRunInTransaction(tx, {
      taskId,
      stage: input.stage,
      triggerKey,
    })
  }))
}

export async function updateIntegrationArtifactReviewNote(input: {
  taskId: string
  artifactId: string
  note: string | null
  expectedUpdatedAt: Date | null
  actorTokenId: string
  now?: Date
}) {
  const taskId = requireNonEmpty('taskId', input.taskId)
  const artifactId = requireNonEmpty('artifactId', input.artifactId)
  const actorTokenId = requireNonEmpty('actorTokenId', input.actorTokenId)
  const note = input.note?.trim() || null
  if (note && note.length > INTEGRATION_REVIEW_NOTE_MAX_LENGTH) {
    throw new IntegrationStoreError(
      'INVALID_INPUT',
      `note 不能超过 ${INTEGRATION_REVIEW_NOTE_MAX_LENGTH} 个字符`,
    )
  }
  if (note && hasUnsafeMultilineControlCharacters(note)) {
    throw new IntegrationStoreError('INVALID_INPUT', 'note 不能包含控制字符')
  }
  if (
    input.expectedUpdatedAt !== null
    && (
      !(input.expectedUpdatedAt instanceof Date)
      || !Number.isFinite(input.expectedUpdatedAt.getTime())
    )
  ) {
    throw new IntegrationStoreError('INVALID_INPUT', 'expectedUpdatedAt 必须是有效时间')
  }

  return prisma.$transaction(async (tx) => {
    const artifact = await tx.integrationArtifact.findFirst({
      where: {
        id: artifactId,
        run: { taskId },
      },
    })
    if (!artifact) {
      throw new IntegrationStoreError(
        'ARTIFACT_NOT_FOUND',
        `任务 ${taskId} 中不存在产物 ${artifactId}`,
      )
    }
    if (!isIntegrationReviewArtifact(artifact.type)) {
      throw new IntegrationStoreError(
        'ARTIFACT_NOT_REVIEW',
        `产物 ${artifactId} 不是审查报告`,
      )
    }
    if (artifact.status !== 'succeeded') {
      throw new IntegrationStoreError(
        'ARTIFACT_NOT_SUCCEEDED',
        `产物 ${artifactId} 尚未成功归档`,
      )
    }

    const expectedTime = input.expectedUpdatedAt?.getTime() ?? null
    const actualTime = artifact.reviewNoteUpdatedAt?.getTime() ?? null
    if (expectedTime !== actualTime) {
      throw new IntegrationStoreError(
        'REVIEW_NOTE_CAS_CONFLICT',
        `审查说明已被其他人更新：${artifactId}`,
      )
    }
    const requestedTime = currentTime(input.now).getTime()
    const nextTime = new Date(Math.max(requestedTime, (actualTime ?? -1) + 1))
    const updated = await tx.integrationArtifact.updateMany({
      where: {
        id: artifactId,
        reviewNoteUpdatedAt: input.expectedUpdatedAt,
      },
      data: {
        reviewNote: note,
        reviewNoteUpdatedAt: nextTime,
        reviewNoteUpdatedByTokenId: actorTokenId,
      },
    })
    if (updated.count !== 1) {
      throw new IntegrationStoreError(
        'REVIEW_NOTE_CAS_CONFLICT',
        `审查说明已被其他人更新：${artifactId}`,
      )
    }
    return tx.integrationArtifact.findUniqueOrThrow({
      where: { id: artifactId },
      include: {
        reviewNoteUpdatedBy: {
          select: { personName: true },
        },
      },
    })
  })
}

export async function claimQueuedIntegrationRun(input: ClaimRequest) {
  const now = currentTime(input.now)
  const expiresAt = claimExpiry(now, input.leaseMs)
  requireNonEmpty('owner', input.owner)

  return withTransactionRetry(() => prisma.$transaction(async (tx) => {
    const claimed = await tx.integrationRun.updateMany({
      where: {
        id: input.runId,
        status: 'queued',
        OR: [
          { claimOwner: null },
          { claimExpiresAt: null },
          { claimExpiresAt: { lte: now } },
        ],
      },
      data: {
        status: 'running',
        claimOwner: input.owner,
        claimEpoch: { increment: 1 },
        claimExpiresAt: expiresAt,
        startedAt: now,
        finishedAt: null,
        errorCode: null,
        error: null,
      },
    })
    if (claimed.count !== 1) return null
    const run = await tx.integrationRun.findUniqueOrThrow({ where: { id: input.runId } })
    await syncAutomationForRun(tx, run)
    return run
  }))
}

function recoveryCandidateWhere(now: Date): Prisma.IntegrationRunWhereInput {
  return {
    AND: [
      {
        OR: [
          { status: 'running' },
          { cleanupStatus: { in: ['pending', 'cleaning'] } },
        ],
      },
      {
        OR: [
          { claimOwner: null },
          { claimExpiresAt: null },
          { claimExpiresAt: { lte: now } },
        ],
      },
    ],
  }
}

function unclaimedOrExpiredWhere(now: Date): Prisma.IntegrationRunWhereInput {
  return {
    OR: [
      { claimOwner: null },
      { claimExpiresAt: null },
      { claimExpiresAt: { lte: now } },
    ],
  }
}

function checkedCandidateLimit(limit = 100): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new IntegrationStoreError('INVALID_INPUT', 'limit 必须在 1..1000 之间')
  }
  return limit
}

export async function listQueuedIntegrationRuns(input: {
  now?: Date
  limit?: number
} = {}) {
  const now = currentTime(input.now)
  return prisma.integrationRun.findMany({
    where: {
      status: 'queued',
      ...unclaimedOrExpiredWhere(now),
    },
    orderBy: { createdAt: 'asc' },
    take: checkedCandidateLimit(input.limit),
  })
}

export async function listIntegrationCleanupCandidates(input: {
  now?: Date
  limit?: number
} = {}) {
  const now = currentTime(input.now)
  return prisma.integrationRun.findMany({
    where: {
      status: { in: ['succeeded', 'failed'] },
      cleanupSafeAt: { not: null },
      cleanupStatus: { in: ['safe', 'failed'] },
      ...unclaimedOrExpiredWhere(now),
    },
    orderBy: { updatedAt: 'asc' },
    take: checkedCandidateLimit(input.limit),
  })
}

export async function listIntegrationRunRecoveryCandidates(input: {
  now?: Date
  limit?: number
} = {}) {
  return prisma.integrationRun.findMany({
    where: recoveryCandidateWhere(currentTime(input.now)),
    orderBy: { updatedAt: 'asc' },
    take: checkedCandidateLimit(input.limit),
  })
}

export async function claimIntegrationRunForRecovery(input: ClaimRequest) {
  const now = currentTime(input.now)
  const expiresAt = claimExpiry(now, input.leaseMs)
  requireNonEmpty('owner', input.owner)
  const claimed = await prisma.integrationRun.updateMany({
    where: {
      id: input.runId,
      ...recoveryCandidateWhere(now),
    },
    data: {
      claimOwner: input.owner,
      claimEpoch: { increment: 1 },
      claimExpiresAt: expiresAt,
    },
  })
  if (claimed.count !== 1) return null
  return prisma.integrationRun.findUniqueOrThrow({ where: { id: input.runId } })
}

export async function renewIntegrationRunClaim(input: ClaimRequest & { epoch: number }) {
  const now = currentTime(input.now)
  const expiresAt = claimExpiry(now, input.leaseMs)
  const renewed = await prisma.integrationRun.updateMany({
    where: {
      id: input.runId,
      claimOwner: input.owner,
      claimEpoch: input.epoch,
      claimExpiresAt: { gt: now },
    },
    data: { claimExpiresAt: expiresAt },
  })
  if (renewed.count !== 1) {
    throw new IntegrationStoreError('CLAIM_STALE', `运行租约已变化或过期：${input.runId}`)
  }
  return prisma.integrationRun.findUniqueOrThrow({ where: { id: input.runId } })
}

export async function releaseIntegrationRunClaim(input: FencedRunInput) {
  const now = currentTime(input.now)
  const released = await prisma.integrationRun.updateMany({
    where: {
      id: input.runId,
      claimOwner: input.owner,
      claimEpoch: input.epoch,
      claimExpiresAt: { gt: now },
    },
    data: {
      claimOwner: null,
      claimExpiresAt: null,
    },
  })
  if (released.count !== 1) {
    throw new IntegrationStoreError('CLAIM_STALE', `运行租约已变化或过期：${input.runId}`)
  }
  return prisma.integrationRun.findUniqueOrThrow({ where: { id: input.runId } })
}

export async function lockIntegrationRunSnapshot(input: FencedRunInput & {
  baseSha: string
  headSha: string
  targetTipSha: string
  diffHash: string
}) {
  const snapshot = {
    baseSha: requireNonEmpty('baseSha', input.baseSha),
    headSha: requireNonEmpty('headSha', input.headSha),
    targetTipSha: requireNonEmpty('targetTipSha', input.targetTipSha),
    diffHash: requireNonEmpty('diffHash', input.diffHash),
  }
  return prisma.$transaction(async (tx) => {
    const run = await fenceRunClaim(tx, input)
    const empty = run.baseSha === null
      && run.headSha === null
      && run.targetTipSha === null
      && run.diffHash === null
    const same = run.baseSha === snapshot.baseSha
      && run.headSha === snapshot.headSha
      && run.targetTipSha === snapshot.targetTipSha
      && run.diffHash === snapshot.diffHash
    if (same) return run
    if (!empty) {
      throw new IntegrationStoreError('SNAPSHOT_LOCKED', `Git 快照已锁定：${input.runId}`)
    }
    return tx.integrationRun.update({
      where: { id: input.runId },
      data: snapshot,
    })
  })
}

export async function tryReuseIntegrationFinalReview(input: FencedRunInput & {
  artifactId: string
  headSha: string
  diffHash: string
}): Promise<boolean> {
  const artifactId = requireNonEmpty('artifactId', input.artifactId)
  const headSha = requireNonEmpty('headSha', input.headSha)
  const diffHash = requireNonEmpty('diffHash', input.diffHash)
  const now = currentTime(input.now)

  return prisma.$transaction(async (tx) => {
    const run = await fenceRunClaim(tx, input)
    if (
      run.stage !== 'pre_merge_review'
      || run.status !== 'running'
      || run.headSha !== headSha
      || run.diffHash !== diffHash
    ) {
      return false
    }

    const target = await tx.integrationArtifact.findUnique({
      where: { id: artifactId },
    })
    if (
      !target
      || target.runId !== run.id
      || target.type !== 'final_review'
      || target.status !== 'queued'
    ) {
      return false
    }

    const sourceRun = await tx.integrationRun.findFirst({
      where: {
        taskId: run.taskId,
        stage: 'submit_review_and_tests',
        status: 'succeeded',
        cleanupStatus: 'completed',
        headSha,
        diffHash,
        artifacts: {
          some: {
            type: 'initial_review',
            status: 'succeeded',
            content: { not: null },
          },
        },
      },
      orderBy: { sequence: 'desc' },
      include: {
        artifacts: {
          where: {
            type: 'initial_review',
            status: 'succeeded',
          },
          take: 1,
        },
      },
    })
    const source = sourceRun?.artifacts[0]
    if (!source?.content?.trim()) return false

    const updated = await tx.integrationArtifact.updateMany({
      where: {
        id: artifactId,
        runId: run.id,
        type: 'final_review',
        status: 'queued',
      },
      data: {
        status: 'succeeded',
        skillDigest: source.skillDigest,
        content: source.content,
        conclusion: source.conclusion,
        errorCode: null,
        error: null,
        startedAt: now,
        finishedAt: now,
      },
    })
    return updated.count === 1
  })
}

/**
 * Persist the encrypted worktree capability before Git or the filesystem is
 * mutated. This closes the crash window where an orphaned lock/worktree could
 * exist without a recoverable lease in the database.
 */
export async function prepareIntegrationRunWorktree(input: FencedRunInput & {
  worktreeLeaseCipher: string
}) {
  const worktreeLeaseCipher = requireNonEmpty(
    'worktreeLeaseCipher',
    input.worktreeLeaseCipher,
  )
  return prisma.$transaction(async (tx) => {
    const run = await fenceRunClaim(tx, input)
    if (
      run.worktreeStatus === 'preparing' &&
      run.worktreeLeaseCipher === worktreeLeaseCipher &&
      run.worktreePath === null
    ) return run
    if (run.worktreeStatus !== 'none') {
      throw new IntegrationStoreError(
        'WORKTREE_STATE_CONFLICT',
        `worktree 状态不能从 ${run.worktreeStatus} 更新为 preparing`,
      )
    }
    if (
      run.baseSha === null ||
      run.headSha === null ||
      run.targetTipSha === null ||
      run.diffHash === null
    ) {
      throw new IntegrationStoreError(
        'SNAPSHOT_NOT_LOCKED',
        `Git 快照尚未锁定：${input.runId}`,
      )
    }
    return tx.integrationRun.update({
      where: { id: input.runId },
      data: {
        worktreeStatus: 'preparing',
        worktreePath: null,
        worktreeLeaseCipher,
        cleanupStatus: 'pending',
        cleanupErrorCode: null,
        cleanupError: null,
      },
    })
  })
}

export async function markIntegrationRunWorktreeActive(input: FencedRunInput & {
  worktreePath: string
  worktreeLeaseCipher: string
}) {
  const worktreePath = requireNonEmpty('worktreePath', input.worktreePath)
  const worktreeLeaseCipher = requireNonEmpty(
    'worktreeLeaseCipher',
    input.worktreeLeaseCipher,
  )
  return prisma.$transaction(async (tx) => {
    const run = await fenceRunClaim(tx, input)
    if (
      run.worktreeStatus === 'active' &&
      run.worktreePath === worktreePath &&
      run.worktreeLeaseCipher === worktreeLeaseCipher
    ) return run
    if (run.worktreeStatus !== 'preparing') {
      throw new IntegrationStoreError(
        'WORKTREE_STATE_CONFLICT',
        `worktree 状态不能从 ${run.worktreeStatus} 更新为 active`,
      )
    }
    if (run.worktreeLeaseCipher !== worktreeLeaseCipher) {
      throw new IntegrationStoreError(
        'WORKTREE_LEASE_CONFLICT',
        `worktree lease 与准备阶段不一致：${input.runId}`,
      )
    }
    return tx.integrationRun.update({
      where: { id: input.runId },
      data: {
        worktreeStatus: 'active',
        worktreePath,
        worktreeLeaseCipher,
        cleanupStatus: 'pending',
        cleanupErrorCode: null,
        cleanupError: null,
      },
    })
  })
}

function assertArtifactRunning(status: string, artifactId: string): void {
  if (status !== 'running') {
    throw new IntegrationStoreError(
      'ARTIFACT_NOT_RUNNING',
      `产物 ${artifactId} 当前状态为 ${status}`,
    )
  }
}

function assertArtifactRunningOrFailed(status: string, artifactId: string): void {
  if (status !== 'running' && status !== 'failed') {
    throw new IntegrationStoreError(
      'ARTIFACT_NOT_RUNNING',
      `产物 ${artifactId} 当前状态为 ${status}`,
    )
  }
}

export async function markIntegrationArtifactRunning(input: FencedArtifactInput & {
  skillDigest: string
}) {
  const skillDigest = requireNonEmpty('skillDigest', input.skillDigest)
  const now = currentTime(input.now)
  return prisma.$transaction(async (tx) => {
    const { artifact } = await fenceArtifactClaim(tx, input)
    if (artifact.status === 'running' && artifact.skillDigest === skillDigest) return artifact
    if (artifact.status !== 'queued') {
      throw new IntegrationStoreError(
        'ARTIFACT_STATE_CONFLICT',
        `产物状态不能从 ${artifact.status} 更新为 running`,
      )
    }
    return tx.integrationArtifact.update({
      where: { id: input.artifactId },
      data: {
        status: 'running',
        skillDigest,
        startedAt: now,
        finishedAt: null,
        errorCode: null,
        error: null,
      },
    })
  })
}

export async function attachIntegrationArtifactSession(input: FencedArtifactInput & {
  opencodeSessionId: string
}) {
  const opencodeSessionId = requireNonEmpty('opencodeSessionId', input.opencodeSessionId)
  try {
    return await prisma.$transaction(async (tx) => {
      const { artifact } = await fenceArtifactClaim(tx, input)
      assertArtifactRunning(artifact.status, artifact.id)
      if (artifact.opencodeSessionId === opencodeSessionId) return artifact
      if (artifact.opencodeSessionId) {
        throw new IntegrationStoreError(
          'SESSION_ALREADY_ASSIGNED',
          `产物 ${artifact.id} 已绑定其他 OpenCode session`,
        )
      }
      const existingSession = await tx.integrationArtifact.findUnique({
        where: { opencodeSessionId },
        select: { id: true },
      })
      if (existingSession && existingSession.id !== artifact.id) {
        throw new IntegrationStoreError(
          'SESSION_ID_CONFLICT',
          `OpenCode session 已绑定其他产物：${opencodeSessionId}`,
        )
      }
      return tx.integrationArtifact.update({
        where: { id: artifact.id },
        data: { opencodeSessionId },
      })
    })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      throw new IntegrationStoreError(
        'SESSION_ID_CONFLICT',
        `OpenCode session 已绑定其他产物：${opencodeSessionId}`,
        { cause: error },
      )
    }
    throw error
  }
}

export async function markIntegrationArtifactPromptSubmitted(input: FencedArtifactInput) {
  const now = currentTime(input.now)
  return prisma.$transaction(async (tx) => {
    const { artifact } = await fenceArtifactClaim(tx, input)
    assertArtifactRunning(artifact.status, artifact.id)
    if (!artifact.opencodeSessionId) {
      throw new IntegrationStoreError('SESSION_REQUIRED', `产物 ${artifact.id} 尚未绑定 session`)
    }
    if (artifact.promptState === 'submitted') return artifact
    if (artifact.promptState !== 'not_submitted') {
      throw new IntegrationStoreError(
        'PROMPT_STATE_CONFLICT',
        `prompt 状态不能从 ${artifact.promptState} 更新为 submitted`,
      )
    }
    return tx.integrationArtifact.update({
      where: { id: artifact.id },
      data: { promptState: 'submitted', promptSubmittedAt: now },
    })
  })
}

export async function markIntegrationArtifactPromptAccepted(input: FencedArtifactInput) {
  const now = currentTime(input.now)
  return prisma.$transaction(async (tx) => {
    const { artifact } = await fenceArtifactClaim(tx, input)
    assertArtifactRunning(artifact.status, artifact.id)
    if (artifact.promptState === 'accepted') return artifact
    if (artifact.promptState !== 'submitted' && artifact.promptState !== 'acceptance_unknown') {
      throw new IntegrationStoreError(
        'PROMPT_STATE_CONFLICT',
        `prompt 状态不能从 ${artifact.promptState} 更新为 accepted`,
      )
    }
    return tx.integrationArtifact.update({
      where: { id: artifact.id },
      data: { promptState: 'accepted', promptAcceptedAt: now },
    })
  })
}

export async function markIntegrationArtifactPromptAcceptanceUnknown(input: FencedArtifactInput) {
  const now = currentTime(input.now)
  return prisma.$transaction(async (tx) => {
    const { artifact } = await fenceArtifactClaim(tx, input)
    assertArtifactRunningOrFailed(artifact.status, artifact.id)
    if (artifact.promptState === 'acceptance_unknown') return artifact
    if (artifact.promptState !== 'submitted') {
      throw new IntegrationStoreError(
        'PROMPT_STATE_CONFLICT',
        `prompt 状态不能从 ${artifact.promptState} 更新为 acceptance_unknown`,
      )
    }
    return tx.integrationArtifact.update({
      where: { id: artifact.id },
      data: {
        promptState: 'acceptance_unknown',
        promptAcceptanceUnknownAt: now,
      },
    })
  })
}

export async function markIntegrationArtifactPromptRejected(input: FencedArtifactInput) {
  const now = currentTime(input.now)
  return prisma.$transaction(async (tx) => {
    const { artifact } = await fenceArtifactClaim(tx, input)
    assertArtifactRunning(artifact.status, artifact.id)
    if (artifact.promptState === 'rejected') return artifact
    if (artifact.promptState !== 'submitted') {
      throw new IntegrationStoreError(
        'PROMPT_STATE_CONFLICT',
        `prompt 状态不能从 ${artifact.promptState} 更新为 rejected`,
      )
    }
    return tx.integrationArtifact.update({
      where: { id: artifact.id },
      data: {
        promptState: 'rejected',
        promptRejectedAt: now,
      },
    })
  })
}

export async function markIntegrationArtifactAbortRequested(input: FencedArtifactInput) {
  const now = currentTime(input.now)
  return prisma.$transaction(async (tx) => {
    const { artifact } = await fenceArtifactClaim(tx, input)
    assertArtifactRunningOrFailed(artifact.status, artifact.id)
    if (artifact.abortRequestedAt) return artifact
    return tx.integrationArtifact.update({
      where: { id: artifact.id },
      data: { abortRequestedAt: now },
    })
  })
}

export async function recordIntegrationArtifactAbortResponse(input: FencedArtifactInput & {
  abortAccepted: boolean
}) {
  const now = currentTime(input.now)
  return prisma.$transaction(async (tx) => {
    const { artifact } = await fenceArtifactClaim(tx, input)
    assertArtifactRunningOrFailed(artifact.status, artifact.id)
    if (!artifact.abortRequestedAt) {
      throw new IntegrationStoreError('ABORT_NOT_REQUESTED', `产物 ${artifact.id} 尚未请求 abort`)
    }
    if (artifact.abortRespondedAt) {
      if (artifact.abortAccepted === input.abortAccepted) return artifact
      if (artifact.abortAccepted === true) return artifact
      // `false` 只表示当次请求未被确认；恢复 worker 可以稍后重试并把
      // 最终确认提升为 true，但绝不允许 true 再回退为 false。
      return tx.integrationArtifact.update({
        where: { id: artifact.id },
        data: {
          abortRespondedAt: now,
          abortAccepted: true,
          abortErrorCode: null,
          abortError: null,
        },
      })
    }
    // A true HTTP abort response is deliberately not a terminal acknowledgement.
    return tx.integrationArtifact.update({
      where: { id: artifact.id },
      data: {
        abortRespondedAt: now,
        abortAccepted: input.abortAccepted,
        abortErrorCode: null,
        abortError: null,
      },
    })
  })
}

export async function recordIntegrationArtifactAbortFailure(
  input: FencedArtifactInput & {
    errorCode: string
    error: string
  },
) {
  const errorCode = requireNonEmpty('errorCode', input.errorCode)
  const errorMessage = requireNonEmpty('error', input.error)
  return prisma.$transaction(async (tx) => {
    const { artifact } = await fenceArtifactClaim(tx, input)
    assertArtifactRunningOrFailed(artifact.status, artifact.id)
    if (!artifact.abortRequestedAt) {
      throw new IntegrationStoreError(
        'ABORT_NOT_REQUESTED',
        `产物 ${artifact.id} 尚未请求 abort`,
      )
    }
    if (artifact.abortRespondedAt) return artifact
    return tx.integrationArtifact.update({
      where: { id: artifact.id },
      data: {
        abortErrorCode: errorCode,
        abortError: errorMessage,
      },
    })
  })
}

export async function acknowledgeIntegrationArtifactTerminal(input: FencedArtifactInput & {
  source: 'sse_session_idle' | 'sse_session_status_idle' | 'status_endpoint_idle'
}) {
  const now = currentTime(input.now)
  if (input.source !== 'sse_session_idle'
    && input.source !== 'sse_session_status_idle'
    && input.source !== 'status_endpoint_idle') {
    throw new IntegrationStoreError('TERMINAL_ACK_INVALID', `不可信的终态来源：${input.source}`)
  }
  return prisma.$transaction(async (tx) => {
    const { artifact } = await fenceArtifactClaim(tx, input)
    if (!artifact.opencodeSessionId) {
      throw new IntegrationStoreError('SESSION_REQUIRED', `产物 ${artifact.id} 尚未绑定 session`)
    }
    if (artifact.promptState !== 'accepted' && artifact.promptState !== 'acceptance_unknown') {
      throw new IntegrationStoreError(
        'TERMINAL_ACK_PROMPT_NOT_ACCEPTED',
        `产物 ${artifact.id} 的 prompt 状态 ${artifact.promptState} 不能确认终态`,
      )
    }
    if (artifact.terminalAckAt) {
      return artifact
    }
    return tx.integrationArtifact.update({
      where: { id: artifact.id },
      data: { terminalAckSource: input.source, terminalAckAt: now },
    })
  })
}

export async function finishIntegrationArtifactSuccess(input: FencedArtifactInput & {
  content: string
  conclusion?: string | null
}) {
  const now = currentTime(input.now)
  return prisma.$transaction(async (tx) => {
    const { artifact } = await fenceArtifactClaim(tx, input)
    if (artifact.status === 'succeeded') return artifact
    assertArtifactRunning(artifact.status, artifact.id)
    if (
      !artifact.opencodeSessionId ||
      (
        artifact.promptState !== 'accepted' &&
        artifact.promptState !== 'acceptance_unknown'
      ) ||
      !artifact.terminalAckAt
    ) {
      throw new IntegrationStoreError(
        'ARTIFACT_TERMINAL_ACK_REQUIRED',
        `产物 ${artifact.id} 只有在 OpenCode prompt 已接收且 session 终态确认后才能成功`,
      )
    }
    return tx.integrationArtifact.update({
      where: { id: artifact.id },
      data: {
        status: 'succeeded',
        content: input.content,
        conclusion: input.conclusion ?? null,
        errorCode: null,
        error: null,
        finishedAt: now,
      },
    })
  })
}

export async function finishIntegrationArtifactFailure(input: FencedArtifactInput & {
  errorCode: string
  error: string
}) {
  const errorCode = requireNonEmpty('errorCode', input.errorCode)
  const errorMessage = requireNonEmpty('error', input.error)
  const now = currentTime(input.now)
  return prisma.$transaction(async (tx) => {
    const { artifact } = await fenceArtifactClaim(tx, input)
    if (artifact.status === 'failed'
      && artifact.errorCode === errorCode
      && artifact.error === errorMessage) return artifact
    assertArtifactRunning(artifact.status, artifact.id)
    return tx.integrationArtifact.update({
      where: { id: artifact.id },
      data: {
        status: 'failed',
        errorCode,
        error: errorMessage,
        finishedAt: now,
      },
    })
  })
}

function assertArtifactTerminal(status: string, artifactId: string): void {
  if (status !== 'succeeded' && status !== 'failed') {
    throw new IntegrationStoreError(
      'ARTIFACT_NOT_TERMINAL',
      `产物 ${artifactId} 当前状态为 ${status}`,
    )
  }
}

export async function recordIntegrationArtifactSessionDeleted(
  input: FencedArtifactInput,
) {
  const now = currentTime(input.now)
  return prisma.$transaction(async (tx) => {
    const { artifact } = await fenceArtifactClaim(tx, input)
    assertArtifactTerminal(artifact.status, artifact.id)
    if (!artifact.opencodeSessionId) {
      throw new IntegrationStoreError(
        'SESSION_REQUIRED',
        `产物 ${artifact.id} 尚未绑定 session`,
      )
    }
    if (artifact.sessionDeletedAt) return artifact
    return tx.integrationArtifact.update({
      where: { id: artifact.id },
      data: {
        sessionDeletedAt: now,
        sessionDeleteErrorCode: null,
        sessionDeleteError: null,
      },
    })
  })
}

export async function recordIntegrationArtifactSessionDeleteFailure(
  input: FencedArtifactInput & {
    errorCode: string
    error: string
  },
) {
  const errorCode = requireNonEmpty('errorCode', input.errorCode)
  const errorMessage = requireNonEmpty('error', input.error)
  return prisma.$transaction(async (tx) => {
    const { artifact } = await fenceArtifactClaim(tx, input)
    assertArtifactTerminal(artifact.status, artifact.id)
    if (!artifact.opencodeSessionId) {
      throw new IntegrationStoreError(
        'SESSION_REQUIRED',
        `产物 ${artifact.id} 尚未绑定 session`,
      )
    }
    if (artifact.sessionDeletedAt) return artifact
    return tx.integrationArtifact.update({
      where: { id: artifact.id },
      data: {
        sessionDeleteErrorCode: errorCode,
        sessionDeleteError: errorMessage,
      },
    })
  })
}

export async function recordIntegrationRunOpencodeDisposed(input: FencedRunInput) {
  const now = currentTime(input.now)
  return prisma.$transaction(async (tx) => {
    const run = await fenceRunClaim(tx, input)
    if (run.status !== 'succeeded' && run.status !== 'failed') {
      throw new IntegrationStoreError(
        'RUN_NOT_TERMINAL',
        `运行 ${run.id} 当前状态为 ${run.status}`,
      )
    }
    if (run.opencodeDisposedAt) return run
    const undeletedSessions = await tx.integrationArtifact.count({
      where: {
        runId: run.id,
        opencodeSessionId: { not: null },
        sessionDeletedAt: null,
      },
    })
    if (undeletedSessions > 0) {
      throw new IntegrationStoreError(
        'OPENCODE_SESSIONS_NOT_DELETED',
        `运行 ${run.id} 仍有 ${undeletedSessions} 个 OpenCode session 未确认删除`,
      )
    }
    return tx.integrationRun.update({
      where: { id: run.id },
      data: {
        opencodeDisposedAt: now,
        opencodeDisposeErrorCode: null,
        opencodeDisposeError: null,
      },
    })
  })
}

export async function recordIntegrationRunOpencodeDisposeFailure(
  input: FencedRunInput & {
    errorCode: string
    error: string
  },
) {
  const errorCode = requireNonEmpty('errorCode', input.errorCode)
  const errorMessage = requireNonEmpty('error', input.error)
  return prisma.$transaction(async (tx) => {
    const run = await fenceRunClaim(tx, input)
    if (run.status !== 'succeeded' && run.status !== 'failed') {
      throw new IntegrationStoreError(
        'RUN_NOT_TERMINAL',
        `运行 ${run.id} 当前状态为 ${run.status}`,
      )
    }
    if (run.opencodeDisposedAt) return run
    return tx.integrationRun.update({
      where: { id: run.id },
      data: {
        opencodeDisposeErrorCode: errorCode,
        opencodeDisposeError: errorMessage,
      },
    })
  })
}

export async function finishIntegrationRunFromArtifacts(input: FencedRunInput) {
  const now = currentTime(input.now)
  return prisma.$transaction(async (tx) => {
    const run = await fenceRunClaim(tx, input)
    const artifacts = await tx.integrationArtifact.findMany({
      where: { runId: input.runId },
      orderBy: { createdAt: 'asc' },
    })
    if (!artifacts.length || artifacts.some(
      (artifact) => artifact.status !== 'succeeded' && artifact.status !== 'failed',
    )) {
      throw new IntegrationStoreError(
        'ARTIFACTS_NOT_TERMINAL',
        `运行 ${input.runId} 仍有未结束产物`,
      )
    }
    const failed = artifacts.find((artifact) => artifact.status === 'failed')
    const nextStatus: Extract<IntegrationRunStatus, 'succeeded' | 'failed'> = failed
      ? 'failed'
      : 'succeeded'
    if (run.status === 'succeeded' || run.status === 'failed') {
      if (run.status === nextStatus) return run
      throw new IntegrationStoreError('RUN_STATE_CONFLICT', `运行 ${input.runId} 的结果已锁定`)
    }
    if (run.status !== 'running') {
      throw new IntegrationStoreError(
        'RUN_STATE_CONFLICT',
        `运行状态不能从 ${run.status} 聚合为 ${nextStatus}`,
      )
    }
    const updated = await tx.integrationRun.update({
      where: { id: run.id },
      data: {
        status: nextStatus,
        errorCode: failed?.errorCode ?? null,
        error: failed?.error ?? null,
        finishedAt: now,
      },
    })
    await syncAutomationForRun(tx, updated)
    return updated
  })
}

export async function failIntegrationRunExecution(input: FencedRunInput & {
  errorCode: string
  error: string
}) {
  const errorCode = requireNonEmpty('errorCode', input.errorCode)
  const errorMessage = requireNonEmpty('error', input.error)
  const now = currentTime(input.now)
  return prisma.$transaction(async (tx) => {
    const run = await fenceRunClaim(tx, input)
    if (run.status === 'succeeded') {
      throw new IntegrationStoreError(
        'RUN_STATE_CONFLICT',
        `成功运行 ${run.id} 不能回退为 failed`,
      )
    }
    if (run.status === 'failed') return run

    await tx.integrationArtifact.updateMany({
      where: {
        runId: run.id,
        status: { in: ['queued', 'running'] },
      },
      data: {
        status: 'failed',
        errorCode,
        error: errorMessage,
        finishedAt: now,
      },
    })
    const hasWorktree = run.worktreeStatus !== 'none'
    const updated = await tx.integrationRun.update({
      where: { id: run.id },
      data: {
        status: 'failed',
        errorCode,
        error: errorMessage,
        finishedAt: now,
        cleanupStatus: hasWorktree ? 'pending' : 'completed',
        cleanupSafeAt: hasWorktree ? null : now,
        cleanupCompletedAt: hasWorktree ? null : now,
        cleanupErrorCode: null,
        cleanupError: null,
      },
    })
    await syncAutomationForRun(tx, updated)
    return updated
  })
}

export async function markIntegrationRunCleanupPending(input: FencedRunInput & {
  cleanupErrorCode?: string | null
  cleanupError?: string | null
}) {
  const cleanupErrorCode = input.cleanupErrorCode?.trim() || null
  const cleanupError = input.cleanupError?.trim() || null
  if ((cleanupErrorCode === null) !== (cleanupError === null)) {
    throw new IntegrationStoreError(
      'INVALID_INPUT',
      'cleanupErrorCode 与 cleanupError 必须同时提供或同时省略',
    )
  }
  return prisma.$transaction(async (tx) => {
    const run = await fenceRunClaim(tx, input)
    if (run.cleanupStatus === 'completed') return run
    if (run.cleanupStatus === 'safe' || run.cleanupStatus === 'cleaning') {
      throw new IntegrationStoreError(
        'CLEANUP_STATE_CONFLICT',
        `cleanup 状态不能从 ${run.cleanupStatus} 回退为 pending`,
      )
    }
    return tx.integrationRun.update({
      where: { id: run.id },
      data: {
        cleanupStatus: 'pending',
        cleanupErrorCode,
        cleanupError,
      },
    })
  })
}

export async function markIntegrationRunCleanupSafeIfTerminal(input: FencedRunInput): Promise<{
  safe: boolean
  run: Prisma.IntegrationRunGetPayload<Record<string, never>>
}> {
  const now = currentTime(input.now)
  return prisma.$transaction(async (tx) => {
    const run = await fenceRunClaim(tx, input)
    const artifacts = await tx.integrationArtifact.findMany({
      where: { runId: input.runId },
      select: {
        status: true,
        opencodeSessionId: true,
        promptState: true,
        terminalAckAt: true,
        sessionDeletedAt: true,
      },
    })
    const sessionsReleased = artifacts.every(
      (artifact) => !artifact.opencodeSessionId || artifact.sessionDeletedAt !== null,
    )
    const hadSessions = artifacts.some(
      (artifact) => artifact.opencodeSessionId !== null,
    )
    const safe = artifacts.length > 0 && artifacts.every((artifact) => {
      const terminal = artifact.status === 'succeeded' || artifact.status === 'failed'
      const sessionSafe = !artifact.opencodeSessionId ||
        artifact.promptState === 'not_submitted' ||
        artifact.promptState === 'rejected' ||
        (
          (artifact.promptState === 'accepted' ||
            artifact.promptState === 'acceptance_unknown') &&
          artifact.terminalAckAt !== null
        )
      return terminal && sessionSafe
    }) &&
      sessionsReleased &&
      (!hadSessions || run.opencodeDisposedAt !== null) &&
      (run.status === 'succeeded' || run.status === 'failed')
    if (!safe) return { safe: false, run }
    if (run.cleanupSafeAt && (
      run.cleanupStatus === 'safe'
      || run.cleanupStatus === 'cleaning'
      || run.cleanupStatus === 'completed'
    )) {
      return { safe: true, run }
    }
    const updated = await tx.integrationRun.update({
      where: { id: run.id },
      data: {
        cleanupStatus: 'safe',
        cleanupSafeAt: run.cleanupSafeAt ?? now,
        cleanupErrorCode: null,
        cleanupError: null,
      },
    })
    return { safe: true, run: updated }
  })
}

export async function beginIntegrationRunCleanup(input: FencedRunInput) {
  return prisma.$transaction(async (tx) => {
    const run = await fenceRunClaim(tx, input)
    if (run.cleanupStatus === 'cleaning') return run
    if (run.cleanupStatus !== 'safe' || !run.cleanupSafeAt) {
      throw new IntegrationStoreError(
        'CLEANUP_STATE_CONFLICT',
        `cleanup 状态不能从 ${run.cleanupStatus} 更新为 cleaning`,
      )
    }
    return tx.integrationRun.update({
      where: { id: run.id },
      data: {
        cleanupStatus: 'cleaning',
        cleanupErrorCode: null,
        cleanupError: null,
      },
    })
  })
}

export async function claimIntegrationRunCleanup(input: ClaimRequest) {
  const now = currentTime(input.now)
  const expiresAt = claimExpiry(now, input.leaseMs)
  requireNonEmpty('owner', input.owner)
  const claimed = await prisma.integrationRun.updateMany({
    where: {
      id: input.runId,
      status: { in: ['succeeded', 'failed'] },
      cleanupSafeAt: { not: null },
      cleanupStatus: { in: ['safe', 'failed'] },
      OR: [
        { claimOwner: null },
        { claimExpiresAt: null },
        { claimExpiresAt: { lte: now } },
      ],
    },
    data: {
      cleanupStatus: 'cleaning',
      cleanupErrorCode: null,
      cleanupError: null,
      claimOwner: input.owner,
      claimEpoch: { increment: 1 },
      claimExpiresAt: expiresAt,
    },
  })
  if (claimed.count !== 1) return null
  return prisma.integrationRun.findUniqueOrThrow({ where: { id: input.runId } })
}

export async function finishIntegrationRunCleanup(input: FencedRunInput) {
  const now = currentTime(input.now)
  const current = await prisma.integrationRun.findUnique({ where: { id: input.runId } })
  if (!current) {
    throw new IntegrationStoreError('RUN_NOT_FOUND', `集成运行不存在：${input.runId}`)
  }
  // Re-reading an already committed result is idempotent and performs no write.
  if (current.cleanupStatus === 'completed') return current

  return prisma.$transaction(async (tx) => {
    const run = await fenceRunClaim(tx, input)
    if (run.cleanupStatus !== 'cleaning') {
      throw new IntegrationStoreError(
        'CLEANUP_STATE_CONFLICT',
        `cleanup 状态不能从 ${run.cleanupStatus} 更新为 completed`,
      )
    }
    return tx.integrationRun.update({
      where: { id: run.id },
      data: {
        cleanupStatus: 'completed',
        cleanupCompletedAt: now,
        cleanupErrorCode: null,
        cleanupError: null,
        worktreeStatus: 'cleaned',
        worktreePath: null,
        worktreeLeaseCipher: null,
        claimOwner: null,
        claimExpiresAt: null,
      },
    })
  })
}

export async function failIntegrationRunCleanup(input: FencedRunInput & {
  cleanupErrorCode: string
  cleanupError: string
}) {
  const cleanupErrorCode = requireNonEmpty('cleanupErrorCode', input.cleanupErrorCode)
  const cleanupError = requireNonEmpty('cleanupError', input.cleanupError)
  return prisma.$transaction(async (tx) => {
    const run = await fenceRunClaim(tx, input)
    if (run.cleanupStatus !== 'cleaning') {
      throw new IntegrationStoreError(
        'CLEANUP_STATE_CONFLICT',
        `cleanup 状态不能从 ${run.cleanupStatus} 更新为 failed`,
      )
    }
    return tx.integrationRun.update({
      where: { id: run.id },
      data: {
        cleanupStatus: 'failed',
        cleanupErrorCode,
        cleanupError,
        claimOwner: null,
        claimExpiresAt: null,
      },
    })
  })
}
