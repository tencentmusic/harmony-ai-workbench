import {
  hasUnsafeMultilineControlCharacters,
  INTEGRATION_FEATURE_DESCRIPTION_MAX_LENGTH,
  INTEGRATION_REVIEW_NOTE_MAX_LENGTH,
  isAllowedIntegrationTransition,
  isValidGitBranchName,
  resolveRerunnableIntegrationStages,
  type IntegrationStage,
  type IntegrationTaskStatus,
} from './integration-domain'
import type { IntegrationProjectConfig } from './integration-projects'

export type IntegrationApiContractErrorCode =
  | 'INVALID_INPUT'
  | 'PROJECT_NOT_FOUND'
  | 'INVALID_BRANCH'
  | 'INVALID_STATUS'
  | 'INVALID_STATUS_TRANSITION'

export class IntegrationApiContractError extends Error {
  readonly code: IntegrationApiContractErrorCode
  readonly field?: string
  readonly httpStatus: number

  constructor(
    code: IntegrationApiContractErrorCode,
    message: string,
    field?: string,
    httpStatus = 400,
  ) {
    super(`${code}: ${message}`)
    this.name = 'IntegrationApiContractError'
    this.code = code
    this.field = field
    this.httpStatus = httpStatus
  }
}

export interface CreateIntegrationTaskInput {
  title: string
  projectId: string
  sourceBranch: string
  targetBranch: string
  scopePath?: string
  featureDesc: string | null
}

export interface IntegrationStatusUpdateInput {
  expectedStatus: IntegrationTaskStatus
  status: IntegrationTaskStatus
}

export interface IntegrationRetryInput {
  expectedRunId?: string
}

export interface IntegrationRerunInput {
  stage: IntegrationStage
  expectedRunId: string
}

export interface IntegrationReviewNoteInput {
  note: string | null
  expectedUpdatedAt: Date | null
}

type ApiDate = Date | string

export interface IntegrationCreatorDtoSource {
  personName: string
  personCode: string
  label: string | null
}

export interface IntegrationTaskEventDtoSource {
  id: string
  fromStatus: string | null
  toStatus: string
  createdAt: ApiDate
}

export interface IntegrationArtifactDtoSource {
  id: string
  type: string
  status: string
  content: string | null
  conclusion: string | null
  reviewNote: string | null
  reviewNoteUpdatedAt: ApiDate | null
  reviewNoteUpdatedBy: {
    personName: string
  } | null
  errorCode: string | null
  error: string | null
  opencodeSessionId: string | null
  sessionDeletedAt: ApiDate | null
  startedAt: ApiDate | null
  finishedAt: ApiDate | null
  createdAt: ApiDate
  updatedAt: ApiDate
}

export interface IntegrationRunDtoSource {
  id: string
  stage: string
  sequence: number
  status: string
  baseSha: string | null
  headSha: string | null
  targetTipSha: string | null
  diffHash: string | null
  cleanupStatus: string
  cleanupCompletedAt: ApiDate | null
  claimOwner: string | null
  claimExpiresAt: ApiDate | null
  worktreeStatus: string
  worktreePath: string | null
  worktreeLeaseCipher: string | null
  opencodeDisposedAt: ApiDate | null
  errorCode: string | null
  error: string | null
  startedAt: ApiDate | null
  finishedAt: ApiDate | null
  createdAt: ApiDate
  updatedAt: ApiDate
  artifacts: readonly IntegrationArtifactDtoSource[]
}

export interface IntegrationTaskDtoSource {
  id: string
  title: string
  projectId: string
  sourceBranch: string
  targetBranch: string
  scopePath: string | null
  featureDesc: string | null
  status: string
  automationStatus: string
  createdAt: ApiDate
  updatedAt: ApiDate
  creator: IntegrationCreatorDtoSource | null
  events: readonly IntegrationTaskEventDtoSource[]
  runs: readonly IntegrationRunDtoSource[]
}

export interface IntegrationArtifactSummaryDto {
  id: string
  type: string
  status: string
  conclusion: string | null
  errorCode: string | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface IntegrationArtifactDetailDto extends IntegrationArtifactSummaryDto {
  content: string | null
  reviewNote: string | null
  reviewNoteUpdatedAt: string | null
  reviewNoteUpdatedBy: string | null
}

export interface IntegrationRunSummaryDto {
  id: string
  stage: string
  sequence: number
  status: string
  baseSha: string | null
  headSha: string | null
  targetTipSha: string | null
  diffHash: string | null
  errorCode: string | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
  updatedAt: string
  artifacts: IntegrationArtifactSummaryDto[]
}

export interface IntegrationRunDetailDto extends Omit<IntegrationRunSummaryDto, 'artifacts'> {
  artifacts: IntegrationArtifactDetailDto[]
}

export interface IntegrationTaskSummaryDto {
  id: string
  title: string
  projectId: string
  sourceBranch: string
  targetBranch: string
  scopePath: string | null
  featureDesc: string | null
  status: string
  automationStatus: string
  canRetry: boolean
  retryBlockedReason: string | null
  rerunnableStages: IntegrationStage[]
  rerunBlockedReason: string | null
  canDelete: boolean
  deleteBlockedReason: string | null
  creator: IntegrationCreatorDtoSource | null
  createdAt: string
  updatedAt: string
  runs: IntegrationRunSummaryDto[]
}

export interface IntegrationTaskDetailDto
  extends Omit<IntegrationTaskSummaryDto, 'runs'> {
  events: Array<{
    id: string
    fromStatus: string | null
    toStatus: string
    createdAt: string
  }>
  runs: IntegrationRunDetailDto[]
}

export const INTEGRATION_TASK_STATUSES = [
  'developing',
  'submitted',
  'merge_pending',
  'merged',
  'closed',
] as const satisfies readonly IntegrationTaskStatus[]

const CREATE_INPUT_KEYS = new Set([
  'title',
  'projectId',
  'sourceBranch',
  'targetBranch',
  'featureDesc',
])
const STATUS_INPUT_KEYS = new Set(['expectedStatus', 'status'])
const RETRY_INPUT_KEYS = new Set(['expectedRunId'])
const RERUN_INPUT_KEYS = new Set(['stage', 'expectedRunId'])
const REVIEW_NOTE_INPUT_KEYS = new Set(['note', 'expectedUpdatedAt'])
const TITLE_MAX_LENGTH = 200
const SINGLE_LINE_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

function requireInputObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IntegrationApiContractError('INVALID_INPUT', '请求体必须是 JSON 对象', 'body')
  }
  return value as Record<string, unknown>
}

function rejectUnexpectedKeys(input: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const unexpected = Object.keys(input).filter((key) => !allowed.has(key))
  if (unexpected.length > 0) {
    throw new IntegrationApiContractError(
      'INVALID_INPUT',
      `请求体包含不支持的字段：${unexpected.join(', ')}`,
      'body',
    )
  }
}

function requireTrimmedString(
  input: Record<string, unknown>,
  field: string,
  maxLength: number,
): string {
  const value = input[field]
  if (typeof value !== 'string' || !value.trim()) {
    throw new IntegrationApiContractError('INVALID_INPUT', `${field} 必须为非空字符串`, field)
  }
  const normalized = value.trim()
  if (normalized.length > maxLength) {
    throw new IntegrationApiContractError(
      'INVALID_INPUT',
      `${field} 不能超过 ${maxLength} 个字符`,
      field,
    )
  }
  if (SINGLE_LINE_CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new IntegrationApiContractError('INVALID_INPUT', `${field} 不能包含控制字符`, field)
  }
  return normalized
}

function parseBranch(
  value: unknown,
  field: 'sourceBranch' | 'targetBranch',
): string {
  if (typeof value !== 'string') {
    throw new IntegrationApiContractError('INVALID_BRANCH', `${field} 必须是合法的分支名`, field)
  }
  const branch = value.trim()
  if (!isValidGitBranchName(branch)) {
    throw new IntegrationApiContractError('INVALID_BRANCH', `${field} 必须是合法的分支名`, field)
  }
  return branch
}

function parseIntegrationTaskStatus(
  value: unknown,
  field: 'expectedStatus' | 'status',
): IntegrationTaskStatus {
  if (
    typeof value !== 'string' ||
    !(INTEGRATION_TASK_STATUSES as readonly string[]).includes(value)
  ) {
    throw new IntegrationApiContractError(
      'INVALID_STATUS',
      `${field} 必须是合法的集成任务状态`,
      field,
    )
  }
  return value as IntegrationTaskStatus
}

export function parseCreateIntegrationTaskInput(
  value: unknown,
  projects: readonly IntegrationProjectConfig[],
): CreateIntegrationTaskInput {
  const input = requireInputObject(value)
  rejectUnexpectedKeys(input, CREATE_INPUT_KEYS)

  const title = requireTrimmedString(input, 'title', TITLE_MAX_LENGTH)
  const projectId = requireTrimmedString(input, 'projectId', 64)
  const project = projects.find((candidate) => candidate.id === projectId)
  if (!project) {
    throw new IntegrationApiContractError(
      'PROJECT_NOT_FOUND',
      `未配置集成项目：${projectId}`,
      'projectId',
      404,
    )
  }

  const sourceBranch = parseBranch(input.sourceBranch, 'sourceBranch')
  const targetBranch = parseBranch(
    input.targetBranch === undefined ? project.defaultTargetBranch : input.targetBranch,
    'targetBranch',
  )
  if (sourceBranch === targetBranch) {
    throw new IntegrationApiContractError(
      'INVALID_BRANCH',
      '开发分支不能与目标分支相同',
      'targetBranch',
    )
  }

  let featureDesc: string | null = null
  if (input.featureDesc !== undefined && input.featureDesc !== null) {
    if (typeof input.featureDesc !== 'string') {
      throw new IntegrationApiContractError(
        'INVALID_INPUT',
        'featureDesc 必须是字符串',
        'featureDesc',
      )
    }
    featureDesc = input.featureDesc.trim() || null
    if (
      featureDesc
      && featureDesc.length > INTEGRATION_FEATURE_DESCRIPTION_MAX_LENGTH
    ) {
      throw new IntegrationApiContractError(
        'INVALID_INPUT',
        `featureDesc 不能超过 ${INTEGRATION_FEATURE_DESCRIPTION_MAX_LENGTH} 个字符`,
        'featureDesc',
      )
    }
    if (featureDesc && hasUnsafeMultilineControlCharacters(featureDesc)) {
      throw new IntegrationApiContractError(
        'INVALID_INPUT',
        'featureDesc 不能包含控制字符',
        'featureDesc',
      )
    }
  }

  return {
    title,
    projectId: project.id,
    sourceBranch,
    targetBranch,
    scopePath: project.scopePath,
    featureDesc,
  }
}

export function parseIntegrationStatusUpdateInput(
  value: unknown,
): IntegrationStatusUpdateInput {
  const input = requireInputObject(value)
  rejectUnexpectedKeys(input, STATUS_INPUT_KEYS)

  const expectedStatus = parseIntegrationTaskStatus(input.expectedStatus, 'expectedStatus')
  const status = parseIntegrationTaskStatus(input.status, 'status')
  if (!isAllowedIntegrationTransition(expectedStatus, status)) {
    throw new IntegrationApiContractError(
      'INVALID_STATUS_TRANSITION',
      `非法的集成任务状态跳转：${expectedStatus} -> ${status}`,
      'status',
    )
  }

  return { expectedStatus, status }
}

export function parseIntegrationRetryInput(value: unknown): IntegrationRetryInput {
  const input = requireInputObject(value)
  rejectUnexpectedKeys(input, RETRY_INPUT_KEYS)
  if (input.expectedRunId === undefined) return {}
  if (
    typeof input.expectedRunId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.expectedRunId)
  ) {
    throw new IntegrationApiContractError(
      'INVALID_INPUT',
      'expectedRunId 必须是合法的运行 ID',
      'expectedRunId',
    )
  }
  return { expectedRunId: input.expectedRunId }
}

export function parseIntegrationRerunInput(value: unknown): IntegrationRerunInput {
  const input = requireInputObject(value)
  rejectUnexpectedKeys(input, RERUN_INPUT_KEYS)
  if (
    input.stage !== 'submit_review_and_tests'
    && input.stage !== 'pre_merge_review'
  ) {
    throw new IntegrationApiContractError(
      'INVALID_INPUT',
      'stage 必须是合法的自动化阶段',
      'stage',
    )
  }
  if (
    typeof input.expectedRunId !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/.test(input.expectedRunId)
  ) {
    throw new IntegrationApiContractError(
      'INVALID_INPUT',
      'expectedRunId 必须是合法的运行 ID',
      'expectedRunId',
    )
  }
  return {
    stage: input.stage,
    expectedRunId: input.expectedRunId,
  }
}

export function parseIntegrationReviewNoteInput(
  value: unknown,
): IntegrationReviewNoteInput {
  const input = requireInputObject(value)
  rejectUnexpectedKeys(input, REVIEW_NOTE_INPUT_KEYS)
  if (typeof input.note !== 'string') {
    throw new IntegrationApiContractError(
      'INVALID_INPUT',
      'note 必须是字符串',
      'note',
    )
  }
  const note = input.note.trim() || null
  if (note && note.length > INTEGRATION_REVIEW_NOTE_MAX_LENGTH) {
    throw new IntegrationApiContractError(
      'INVALID_INPUT',
      `note 不能超过 ${INTEGRATION_REVIEW_NOTE_MAX_LENGTH} 个字符`,
      'note',
    )
  }
  if (note && hasUnsafeMultilineControlCharacters(note)) {
    throw new IntegrationApiContractError(
      'INVALID_INPUT',
      'note 不能包含控制字符',
      'note',
    )
  }
  if (input.expectedUpdatedAt === null) {
    return { note, expectedUpdatedAt: null }
  }
  if (typeof input.expectedUpdatedAt !== 'string') {
    throw new IntegrationApiContractError(
      'INVALID_INPUT',
      'expectedUpdatedAt 必须是 ISO 时间或 null',
      'expectedUpdatedAt',
    )
  }
  const expectedUpdatedAt = new Date(input.expectedUpdatedAt)
  if (
    !Number.isFinite(expectedUpdatedAt.getTime())
    || expectedUpdatedAt.toISOString() !== input.expectedUpdatedAt
  ) {
    throw new IntegrationApiContractError(
      'INVALID_INPUT',
      'expectedUpdatedAt 必须是标准 ISO 时间',
      'expectedUpdatedAt',
    )
  }
  return { note, expectedUpdatedAt }
}

function toIsoTimestamp(value: ApiDate): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toNullableIsoTimestamp(value: ApiDate | null): string | null {
  return value === null ? null : toIsoTimestamp(value)
}

const PUBLIC_INTEGRATION_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  ABORT_FAILED: 'OpenCode 任务停止失败，系统将继续安全清理。',
  CANCELLED: 'OpenCode 审查已取消。',
  FORBIDDEN_TOOL: '自动化审查触发了不允许的工具，已安全终止。',
  FROZEN_DIFF_MISMATCH: '审查快照校验失败，请重试。',
  GIT_COMMAND_TIMEOUT: 'Git 操作超时，请稍后重试。',
  GIT_DIFF_FAILED: '读取分支改动失败，请稍后重试。',
  GIT_DIFF_TOO_LARGE: '分支改动超过自动审查大小上限，请拆分后重试。',
  GIT_DIFF_TOO_MANY_FILES: '分支改动文件数超过自动审查上限，请拆分后重试。',
  GIT_FETCH_FAILED: '拉取远端分支失败，请检查分支后重试。',
  MERGE_BASE_NOT_FOUND: '无法计算分支共同基线，请检查目标分支。',
  OPENCODE_CLIENT_CREATE_FAILED: 'OpenCode 服务暂不可用，请稍后重试。',
  OPENCODE_CONNECTION_LOST: 'OpenCode 服务连接中断，请稍后重试。',
  OPENCODE_CONFIG_UNSAFE: 'OpenCode 安全配置校验失败，请联系集成人员。',
  ORIGIN_REF_NOT_FOUND: '远端分支不存在或无法访问，请检查分支名。',
  PROJECT_CONFIG_INVALID: '项目配置不可用，请联系集成人员。',
  PROJECT_NOT_CONFIGURED: '项目尚未配置，请联系集成人员。',
  PROMPT_ACCEPTANCE_UNKNOWN: '无法确认 OpenCode 是否已接收任务，系统将继续恢复。',
  PROMPT_REJECTED: 'OpenCode 未接收审查任务，请稍后重试。',
  REPORT_INVALID: '自动化报告格式校验失败，请重试。',
  REPORT_MISSING: '自动化报告未生成，请重试。',
  SESSION_CREATE_FAILED: 'OpenCode 会话创建失败，请稍后重试。',
  SSE_CONNECT_FAILED: 'OpenCode 实时连接失败，请稍后重试。',
  SSE_DISCONNECTED: 'OpenCode 实时连接中断，请稍后重试。',
  TERMINAL_ACK_TIMEOUT: 'OpenCode 结束状态确认超时，系统将继续安全清理。',
  TIMEOUT: 'OpenCode 审查执行超时，请重试。',
  WORKTREE_CLEANUP_FAILED: '隔离资源清理失败，系统将继续重试清理。',
  WORKTREE_CREATE_FAILED: '创建隔离审查环境失败，请稍后重试。',
}

function publicIntegrationErrorCode(errorCode: string | null): string | null {
  if (!errorCode) return null
  return /^[A-Z0-9_]{1,64}$/.test(errorCode) ? errorCode : 'INTERNAL_ERROR'
}

function publicIntegrationErrorMessage(errorCode: string | null): string | null {
  if (!errorCode) return null
  const exact = PUBLIC_INTEGRATION_ERROR_MESSAGES[errorCode]
  if (exact) return exact
  if (errorCode.startsWith('SKILL_')) {
    return '审查 Skill 加载或校验失败，请联系集成人员。'
  }
  if (errorCode.startsWith('RECOVERY_')) {
    return '中断恢复尚未完成，系统将继续自动恢复。'
  }
  if (
    errorCode.startsWith('SESSION_DELETE_')
    || errorCode.startsWith('INSTANCE_DISPOSE_')
    || errorCode.startsWith('OPENCODE_RESOURCE_CLEANUP_')
  ) {
    return 'OpenCode 隔离资源清理尚未完成，系统将继续重试。'
  }
  if (errorCode.startsWith('WORKTREE_')) {
    return '隔离审查环境处理失败，请稍后重试。'
  }
  return '自动化执行失败，请联系集成人员查看服务端日志。'
}

function retryAvailability(task: IntegrationTaskDtoSource): {
  canRetry: boolean
  retryBlockedReason: string | null
} {
  const latestRun = task.runs.reduce<IntegrationRunDtoSource | undefined>(
    (latest, run) => !latest || run.sequence > latest.sequence ? run : latest,
    undefined,
  )
  if (!latestRun || latestRun.status !== 'failed') {
    return { canRetry: false, retryBlockedReason: null }
  }
  if (latestRun.cleanupStatus === 'completed') {
    return { canRetry: true, retryBlockedReason: null }
  }
  return {
    canRetry: false,
    retryBlockedReason: '隔离资源正在清理，完成后可重试。',
  }
}

function rerunAvailability(task: IntegrationTaskDtoSource): {
  rerunnableStages: IntegrationStage[]
  rerunBlockedReason: string | null
} {
  const allowedStages = resolveRerunnableIntegrationStages(
    task.status as IntegrationTaskStatus,
  )
  if (allowedStages.length === 0) {
    return { rerunnableStages: [], rerunBlockedReason: null }
  }

  const activeRun = task.runs.find(
    (run) => run.status === 'queued' || run.status === 'running',
  )
  if (activeRun) {
    return {
      rerunnableStages: [],
      rerunBlockedReason: '自动化正在执行，完成并清理后可重新运行。',
    }
  }

  const rerunnableStages = allowedStages.filter((stage) => {
    const stageRuns = task.runs.filter((run) => run.stage === stage)
    const anchor = stageRuns.reduce<IntegrationRunDtoSource | undefined>(
      (latest, run) => !latest || run.sequence > latest.sequence ? run : latest,
      undefined,
    )
    if (
      !anchor
      || (anchor.status !== 'succeeded' && anchor.status !== 'failed')
      || anchor.cleanupStatus !== 'completed'
    ) return false
    return !task.runs.some(
      (run) => run.sequence > anchor.sequence && run.cleanupStatus !== 'completed',
    )
  })
  if (rerunnableStages.length > 0) {
    return { rerunnableStages: [...rerunnableStages], rerunBlockedReason: null }
  }

  const hasPriorStageRun = task.runs.some((run) => allowedStages.includes(
    run.stage as IntegrationStage,
  ))
  const hasUncleanRun = task.runs.some((run) => run.cleanupStatus !== 'completed')
  return {
    rerunnableStages: [],
    rerunBlockedReason: hasPriorStageRun && hasUncleanRun
      ? '隔离资源正在清理，完成后可重新运行。'
      : null,
  }
}

function runAllowsTaskDeletion(run: IntegrationRunDtoSource): boolean {
  const hasOpenCodeSession = run.artifacts.some(
    (artifact) => artifact.opencodeSessionId !== null,
  )
  const claimExpiresAtMs = run.claimExpiresAt === null
    ? null
    : new Date(run.claimExpiresAt).getTime()
  const hasActiveOrUnboundedClaim = run.claimOwner !== null && (
    claimExpiresAtMs === null
    || !Number.isFinite(claimExpiresAtMs)
    || claimExpiresAtMs > Date.now()
  )
  return (
    (run.status === 'succeeded' || run.status === 'failed')
    && run.cleanupStatus === 'completed'
    && run.cleanupCompletedAt !== null
    && !hasActiveOrUnboundedClaim
    && (run.worktreeStatus === 'none' || run.worktreeStatus === 'cleaned')
    && run.worktreePath === null
    && run.worktreeLeaseCipher === null
    && run.artifacts.every(
      (artifact) => artifact.status === 'succeeded' || artifact.status === 'failed',
    )
    && run.artifacts.every(
      (artifact) => artifact.opencodeSessionId === null || artifact.sessionDeletedAt !== null,
    )
    && (!hasOpenCodeSession || run.opencodeDisposedAt !== null)
  )
}

function deleteAvailability(task: IntegrationTaskDtoSource): {
  canDelete: boolean
  deleteBlockedReason: string | null
} {
  if (task.runs.every(runAllowsTaskDeletion)) {
    return { canDelete: true, deleteBlockedReason: null }
  }
  return {
    canDelete: false,
    deleteBlockedReason: '自动化执行或隔离资源清理完成后可删除。',
  }
}

function toIntegrationArtifactSummaryDto(
  artifact: IntegrationArtifactDtoSource,
): IntegrationArtifactSummaryDto {
  const errorCode = publicIntegrationErrorCode(artifact.errorCode)
  return {
    id: artifact.id,
    type: artifact.type,
    status: artifact.status,
    conclusion: artifact.conclusion,
    errorCode,
    error: publicIntegrationErrorMessage(errorCode),
    startedAt: toNullableIsoTimestamp(artifact.startedAt),
    finishedAt: toNullableIsoTimestamp(artifact.finishedAt),
    createdAt: toIsoTimestamp(artifact.createdAt),
    updatedAt: toIsoTimestamp(artifact.updatedAt),
  }
}

function toIntegrationRunSummaryDto(run: IntegrationRunDtoSource): IntegrationRunSummaryDto {
  const errorCode = publicIntegrationErrorCode(run.errorCode)
  return {
    id: run.id,
    stage: run.stage,
    sequence: run.sequence,
    status: run.status,
    baseSha: run.baseSha,
    headSha: run.headSha,
    targetTipSha: run.targetTipSha,
    diffHash: run.diffHash,
    errorCode,
    error: publicIntegrationErrorMessage(errorCode),
    startedAt: toNullableIsoTimestamp(run.startedAt),
    finishedAt: toNullableIsoTimestamp(run.finishedAt),
    createdAt: toIsoTimestamp(run.createdAt),
    updatedAt: toIsoTimestamp(run.updatedAt),
    artifacts: run.artifacts.map(toIntegrationArtifactSummaryDto),
  }
}

export function toIntegrationTaskSummaryDto(
  task: IntegrationTaskDtoSource,
): IntegrationTaskSummaryDto {
  const retry = retryAvailability(task)
  const rerun = rerunAvailability(task)
  const deletion = deleteAvailability(task)
  return {
    id: task.id,
    title: task.title,
    projectId: task.projectId,
    sourceBranch: task.sourceBranch,
    targetBranch: task.targetBranch,
    scopePath: task.scopePath,
    featureDesc: task.featureDesc,
    status: task.status,
    automationStatus: task.automationStatus,
    canRetry: retry.canRetry,
    retryBlockedReason: retry.retryBlockedReason,
    rerunnableStages: rerun.rerunnableStages,
    rerunBlockedReason: rerun.rerunBlockedReason,
    canDelete: deletion.canDelete,
    deleteBlockedReason: deletion.deleteBlockedReason,
    creator: task.creator === null
      ? null
      : {
        personName: task.creator.personName,
        personCode: task.creator.personCode,
        label: task.creator.label,
      },
    createdAt: toIsoTimestamp(task.createdAt),
    updatedAt: toIsoTimestamp(task.updatedAt),
    runs: task.runs.map(toIntegrationRunSummaryDto),
  }
}

export function toIntegrationTaskListDto(
  tasks: readonly IntegrationTaskDtoSource[],
): IntegrationTaskSummaryDto[] {
  return tasks.map(toIntegrationTaskSummaryDto)
}

export function toIntegrationTaskDetailDto(
  task: IntegrationTaskDtoSource,
): IntegrationTaskDetailDto {
  const summary = toIntegrationTaskSummaryDto(task)
  return {
    ...summary,
    events: task.events.map((event) => ({
      id: event.id,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      createdAt: toIsoTimestamp(event.createdAt),
    })),
    runs: task.runs.map((run) => ({
      ...toIntegrationRunSummaryDto(run),
      artifacts: run.artifacts.map((artifact) => ({
        ...toIntegrationArtifactSummaryDto(artifact),
        content: artifact.content,
        reviewNote: artifact.reviewNote,
        reviewNoteUpdatedAt: toNullableIsoTimestamp(artifact.reviewNoteUpdatedAt),
        reviewNoteUpdatedBy: artifact.reviewNoteUpdatedBy?.personName ?? null,
      })),
    })),
  }
}
