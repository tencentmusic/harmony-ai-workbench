import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { isValidGitBranchName } from './integration-domain'
import { normalizeIntegrationScopePath } from './integration-projects'

export type IntegrationGitErrorCode =
  | 'INVALID_REPO_ROOT'
  | 'INVALID_RUNTIME_ROOT'
  | 'INVALID_BRANCH'
  | 'INVALID_SCOPE_PATH'
  | 'INVALID_RUN_ID'
  | 'INVALID_COMMIT_SHA'
  | 'INVALID_GIT_CONFIG'
  | 'ORIGIN_REF_NOT_FOUND'
  | 'GIT_FETCH_FAILED'
  | 'MERGE_BASE_NOT_FOUND'
  | 'MERGE_CONFLICT_CHECK_FAILED'
  | 'GIT_DIFF_FAILED'
  | 'GIT_DIFF_TOO_LARGE'
  | 'GIT_DIFF_TOO_MANY_FILES'
  | 'FROZEN_DIFF_MISMATCH'
  | 'WORKTREE_PATH_UNSAFE'
  | 'REPO_RUNTIME_OVERLAP'
  | 'WORKTREE_BUSY'
  | 'WORKTREE_PATH_EXISTS'
  | 'WORKTREE_CREATE_FAILED'
  | 'WORKTREE_CLEANUP_FAILED'

export class IntegrationGitError extends Error {
  readonly name = 'IntegrationGitError'
  readonly code: IntegrationGitErrorCode

  constructor(
    code: IntegrationGitErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.code = code
  }
}

class IntegrationCreateRecoveryRequiredError extends IntegrationGitError {}

export interface FreezeIntegrationGitSnapshotInput {
  repoRoot: string
  runtimeRoot?: string
  sourceBranch: string
  targetBranch: string
  scopePath?: string
}

export interface IntegrationGitSnapshot {
  sourceRef: string
  targetRef: string
  targetTipSha: string
  baseSha: string
  headSha: string
  diffHash: string
}

export const INTEGRATION_IMAGE_MAX_BYTES = 10 * 1024
export interface IntegrationImageSize {
  path: string
  byteLength: number
  blobId: string
}

/** Inspect committed regular files, never mutable worktree files or symlink targets. */
export async function collectIntegrationImageSizes(input: {
  repoRoot: string
  baseSha: string
  headSha: string
  scopePath?: string
}): Promise<IntegrationImageSize[]> {
  const repoRoot = await resolveCanonicalGitRepoRoot(input.repoRoot)
  const baseSha = validateCommitSha(input.baseSha)
  const headSha = validateCommitSha(input.headSha)
  const scopePath = validateScopePath(input.scopePath)
  const args = ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--diff-filter=AMT', `${baseSha}...${headSha}`]
  if (scopePath) args.push('--', scopePath)
  const paths = (await executeGit(repoRoot, args)).toString('utf8').split('\0')
    .filter((name) => /\.(?:png|jpe?g|webp|gif|bmp|svg|ico|avif|heic|heif|tiff?|apng)$/i.test(name))
  if (paths.length === 0) return []
  const tree = await executeGit(repoRoot, [
    'ls-tree', '-r', '-l', '-z', '--full-name', headSha, '--',
    ...paths.map((name) => `:(literal)${name}`),
  ])
  const findings: IntegrationImageSize[] = []
  for (const entry of tree.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]+) +(\d+)\t([\s\S]+)$/.exec(entry)
    if (!match) continue
    const byteLength = Number(match[3])
    findings.push({ path: match[4], byteLength, blobId: match[2] })
  }
  return findings
}

export interface CheckIntegrationMergeConflictsInput {
  repoRoot: string
  targetTipSha: string
  headSha: string
}

export interface IntegrationMergeConflictCheckResult {
  hasConflicts: boolean
  /**
   * Display-safe path representations. Control, formatting, and common
   * Markdown/HTML delimiter characters are encoded as Unicode escapes and
   * must not be passed back to Git as filesystem paths.
   */
  conflictPaths: readonly string[]
  conflictPathCount: number
  conflictPathsTruncated: boolean
}

export interface RefreshIntegrationBranchTipsInput {
  repoRoot: string
  sourceBranch: string
  targetBranch: string
}

export interface IntegrationBranchTips {
  headSha: string
  targetTipSha: string
}

export interface MaterializeIntegrationFrozenDiffInput {
  repoRoot: string
  baseSha: string
  headSha: string
  scopePath?: string
  outputPath: string
  expectedDiffHash: string
}

export interface MaterializedIntegrationFrozenDiff {
  diffHash: string
  byteLength: number
}

export interface IntegrationWorktreeInput {
  repoRoot: string
  runtimeRoot?: string
  runId: string
  leaseToken?: string
}

export interface ValidateIntegrationWorktreeInput
  extends Omit<IntegrationWorktreeInput, 'leaseToken'> {
  leaseToken: string
}

export interface CreateIntegrationWorktreeInput
  extends Omit<IntegrationWorktreeInput, 'leaseToken'> {
  headSha: string
  /**
   * The controller may pre-generate and persist this capability before any
   * filesystem mutation. Callers that omit it retain the low-level helper's
   * backwards-compatible random generation, but production orchestration
   * always supplies one.
   */
  leaseToken?: string
}

interface IntegrationWorktreeLocations {
  runRoot: string
  repoPath: string
}

export interface IntegrationWorktreePaths extends IntegrationWorktreeLocations {
  leaseToken: string
}

interface GitCommandFailure extends Error {
  code?: string | number
  stdout?: string | Buffer
  stderr?: string | Buffer
}

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
const NON_DISPLAYABLE_GIT_PATH_CHARACTER_PATTERN = /[\p{C}\p{Zl}\p{Zp}]/u
const UNSAFE_GIT_PATH_MARKUP_CHARACTERS = new Set([
  '\\',
  '`',
  '<',
  '>',
  '&',
  '[',
  ']',
  '(',
  ')',
  '{',
  '}',
  '!',
  '*',
  '#',
  '|',
  '~',
])
const FATAL_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })
const MAX_REPORTED_MERGE_CONFLICT_PATHS = 200
const MAX_REPORTED_MERGE_CONFLICT_PATH_RAW_BYTES = 1_024
const MAX_REPORTED_MERGE_CONFLICT_TOTAL_BYTES = 64 * 1_024
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,63})$/
const COMMIT_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const DEFAULT_GIT_MAX_BUFFER_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_DIFF_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_CHANGED_FILES = 120
const MIN_GIT_MAX_BUFFER_BYTES = 1024
const MAX_GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024
const MAX_CONFIGURED_DIFF_BYTES = 16 * 1024 * 1024
const MAX_CONFIGURED_CHANGED_FILES = 500
const MAX_STREAMING_STDERR_BYTES = 64 * 1024
const MAX_RUN_LOCK_METADATA_BYTES = 4 * 1024
const MAX_MANIFEST_METADATA_BYTES = 64 * 1024
const MAX_GITDIR_METADATA_BYTES = 16 * 1024
const DEFAULT_GIT_TIMEOUT_MS = 30_000
const DEFAULT_GIT_FETCH_TIMEOUT_MS = 120_000
const MIN_GIT_TIMEOUT_MS = 100
const MAX_GIT_TIMEOUT_MS = 900_000

function readBoundedIntegerEnvironment(
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const rawValue = process.env[name]
  if (rawValue === undefined) return defaultValue
  if (!/^[0-9]+$/.test(rawValue)) {
    throw new IntegrationGitError(
      'INVALID_GIT_CONFIG',
      `${name} 必须是十进制整数`,
    )
  }

  const value = Number(rawValue)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new IntegrationGitError(
      'INVALID_GIT_CONFIG',
      `${name} 必须在 ${minimum}-${maximum} 范围内`,
    )
  }
  return value
}

function resolveGitTimeout(kind: 'local' | 'fetch'): number {
  return kind === 'fetch'
    ? readBoundedIntegerEnvironment(
      'HARMONY_INTEGRATION_GIT_FETCH_TIMEOUT_MS',
      DEFAULT_GIT_FETCH_TIMEOUT_MS,
      MIN_GIT_TIMEOUT_MS,
      MAX_GIT_TIMEOUT_MS,
    )
    : readBoundedIntegerEnvironment(
      'HARMONY_INTEGRATION_GIT_TIMEOUT_MS',
      DEFAULT_GIT_TIMEOUT_MS,
      MIN_GIT_TIMEOUT_MS,
      MAX_GIT_TIMEOUT_MS,
    )
}

function resolveGitMaxBufferBytes(): number {
  return readBoundedIntegerEnvironment(
    'HARMONY_INTEGRATION_GIT_MAX_BUFFER_BYTES',
    DEFAULT_GIT_MAX_BUFFER_BYTES,
    MIN_GIT_MAX_BUFFER_BYTES,
    MAX_GIT_MAX_BUFFER_BYTES,
  )
}

function resolveMaxDiffBytes(): number {
  return readBoundedIntegerEnvironment(
    'HARMONY_INTEGRATION_MAX_DIFF_BYTES',
    DEFAULT_MAX_DIFF_BYTES,
    1,
    MAX_CONFIGURED_DIFF_BYTES,
  )
}

function resolveMaxChangedFiles(): number {
  return readBoundedIntegerEnvironment(
    'HARMONY_INTEGRATION_MAX_CHANGED_FILES',
    DEFAULT_MAX_CHANGED_FILES,
    1,
    MAX_CONFIGURED_CHANGED_FILES,
  )
}

function validateGitExecutionConfig(): void {
  resolveGitTimeout('local')
  resolveGitTimeout('fetch')
  resolveGitMaxBufferBytes()
  resolveMaxDiffBytes()
  resolveMaxChangedFiles()
}

interface GitProcessInvocation {
  executable: string
  args: string[]
  independentProcessGroup: boolean
}

function safeGitConfigurationArgs(): string[] {
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'
  return [
    '-c',
    `core.hooksPath=${nullDevice}`,
    '-c',
    'core.fsmonitor=false',
  ]
}

function resolveGitProcessInvocation(
  repoRoot: string,
  args: readonly string[],
): GitProcessInvocation {
  const gitArgs = ['-C', repoRoot, ...safeGitConfigurationArgs(), ...args]
  if (process.platform === 'linux') {
    return {
      executable: 'setsid',
      args: ['git', ...gitArgs],
      independentProcessGroup: true,
    }
  }
  if (process.platform === 'win32') {
    return {
      executable: 'git',
      args: gitArgs,
      independentProcessGroup: false,
    }
  }
  return {
    executable: '/usr/bin/perl',
    args: [
      '-MPOSIX',
      '-e',
      'POSIX::setsid() >= 0 or die "setsid failed"; exec @ARGV or die "exec failed";',
      'git',
      ...gitArgs,
    ],
    independentProcessGroup: true,
  }
}

function integrationGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? 'production',
  }
  for (const name of [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'USERNAME',
    'SHELL',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'SSH_AUTH_SOCK',
    'SSH_AGENT_PID',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'GIT_SSL_CAINFO',
    'TZ',
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name]
  }
  // Contract tests use a private wrapper to simulate timeouts/races. These
  // variables are inert to real Git and deliberately cannot include app keys.
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('INTEGRATION_GIT_TEST_') && value !== undefined) {
      environment[name] = value
    }
  }
  return {
    ...environment,
    LC_ALL: 'C',
    LANG: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
  }
}

function terminateGitProcessOnce(
  child: ChildProcess,
  independentProcessGroup: boolean,
  errors: unknown[],
): void {
  if (child.pid === undefined) {
    try {
      child.kill('SIGKILL')
    } catch (error) {
      errors.push(error)
    }
    return
  }

  try {
    if (independentProcessGroup) {
      process.kill(-child.pid, 'SIGKILL')
    } else {
      child.kill('SIGKILL')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') errors.push(error)
  }
}

function createGitTimeoutFailure(
  timeoutMs: number,
  terminationErrors: unknown[],
  stdout?: Buffer,
  stderr?: Buffer,
): GitCommandFailure {
  const failure = new Error(
    `Git command exceeded ${timeoutMs}ms hard timeout`,
    terminationErrors.length > 0
      ? {
        cause: new AggregateError(
          terminationErrors,
          'one or more Git process-group termination steps failed',
        ),
      }
      : undefined,
  ) as GitCommandFailure
  failure.name = 'GitCommandTimeoutError'
  failure.code = 'GIT_COMMAND_TIMEOUT'
  failure.stdout = stdout
  failure.stderr = stderr
  return failure
}

function executeGit(
  repoRoot: string,
  args: readonly string[],
  kind: 'local' | 'fetch' = 'local',
  environment?: NodeJS.ProcessEnv,
): Promise<Buffer> {
  const timeoutMs = resolveGitTimeout(kind)
  return new Promise((resolve, reject) => {
    let timedOut = false
    let settled = false
    const terminationErrors: unknown[] = []
    let timeout: NodeJS.Timeout | undefined
    let terminationDeadline: NodeJS.Timeout | undefined
    const invocation = resolveGitProcessInvocation(repoRoot, args)
    const child = execFile(
      invocation.executable,
      invocation.args,
      {
        encoding: 'buffer',
        env: environment ?? integrationGitEnvironment(),
        maxBuffer: resolveGitMaxBufferBytes(),
      },
      (error, stdout, stderr) => {
        if (settled) return
        if (timeout) clearTimeout(timeout)
        if (terminationDeadline) clearTimeout(terminationDeadline)
        if (timedOut) {
          settled = true
          reject(createGitTimeoutFailure(
            timeoutMs,
            terminationErrors,
            stdout,
            stderr,
          ))
          return
        }
        if (error) {
          const failure = error as GitCommandFailure
          failure.stdout = stdout
          failure.stderr = stderr
          settled = true
          reject(failure)
          return
        }

        settled = true
        resolve(stdout)
      },
    )

    timeout = setTimeout(() => {
      if (settled) return
      timedOut = true
      terminateGitProcessOnce(
        child,
        invocation.independentProcessGroup,
        terminationErrors,
      )
      if (settled) return
      terminationDeadline = setTimeout(() => {
        if (settled) return
        child.stdout?.destroy()
        child.stderr?.destroy()
        settled = true
        reject(createGitTimeoutFailure(timeoutMs, terminationErrors))
      }, 500)
    }, timeoutMs)
  })
}

function executeGitDiffHash(
  repoRoot: string,
  args: readonly string[],
  onChunk?: (chunk: Buffer) => void | Promise<void>,
): Promise<{ diffHash: string; byteLength: number }> {
  const timeoutMs = resolveGitTimeout('local')
  const maxDiffBytes = resolveMaxDiffBytes()
  const deadlineAt = performance.now() + timeoutMs

  return new Promise((resolve, reject) => {
    const invocation = resolveGitProcessInvocation(repoRoot, args)
    const terminationErrors: unknown[] = []
    const stderrChunks: Buffer[] = []
    const hash = createHash('sha256')
    let stderrBytes = 0
    let diffBytes = 0
    let settled = false
    let terminationStarted = false
    let abortReason:
      | 'timeout'
      | 'too_large'
      | 'spawn_error'
      | 'stream_error'
      | null = null
    let abortError: unknown
    let timeout: NodeJS.Timeout | undefined
    let terminationDeadline: NodeJS.Timeout | undefined
    let pendingChunks = 0
    let closeObserved = false
    let closeCode: number | null = null
    let closeSignal: NodeJS.Signals | null = null

    const boundedStderr = () => Buffer.concat(stderrChunks, stderrBytes)
    const failureForAbort = (): unknown => {
      if (abortReason === 'too_large') {
        return new IntegrationGitError(
          'GIT_DIFF_TOO_LARGE',
          `冻结快照 diff 超过 ${maxDiffBytes} 字节上限`,
          terminationErrors.length > 0
            ? {
              cause: new AggregateError(
                terminationErrors,
                '终止超限 Git diff 进程组失败',
              ),
            }
            : undefined,
        )
      }
      if (abortReason === 'timeout') {
        return createGitTimeoutFailure(
          timeoutMs,
          terminationErrors,
          undefined,
          boundedStderr(),
        )
      }
      if (abortReason === 'spawn_error' || abortReason === 'stream_error') {
        return abortError
      }
      return new Error('Git diff 流在未提供结果的情况下结束')
    }
    const recordAbort = (
      reason: Exclude<typeof abortReason, null>,
      error?: unknown,
    ): boolean => {
      if (settled || abortReason !== null) return false
      abortReason = reason
      abortError = error
      return true
    }
    const startTermination = (
      reason: Exclude<typeof abortReason, null>,
      error?: unknown,
    ) => {
      if (!recordAbort(reason, error) || terminationStarted) return
      terminationStarted = true
      terminateGitProcessOnce(
        child,
        invocation.independentProcessGroup,
        terminationErrors,
      )
      if (settled) return
      terminationDeadline = setTimeout(() => {
        if (settled) return
        child.stdout?.destroy()
        child.stderr?.destroy()
        settled = true
        reject(failureForAbort())
      }, 500)
    }

    const child = spawn(invocation.executable, invocation.args, {
      env: integrationGitEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const finishIfReady = () => {
      if (settled || !closeObserved || pendingChunks !== 0) return
      if (abortReason === null && performance.now() >= deadlineAt) {
        recordAbort('timeout')
      }
      if (timeout) clearTimeout(timeout)
      if (terminationDeadline) clearTimeout(terminationDeadline)
      settled = true
      if (abortReason !== null) {
        reject(failureForAbort())
        return
      }
      if (closeCode !== 0) {
        const failure = new Error(
          `Git diff exited with ${closeCode ?? closeSignal ?? 'unknown status'}`,
        ) as GitCommandFailure
        failure.code = closeCode ?? closeSignal ?? undefined
        failure.stderr = boundedStderr()
        reject(failure)
        return
      }
      resolve({ diffHash: hash.digest('hex'), byteLength: diffBytes })
    }

    child.stdout?.on('data', (value: Buffer | string) => {
      if (settled || abortReason !== null || terminationStarted) return
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      child.stdout?.pause()
      pendingChunks += 1
      void (async () => {
        if (performance.now() >= deadlineAt) {
          startTermination('timeout')
          return
        }
        if (diffBytes + chunk.length > maxDiffBytes) {
          startTermination('too_large')
          return
        }
        await onChunk?.(chunk)
        diffBytes += chunk.length
        hash.update(chunk)
      })().catch((error) => {
        startTermination('stream_error', error)
      }).finally(() => {
        pendingChunks -= 1
        if (!settled && !terminationStarted) child.stdout?.resume()
        finishIfReady()
      })
    })
    child.stderr?.on('data', (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      const remaining = MAX_STREAMING_STDERR_BYTES - stderrBytes
      if (remaining <= 0) return
      const captured = Buffer.from(chunk.subarray(0, remaining))
      stderrChunks.push(captured)
      stderrBytes += captured.length
    })
    child.once('error', (error) => {
      startTermination('spawn_error', error)
    })
    child.stdout?.once('error', (error) => {
      startTermination('stream_error', error)
    })
    child.stderr?.once('error', (error) => {
      startTermination('stream_error', error)
    })
    child.once('close', (code, signal) => {
      closeObserved = true
      closeCode = code
      closeSignal = signal
      finishIfReady()
    })

    timeout = setTimeout(() => {
      if (settled) return
      startTermination('timeout')
    }, Math.max(0, deadlineAt - performance.now()))
  })
}

function errorText(error: unknown): string {
  if (!error || typeof error !== 'object') return ''

  const stderr = (error as Partial<GitCommandFailure>).stderr
  if (Buffer.isBuffer(stderr)) return stderr.toString('utf8')
  if (typeof stderr === 'string') return stderr

  return ''
}

function validateNormalizedAbsolutePath(
  value: string,
  kind: 'repoRoot' | 'runtimeRoot',
): string {
  const errorCode = kind === 'repoRoot' ? 'INVALID_REPO_ROOT' : 'INVALID_RUNTIME_ROOT'
  const label = kind === 'repoRoot' ? '仓库根目录' : '运行时根目录'

  if (
    typeof value !== 'string' ||
    !value ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    path.normalize(value) !== value ||
    value === path.parse(value).root
  ) {
    throw new IntegrationGitError(
      errorCode,
      `${label}必须是规范化的非根绝对路径`,
    )
  }

  return value
}

function validateRepoRoot(repoRoot: string): string {
  return validateNormalizedAbsolutePath(repoRoot, 'repoRoot')
}

function validateRuntimeRoot(runtimeRoot: string): string {
  return validateNormalizedAbsolutePath(runtimeRoot, 'runtimeRoot')
}

export function resolveIntegrationRuntimeRoot(explicitRuntimeRoot?: string): string {
  const configuredRuntimeRoot = explicitRuntimeRoot !== undefined
    ? explicitRuntimeRoot
    : process.env.HARMONY_INTEGRATION_RUNTIME_ROOT ||
      path.join(tmpdir(), 'harmony-integration-runs')

  return validateRuntimeRoot(configuredRuntimeRoot)
}

async function resolveCanonicalGitRepoRoot(repoRootInput: string): Promise<string> {
  const repoRoot = validateRepoRoot(repoRootInput)
  let requestedRealPath: string

  try {
    await lstat(repoRoot)
    requestedRealPath = await realpath(repoRoot)
    const requestedStat = await lstat(requestedRealPath)
    if (!requestedStat.isDirectory()) {
      throw new IntegrationGitError('INVALID_REPO_ROOT', '仓库根目录不是目录')
    }
  } catch (error) {
    if (error instanceof IntegrationGitError) throw error
    throw new IntegrationGitError('INVALID_REPO_ROOT', '仓库根目录不存在或无法访问', {
      cause: error,
    })
  }

  let gitTopLevel: string
  try {
    gitTopLevel = (await executeGit(requestedRealPath, [
      'rev-parse',
      '--show-toplevel',
    ])).toString('utf8').trim()
  } catch (error) {
    throw new IntegrationGitError('INVALID_REPO_ROOT', '仓库根目录不是 Git 工作树目录', {
      cause: error,
    })
  }

  try {
    const canonicalGitRoot = await realpath(gitTopLevel)
    const canonicalStat = await lstat(canonicalGitRoot)
    if (!canonicalStat.isDirectory()) {
      throw new IntegrationGitError('INVALID_REPO_ROOT', 'Git 工作树根目录不是目录')
    }
    return canonicalGitRoot
  } catch (error) {
    if (error instanceof IntegrationGitError) throw error
    throw new IntegrationGitError('INVALID_REPO_ROOT', '无法解析 Git 工作树真实路径', {
      cause: error,
    })
  }
}

function validateBranch(branch: string, field: 'sourceBranch' | 'targetBranch'): string {
  if (typeof branch !== 'string' || !isValidGitBranchName(branch)) {
    throw new IntegrationGitError('INVALID_BRANCH', `${field} 不是合法的 Git 分支名`)
  }

  return branch
}

function validateScopePath(scopePath: string | undefined): string | undefined {
  if (scopePath === undefined) return undefined

  try {
    const normalized = normalizeIntegrationScopePath(scopePath, 'scopePath')
    if (normalized !== scopePath) {
      throw new Error('scopePath 未规范化')
    }
    return normalized
  } catch (error) {
    throw new IntegrationGitError(
      'INVALID_SCOPE_PATH',
      'scopePath 必须是规范化且不能逃逸仓库的相对路径',
      { cause: error },
    )
  }
}

function validateRunId(runId: string): string {
  if (typeof runId !== 'string' || !SAFE_RUN_ID_PATTERN.test(runId)) {
    throw new IntegrationGitError('INVALID_RUN_ID', 'runId 必须是 1-64 位安全 slug')
  }

  return runId
}

function validateCommitSha(headSha: string): string {
  if (typeof headSha !== 'string' || !COMMIT_SHA_PATTERN.test(headSha)) {
    throw new IntegrationGitError('INVALID_COMMIT_SHA', 'headSha 必须是完整提交 SHA')
  }

  return headSha
}

function unicodeEscape(character: string): string {
  const codePoint = character.codePointAt(0)
  if (codePoint === undefined) return ''
  return codePoint <= 0xffff
    ? `\\u${codePoint.toString(16).padStart(4, '0')}`
    : `\\u{${codePoint.toString(16)}}`
}

function displaySafeConflictPath(rawPath: Buffer): {
  value: string
  truncated: boolean
} {
  const truncated = rawPath.length > MAX_REPORTED_MERGE_CONFLICT_PATH_RAW_BYTES
  const boundedPath = truncated
    ? rawPath.subarray(0, MAX_REPORTED_MERGE_CONFLICT_PATH_RAW_BYTES)
    : rawPath
  let decodedPath: string
  try {
    decodedPath = FATAL_UTF8_DECODER.decode(boundedPath)
  } catch {
    return {
      value: `non-utf8:${boundedPath.toString('hex')}${truncated ? '...(truncated)' : ''}`,
      truncated,
    }
  }

  let safePath = ''
  for (const character of decodedPath) {
    if (
      NON_DISPLAYABLE_GIT_PATH_CHARACTER_PATTERN.test(character) ||
      UNSAFE_GIT_PATH_MARKUP_CHARACTERS.has(character)
    ) {
      safePath += unicodeEscape(character)
    } else {
      safePath += character
    }
  }
  return {
    value: `${safePath}${truncated ? '...(truncated)' : ''}`,
    truncated,
  }
}

function mergeTreeStdout(error: unknown): Buffer | undefined {
  if (!error || typeof error !== 'object') return undefined
  const stdout = (error as Partial<GitCommandFailure>).stdout
  if (Buffer.isBuffer(stdout)) return stdout
  if (typeof stdout === 'string') return Buffer.from(stdout)
  return undefined
}

function gitExitCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as Partial<GitCommandFailure>).code
  if (typeof code === 'number' && Number.isSafeInteger(code)) return code
  if (typeof code === 'string' && /^\d+$/.test(code)) return Number(code)
  return undefined
}

function parseMergeTreeOutput(
  output: Buffer,
  hasConflicts: boolean,
): {
  conflictPaths: readonly string[]
  conflictPathCount: number
  conflictPathsTruncated: boolean
} {
  const treeSeparator = output.indexOf(0)
  if (treeSeparator <= 0 || output[output.length - 1] !== 0) {
    throw new Error('git merge-tree 未返回完整的 NUL 分隔输出')
  }
  const treeOid = output.subarray(0, treeSeparator).toString('ascii')
  if (!COMMIT_SHA_PATTERN.test(treeOid)) {
    throw new Error('git merge-tree 未返回合法的结果树 SHA')
  }

  const conflictPaths: string[] = []
  let conflictPathCount = 0
  let reportedPathBytes = 0
  let displayTruncated = false
  let segmentStart = treeSeparator + 1
  for (let cursor = segmentStart; cursor < output.length; cursor += 1) {
    if (output[cursor] !== 0) continue
    if (cursor > segmentStart) {
      conflictPathCount += 1
      if (conflictPaths.length < MAX_REPORTED_MERGE_CONFLICT_PATHS) {
        const displayPath = displaySafeConflictPath(
          output.subarray(segmentStart, cursor),
        )
        const displayBytes = Buffer.byteLength(displayPath.value, 'utf8')
        if (
          reportedPathBytes + displayBytes
          <= MAX_REPORTED_MERGE_CONFLICT_TOTAL_BYTES
        ) {
          conflictPaths.push(displayPath.value)
          reportedPathBytes += displayBytes
          displayTruncated ||= displayPath.truncated
        } else {
          displayTruncated = true
        }
      }
    }
    segmentStart = cursor + 1
  }
  if (!hasConflicts && conflictPathCount > 0) {
    throw new Error('git merge-tree 在无冲突退出状态下返回了冲突路径')
  }
  return {
    conflictPaths,
    conflictPathCount,
    conflictPathsTruncated:
      displayTruncated || conflictPathCount > conflictPaths.length,
  }
}

interface IsolatedMergeRepository {
  root: string
  environment: NodeJS.ProcessEnv
}

function isolatedMergeGitEnvironment(root: string): NodeJS.ProcessEnv {
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'
  return {
    ...integrationGitEnvironment(),
    HOME: root,
    XDG_CONFIG_HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_ATTR_NOSYSTEM: '1',
  }
}

async function resolveGitObjectStore(repoRoot: string): Promise<{
  objectDirectory: string
  objectFormat: 'sha1' | 'sha256'
}> {
  const [objectDirectoryOutput, objectFormatOutput] = await Promise.all([
    executeGit(repoRoot, ['rev-parse', '--git-path', 'objects']),
    executeGit(repoRoot, ['rev-parse', '--show-object-format']),
  ])
  const rawObjectDirectory = objectDirectoryOutput.toString('utf8').trim()
  if (!rawObjectDirectory || CONTROL_CHARACTER_PATTERN.test(rawObjectDirectory)) {
    throw new Error('Git 对象目录路径无效')
  }
  const objectDirectoryCandidate = path.isAbsolute(rawObjectDirectory)
    ? rawObjectDirectory
    : path.resolve(repoRoot, rawObjectDirectory)
  const objectDirectory = await realpath(objectDirectoryCandidate)
  const objectDirectoryStat = await lstat(objectDirectory)
  if (!objectDirectoryStat.isDirectory()) {
    throw new Error('Git 对象目录不是目录')
  }

  const objectFormat = objectFormatOutput.toString('ascii').trim()
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
    throw new Error('Git 对象格式不受支持')
  }
  return { objectDirectory, objectFormat }
}

async function createIsolatedMergeRepository(
  sourceRepoRoot: string,
): Promise<IsolatedMergeRepository> {
  const { objectDirectory, objectFormat } = await resolveGitObjectStore(sourceRepoRoot)
  const root = await mkdtemp(path.join(tmpdir(), 'harmony-integration-merge-'))
  try {
    await mkdir(path.join(root, 'objects', 'info'), { recursive: true, mode: 0o700 })
    await mkdir(path.join(root, 'refs', 'heads'), { recursive: true, mode: 0o700 })
    const config = [
      '[core]',
      `\trepositoryformatversion = ${objectFormat === 'sha256' ? 1 : 0}`,
      '\tbare = true',
      ...(objectFormat === 'sha256'
        ? ['[extensions]', '\tobjectFormat = sha256']
        : []),
      '',
    ].join('\n')
    await Promise.all([
      writeFile(path.join(root, 'HEAD'), 'ref: refs/heads/isolated\n', {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      }),
      writeFile(path.join(root, 'config'), config, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      }),
      writeFile(
        path.join(root, 'objects', 'info', 'alternates'),
        `${objectDirectory}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      ),
    ])
    return {
      root,
      environment: isolatedMergeGitEnvironment(root),
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function ensureCommitExists(repoRoot: string, headSha: string): Promise<void> {
  try {
    await executeGit(repoRoot, ['cat-file', '-e', `${headSha}^{commit}`])
  } catch (error) {
    throw new IntegrationGitError(
      'INVALID_COMMIT_SHA',
      'headSha 不是仓库中存在的完整提交 SHA',
      { cause: error },
    )
  }
}

function remoteTrackingRef(branch: string): string {
  return `refs/remotes/origin/${branch}`
}

function isMissingRemoteRefError(error: unknown): boolean {
  return /(?:couldn't find remote ref|remote ref does not exist|not our ref)/i.test(
    errorText(error),
  )
}

async function fetchRemoteBranch(
  repoRoot: string,
  branch: string,
  remoteRef: string,
): Promise<void> {
  const refspec = `+refs/heads/${branch}:${remoteRef}`

  try {
    await executeGit(repoRoot, ['fetch', '--prune', 'origin', refspec], 'fetch')
  } catch (error) {
    if (isMissingRemoteRefError(error)) {
      throw new IntegrationGitError(
        'ORIGIN_REF_NOT_FOUND',
        `远端 origin 不存在分支 ${branch}`,
        { cause: error },
      )
    }

    throw new IntegrationGitError(
      'GIT_FETCH_FAILED',
      `无法从 origin 刷新分支 ${branch}`,
      { cause: error },
    )
  }
}

async function resolveRemoteCommit(
  repoRoot: string,
  remoteRef: string,
  branch: string,
): Promise<string> {
  try {
    const output = await executeGit(repoRoot, [
      'rev-parse',
      '--verify',
      `${remoteRef}^{commit}`,
    ])
    const sha = output.toString('utf8').trim()
    if (!COMMIT_SHA_PATTERN.test(sha)) throw new Error('Git 返回了非法提交 SHA')
    return sha
  } catch (error) {
    throw new IntegrationGitError(
      'ORIGIN_REF_NOT_FOUND',
      `无法解析远端跟踪分支 origin/${branch}`,
      { cause: error },
    )
  }
}

export async function refreshIntegrationBranchTips(
  input: RefreshIntegrationBranchTipsInput,
): Promise<IntegrationBranchTips> {
  validateGitExecutionConfig()
  const repoRoot = await resolveCanonicalGitRepoRoot(input.repoRoot)
  const sourceBranch = validateBranch(input.sourceBranch, 'sourceBranch')
  const targetBranch = validateBranch(input.targetBranch, 'targetBranch')
  const sourceRef = remoteTrackingRef(sourceBranch)
  const targetRef = remoteTrackingRef(targetBranch)

  await fetchRemoteBranch(repoRoot, sourceBranch, sourceRef)
  if (sourceRef !== targetRef) {
    await fetchRemoteBranch(repoRoot, targetBranch, targetRef)
  }

  const headSha = await resolveRemoteCommit(repoRoot, sourceRef, sourceBranch)
  const targetTipSha = sourceRef === targetRef
    ? headSha
    : await resolveRemoteCommit(repoRoot, targetRef, targetBranch)
  return { headSha, targetTipSha }
}

async function hashIntegrationDiffFromStream(
  repoRoot: string,
  baseSha: string,
  headSha: string,
  scopePath: string | undefined,
): Promise<string> {
  const diffArgs = buildIntegrationDiffArgs(baseSha, headSha, scopePath)
  try {
    return (await executeGitDiffHash(repoRoot, diffArgs)).diffHash
  } catch (error) {
    if (error instanceof IntegrationGitError) throw error
    throw new IntegrationGitError(
      'GIT_DIFF_FAILED',
      '无法生成或流式处理冻结快照的 Git diff',
      { cause: error },
    )
  }
}

function buildIntegrationDiffArgs(
  baseSha: string,
  headSha: string,
  scopePath: string | undefined,
): string[] {
  const diffArgs = [
    'diff',
    // Archives/images remain visible without encoding their bytes into the review.
    // Full blob IDs ensure binary-only changes still invalidate report reuse.
    '--full-index',
    '--no-ext-diff',
    '--no-textconv',
    `${baseSha}...${headSha}`,
  ]
  if (scopePath) diffArgs.push('--', scopePath)
  return diffArgs
}

async function assertIntegrationChangedFileLimit(
  repoRoot: string,
  baseSha: string,
  headSha: string,
  scopePath: string | undefined,
): Promise<void> {
  const maxChangedFiles = resolveMaxChangedFiles()
  const args = [
    'diff',
    '--name-only',
    '-z',
    '--no-renames',
    '--no-ext-diff',
    '--no-textconv',
    `${baseSha}...${headSha}`,
  ]
  if (scopePath) args.push('--', scopePath)

  let output: Buffer
  try {
    output = await executeGit(repoRoot, args)
  } catch (error) {
    throw new IntegrationGitError(
      'GIT_DIFF_TOO_MANY_FILES',
      `无法在 ${maxChangedFiles} 个文件上限内完成变更文件计数`,
      { cause: error },
    )
  }

  if (output.length > 0 && output[output.length - 1] !== 0) {
    throw new IntegrationGitError(
      'GIT_DIFF_FAILED',
      'Git 变更文件列表不是完整的 NUL 分隔输出',
    )
  }
  let changedFileCount = 0
  for (const byte of output) {
    if (byte === 0) changedFileCount += 1
  }
  if (changedFileCount > maxChangedFiles) {
    throw new IntegrationGitError(
      'GIT_DIFF_TOO_MANY_FILES',
      `冻结快照包含 ${changedFileCount} 个变更文件，超过 ${maxChangedFiles} 个上限`,
    )
  }
}

async function writeBufferFully(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Buffer,
): Promise<void> {
  let offset = 0
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.length - offset,
      null,
    )
    if (bytesWritten <= 0) throw new Error('无法继续写入冻结 diff')
    offset += bytesWritten
  }
}

async function materializeIntegrationFrozenDiffInternal(
  input: MaterializeIntegrationFrozenDiffInput,
): Promise<MaterializedIntegrationFrozenDiff> {
  validateGitExecutionConfig()
  const repoRoot = await resolveCanonicalGitRepoRoot(input.repoRoot)
  const baseSha = validateCommitSha(input.baseSha)
  const headSha = validateCommitSha(input.headSha)
  const scopePath = validateScopePath(input.scopePath)
  if (!/^[a-f0-9]{64}$/.test(input.expectedDiffHash)) {
    throw new IntegrationGitError(
      'FROZEN_DIFF_MISMATCH',
      'expectedDiffHash 必须是 SHA-256 十六进制值',
    )
  }
  await ensureCommitExists(repoRoot, baseSha)
  await ensureCommitExists(repoRoot, headSha)
  await assertIntegrationChangedFileLimit(
    repoRoot,
    baseSha,
    headSha,
    scopePath,
  )

  const expectedOutputPath = path.join(
    repoRoot,
    '.harmony-integration',
    'frozen.diff',
  )
  if (
    !path.isAbsolute(input.outputPath) ||
    path.resolve(input.outputPath) !== input.outputPath
  ) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      '冻结 diff 只能写入 worktree 内固定控制路径',
    )
  }
  const outputParent = path.dirname(input.outputPath)
  const outputParentStat = await lstat(outputParent)
  if (outputParentStat.isSymbolicLink() || !outputParentStat.isDirectory()) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      '冻结 diff 控制目录不是安全目录',
    )
  }
  const outputParentRealPath = await realpath(outputParent)
  if (
    outputParentRealPath !== path.dirname(expectedOutputPath) ||
    path.basename(input.outputPath) !== path.basename(expectedOutputPath)
  ) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      '冻结 diff 只能写入 worktree 内固定控制路径',
    )
  }
  if (await statIfExists(input.outputPath)) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_EXISTS',
      '冻结 diff 输出路径已存在，拒绝覆盖',
    )
  }

  const temporaryPath = path.join(
    outputParent,
    `.frozen-${randomBytes(32).toString('hex')}.tmp`,
  )
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let published = false
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    const result = await executeGitDiffHash(
      repoRoot,
      buildIntegrationDiffArgs(baseSha, headSha, scopePath),
      (chunk) => writeBufferFully(handle!, chunk),
    )
    await handle.sync()
    await handle.close()
    handle = undefined
    if (result.diffHash !== input.expectedDiffHash) {
      throw new IntegrationGitError(
        'FROZEN_DIFF_MISMATCH',
        '冻结 diff 的 SHA-256 与 IntegrationGitSnapshot 不一致',
      )
    }
    await link(temporaryPath, input.outputPath)
    published = true
    await unlink(temporaryPath)
    return result
  } catch (error) {
    await handle?.close().catch(() => {})
    if (!published) await unlink(temporaryPath).catch(() => {})
    if (error instanceof IntegrationGitError) throw error
    throw new IntegrationGitError(
      'GIT_DIFF_FAILED',
      '流式生成冻结 diff 失败',
      { cause: error },
    )
  }
}

export async function materializeIntegrationFrozenDiff(
  input: MaterializeIntegrationFrozenDiffInput,
): Promise<MaterializedIntegrationFrozenDiff> {
  try {
    return await materializeIntegrationFrozenDiffInternal(input)
  } catch (error) {
    if (error instanceof IntegrationGitError) throw error
    throw new IntegrationGitError(
      'GIT_DIFF_FAILED',
      '流式生成冻结 diff 时发生文件系统错误',
      { cause: error },
    )
  }
}

async function freezeIntegrationGitSnapshotInternal(
  input: FreezeIntegrationGitSnapshotInput,
): Promise<IntegrationGitSnapshot> {
  validateGitExecutionConfig()
  const repoRoot = await resolveCanonicalGitRepoRoot(input.repoRoot)
  const runtimeRoot = resolveIntegrationRuntimeRoot(input.runtimeRoot)
  const prospectiveRuntimeRealPath = await resolveProspectiveRealPath(
    runtimeRoot,
    'GIT_DIFF_FAILED',
  )
  await assertRuntimeSeparatedFromGitTopology(
    repoRoot,
    prospectiveRuntimeRealPath,
  )
  const runtimeRealPath = await ensureSafeRuntimeRoot(runtimeRoot)
  await assertRuntimeSeparatedFromGitTopology(repoRoot, runtimeRealPath)
  const sourceBranch = validateBranch(input.sourceBranch, 'sourceBranch')
  const targetBranch = validateBranch(input.targetBranch, 'targetBranch')
  const scopePath = validateScopePath(input.scopePath)
  const sourceRef = remoteTrackingRef(sourceBranch)
  const targetRef = remoteTrackingRef(targetBranch)

  await fetchRemoteBranch(repoRoot, sourceBranch, sourceRef)
  if (sourceRef !== targetRef) {
    await fetchRemoteBranch(repoRoot, targetBranch, targetRef)
  }

  const headSha = await resolveRemoteCommit(repoRoot, sourceRef, sourceBranch)
  const targetTipSha = sourceRef === targetRef
    ? headSha
    : await resolveRemoteCommit(repoRoot, targetRef, targetBranch)

  let baseSha: string
  try {
    baseSha = (await executeGit(repoRoot, [
      'merge-base',
      targetTipSha,
      headSha,
    ])).toString('utf8').trim()
    if (!COMMIT_SHA_PATTERN.test(baseSha)) throw new Error('Git 返回了非法 merge-base SHA')
  } catch (error) {
    throw new IntegrationGitError(
      'MERGE_BASE_NOT_FOUND',
      `无法计算 origin/${targetBranch} 与 origin/${sourceBranch} 的共同基线`,
      { cause: error },
    )
  }

  const diffHash = await hashIntegrationDiffFromStream(
    repoRoot,
    baseSha,
    headSha,
    scopePath,
  )
  await assertIntegrationChangedFileLimit(
    repoRoot,
    baseSha,
    headSha,
    scopePath,
  )

  return {
    sourceRef,
    targetRef,
    targetTipSha,
    baseSha,
    headSha,
    diffHash,
  }
}

export async function freezeIntegrationGitSnapshot(
  input: FreezeIntegrationGitSnapshotInput,
): Promise<IntegrationGitSnapshot> {
  try {
    return await freezeIntegrationGitSnapshotInternal(input)
  } catch (error) {
    if (error instanceof IntegrationGitError) throw error
    throw new IntegrationGitError(
      'GIT_DIFF_FAILED',
      '冻结集成 Git 快照时发生文件系统错误',
      { cause: error },
    )
  }
}

export async function checkIntegrationMergeConflicts(
  input: CheckIntegrationMergeConflictsInput,
): Promise<IntegrationMergeConflictCheckResult> {
  validateGitExecutionConfig()
  const repoRoot = await resolveCanonicalGitRepoRoot(input.repoRoot)
  const targetTipSha = validateCommitSha(input.targetTipSha)
  const headSha = validateCommitSha(input.headSha)
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'
  const args = [
    '--git-dir=.',
    '-c',
    `core.attributesFile=${nullDevice}`,
    'merge-tree',
    '--write-tree',
    '--name-only',
    '--no-messages',
    '-z',
    targetTipSha,
    headSha,
  ]

  let isolatedRepository: IsolatedMergeRepository | undefined
  let result: IntegrationMergeConflictCheckResult | undefined
  let failure: unknown
  try {
    isolatedRepository = await createIsolatedMergeRepository(repoRoot)
    try {
      await executeGit(
        isolatedRepository.root,
        ['--git-dir=.', 'cat-file', '-e', `${targetTipSha}^{commit}`],
        'local',
        isolatedRepository.environment,
      )
      await executeGit(
        isolatedRepository.root,
        ['--git-dir=.', 'cat-file', '-e', `${headSha}^{commit}`],
        'local',
        isolatedRepository.environment,
      )
    } catch (error) {
      throw new IntegrationGitError(
        'INVALID_COMMIT_SHA',
        'targetTipSha 或 headSha 不是仓库中存在的完整提交 SHA',
        { cause: error },
      )
    }

    const output = await executeGit(
      isolatedRepository.root,
      args,
      'local',
      isolatedRepository.environment,
    )
    result = {
      hasConflicts: false,
      ...parseMergeTreeOutput(output, false),
    }
  } catch (error) {
    if (gitExitCode(error) === 1) {
      try {
        const output = mergeTreeStdout(error)
        if (!output) throw new Error('git merge-tree 冲突结果缺少 stdout')
        result = {
          hasConflicts: true,
          ...parseMergeTreeOutput(output, true),
        }
      } catch (parseError) {
        failure = new IntegrationGitError(
          'MERGE_CONFLICT_CHECK_FAILED',
          '无法解析 Git 合并冲突检测结果',
          { cause: parseError },
        )
      }
    } else if (error instanceof IntegrationGitError) {
      failure = error
    } else {
      failure = new IntegrationGitError(
        'MERGE_CONFLICT_CHECK_FAILED',
        '无法检测开发分支与目标分支的合并冲突',
        { cause: error },
      )
    }
  } finally {
    if (isolatedRepository) {
      try {
        await rm(isolatedRepository.root, { recursive: true, force: true })
      } catch (cleanupError) {
        failure = new IntegrationGitError(
          'MERGE_CONFLICT_CHECK_FAILED',
          '合并冲突检测的隔离对象库清理失败',
          {
            cause: failure
              ? new AggregateError([failure, cleanupError], '检测失败且隔离对象库清理失败')
              : cleanupError,
          },
        )
      }
    }
  }
  if (failure) throw failure
  if (!result) {
    throw new IntegrationGitError(
      'MERGE_CONFLICT_CHECK_FAILED',
      '合并冲突检测未返回结果',
    )
  }
  return result
}

function resolveWorktreePaths(
  runtimeRoot: string,
  runId: string,
): IntegrationWorktreeLocations {
  const runRoot = path.join(runtimeRoot, runId)
  const repoPath = path.join(runRoot, 'repo')

  assertPathContained(runtimeRoot, runRoot)
  assertPathContained(runtimeRoot, repoPath)

  return { runRoot, repoPath }
}

function assertPathContained(parent: string, candidate: string): void {
  const relative = path.relative(parent, candidate)
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      '集成 worktree 路径逃逸运行时根目录',
    )
  }
}

function isSameOrContained(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return (
    relative === '' ||
    (
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    )
  )
}

function assertRepoRuntimeSeparate(repoRealPath: string, runtimeRealPath: string): void {
  if (
    isSameOrContained(repoRealPath, runtimeRealPath) ||
    isSameOrContained(runtimeRealPath, repoRealPath)
  ) {
    throw new IntegrationGitError(
      'REPO_RUNTIME_OVERLAP',
      '仓库目录与集成运行时目录不能相同或互相包含',
    )
  }
}

async function resolveProspectiveRealPath(
  targetPath: string,
  failureCode:
    | 'GIT_DIFF_FAILED'
    | 'WORKTREE_CREATE_FAILED'
    | 'WORKTREE_CLEANUP_FAILED',
): Promise<string> {
  let existingAncestor = targetPath
  const missingSegments: string[] = []

  while (true) {
    try {
      await lstat(existingAncestor)
      const ancestorRealPath = await realpath(existingAncestor)
      return path.join(ancestorRealPath, ...missingSegments)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const parent = path.dirname(existingAncestor)
        if (parent !== existingAncestor) {
          missingSegments.unshift(path.basename(existingAncestor))
          existingAncestor = parent
          continue
        }
      }

      throw new IntegrationGitError(
        failureCode,
        '无法解析集成运行时目录的真实路径',
        { cause: error },
      )
    }
  }
}

async function statIfExists(targetPath: string) {
  try {
    return await lstat(targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function assertPrivateDirectory(
  directoryStat: Awaited<ReturnType<typeof lstat>>,
  label: string,
  requireMode700: boolean,
): void {
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new IntegrationGitError('WORKTREE_PATH_UNSAFE', `${label}不是安全目录`)
  }

  if (process.platform === 'win32') return
  if (
    typeof process.getuid === 'function' &&
    Number(directoryStat.uid) !== process.getuid()
  ) {
    throw new IntegrationGitError('WORKTREE_PATH_UNSAFE', `${label}不属于当前用户`)
  }

  const permissions = Number(directoryStat.mode) & 0o777
  if ((permissions & 0o077) !== 0 || (requireMode700 && permissions !== 0o700)) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      `${label}权限必须为仅当前用户可访问`,
    )
  }
}

async function ensureSafeRuntimeRoot(runtimeRoot: string): Promise<string> {
  let rootStat = await statIfExists(runtimeRoot)
  let created = false

  if (!rootStat) {
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 })
    created = true
    rootStat = await lstat(runtimeRoot)
  }

  assertPrivateDirectory(rootStat, '运行时根目录', created)

  return realpath(runtimeRoot)
}

async function resolveSafeRuntimeRootIfExists(
  runtimeRoot: string,
): Promise<string | undefined> {
  const rootStat = await statIfExists(runtimeRoot)
  if (!rootStat) return undefined
  assertPrivateDirectory(rootStat, '运行时根目录', false)
  return realpath(runtimeRoot)
}

interface IntegrationRunLock {
  runId: string
  lockPath: string
  leaseToken: string
  leaseTokenHash: string
  processStartId: string
  payload: string
  device: number
  inode: number
}

interface IntegrationRunLockPayload {
  v: 1
  runId: string
  pid: number
  processStartId: string
  leaseTokenHash: string
}

function parseIntegrationRunLockPayload(value: string): IntegrationRunLockPayload | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<IntegrationRunLockPayload>
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.v !== 1 ||
      typeof parsed.runId !== 'string' ||
      !SAFE_RUN_ID_PATTERN.test(parsed.runId) ||
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid ?? 0) <= 0 ||
      typeof parsed.processStartId !== 'string' ||
      !parsed.processStartId ||
      parsed.processStartId.length > 256 ||
      CONTROL_CHARACTER_PATTERN.test(parsed.processStartId) ||
      typeof parsed.leaseTokenHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(parsed.leaseTokenHash) ||
      Object.keys(parsed).sort().join(',') !==
        'leaseTokenHash,pid,processStartId,runId,v'
    ) {
      return undefined
    }
    return {
      v: 1,
      runId: parsed.runId,
      pid: parsed.pid as number,
      processStartId: parsed.processStartId,
      leaseTokenHash: parsed.leaseTokenHash,
    }
  } catch {
    return undefined
  }
}

let currentProcessStartIdentityPromise: Promise<string> | undefined

function readWindowsProcessStartTicks(pid: number): Promise<string> {
  const script = [
    `$target = Get-Process -Id ${pid} -ErrorAction Stop`,
    '[Console]::Out.Write($target.StartTime.ToUniversalTime().Ticks)',
  ].join('; ')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        env: integrationGitEnvironment(),
        maxBuffer: 4_096,
        timeout: 5_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        const ticks = stdout.trim()
        if (!/^[0-9]+$/.test(ticks)) {
          reject(new Error('无法解析 Windows 进程启动身份'))
          return
        }
        resolve(ticks)
      },
    )
  })
}

async function readProcessStartIdentity(pid: number): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('进程 PID 无效')
  }
  if (process.platform === 'linux') {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const commandEnd = stat.lastIndexOf(') ')
    const fieldsAfterCommand = commandEnd >= 0
      ? stat.slice(commandEnd + 2).trim().split(/\s+/)
      : []
    const startTime = fieldsAfterCommand[19]
    if (!startTime || !/^[0-9]+$/.test(startTime)) {
      throw new Error('无法解析 /proc 进程启动身份')
    }
    return `linux:${startTime}`
  }
  if (process.platform === 'darwin') {
    if (pid !== process.pid) {
      throw new Error('macOS 只能读取当前进程的启动身份')
    }
    const timeOriginMicros = Math.round(performance.timeOrigin * 1_000)
    return `darwin:${pid}:${timeOriginMicros}`
  }
  if (process.platform === 'win32') {
    const startTicks = await readWindowsProcessStartTicks(pid)
    return `win32:${pid}:${startTicks}`
  }
  throw new Error(`当前平台 ${process.platform} 不支持安全的进程启动身份校验`)
}

async function readCurrentProcessStartIdentity(): Promise<string> {
  if (!currentProcessStartIdentityPromise) {
    currentProcessStartIdentityPromise = readProcessStartIdentity(process.pid)
  }
  return currentProcessStartIdentityPromise
}

async function processIdentityIsAlive(
  pid: number,
  expectedStartIdentity: string,
): Promise<boolean> {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
  // macOS 沙箱内不能可靠读取其他进程的启动时间。PID 仍存活时
  // fail-closed，宁可延迟恢复，也不冒险接管一个可能仍在工作的进程。
  if (process.platform === 'darwin') return true
  try {
    return await readProcessStartIdentity(pid) === expectedStartIdentity
  } catch (error) {
    const code = (error as { code?: string | number }).code
    if (code === 'ENOENT' || code === 'ESRCH' || code === 1) return false
    throw error
  }
}

function hashLeaseToken(leaseToken: string): string {
  return createHash('sha256').update(leaseToken, 'utf8').digest('hex')
}

function leaseTokenHashesEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) {
    return false
  }
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

function assertPrivateLockFile(
  lockStat: Awaited<ReturnType<typeof lstat>>,
  label: string,
): void {
  if (lockStat.isSymbolicLink() || !lockStat.isFile()) {
    throw new IntegrationGitError('WORKTREE_BUSY', `${label}不是安全普通文件`)
  }
  if (
    typeof process.getuid === 'function' &&
    Number(lockStat.uid) !== process.getuid()
  ) {
    throw new IntegrationGitError('WORKTREE_BUSY', `${label}不属于当前用户`)
  }
  if (process.platform !== 'win32' && (Number(lockStat.mode) & 0o777) !== 0o600) {
    throw new IntegrationGitError('WORKTREE_BUSY', `${label}权限不是 0600`)
  }
}

type MetadataFileStat = Awaited<ReturnType<typeof lstat>>

async function readBoundedStableMetadataFile(
  targetPath: string,
  label: string,
  maxBytes: number,
  errorCode: 'WORKTREE_BUSY' | 'WORKTREE_PATH_UNSAFE',
  validateStat: (fileStat: MetadataFileStat) => void,
): Promise<{ payload: string; stat: MetadataFileStat }> {
  const fail = (message: string) => new IntegrationGitError(
    errorCode,
    `${label} ${message}`,
  )
  const assertBoundedSize = (fileStat: MetadataFileStat) => {
    if (!Number.isSafeInteger(fileStat.size) || fileStat.size < 0) {
      throw fail('元数据文件大小无效')
    }
    if (fileStat.size > maxBytes) {
      throw fail(`元数据文件超过 ${maxBytes} 字节上限`)
    }
  }
  const assertSameIdentityAndSize = (
    expected: MetadataFileStat,
    actual: MetadataFileStat,
  ) => {
    if (
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino ||
      actual.size !== expected.size ||
      actual.isSymbolicLink() ||
      !actual.isFile()
    ) {
      throw fail('元数据文件在读取期间被替换或改变大小')
    }
  }

  const initialStat = await lstat(targetPath)
  validateStat(initialStat)
  assertBoundedSize(initialStat)

  const readFlags = fsConstants.O_RDONLY |
    fsConstants.O_NONBLOCK |
    (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW)
  const handle = await open(targetPath, readFlags)
  try {
    const openedStat = await handle.stat()
    validateStat(openedStat)
    assertBoundedSize(openedStat)
    assertSameIdentityAndSize(initialStat, openedStat)

    const buffer = Buffer.alloc(maxBytes + 1)
    let totalBytes = 0
    while (totalBytes < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        totalBytes,
        buffer.length - totalBytes,
        totalBytes,
      )
      if (bytesRead === 0) break
      totalBytes += bytesRead
    }
    if (totalBytes > maxBytes) {
      throw fail(`元数据文件超过 ${maxBytes} 字节上限`)
    }

    const confirmedHandleStat = await handle.stat()
    validateStat(confirmedHandleStat)
    assertBoundedSize(confirmedHandleStat)
    assertSameIdentityAndSize(initialStat, confirmedHandleStat)
    if (totalBytes !== confirmedHandleStat.size) {
      throw fail('元数据文件读取长度与稳定大小不一致')
    }

    const confirmedPathStat = await lstat(targetPath)
    validateStat(confirmedPathStat)
    assertBoundedSize(confirmedPathStat)
    assertSameIdentityAndSize(initialStat, confirmedPathStat)
    return {
      payload: buffer.subarray(0, totalBytes).toString('utf8'),
      stat: initialStat,
    }
  } finally {
    await handle.close()
  }
}

async function releaseIntegrationRunLock(
  lock: IntegrationRunLock,
): Promise<void> {
  const lockStat = await statIfExists(lock.lockPath)
  if (!lockStat) return
  const current = await readBoundedStableMetadataFile(
    lock.lockPath,
    '运行锁',
    MAX_RUN_LOCK_METADATA_BYTES,
    'WORKTREE_BUSY',
    (fileStat) => assertPrivateLockFile(fileStat, '运行锁'),
  )
  if (
    current.stat.dev !== lock.device ||
    current.stat.ino !== lock.inode ||
    current.payload !== lock.payload
  ) {
    throw new Error('拒绝释放身份已变化的运行锁')
  }

  const releasePath = path.join(
    path.dirname(lock.lockPath),
    `.released-${lock.runId}-${randomBytes(32).toString('hex')}`,
  )
  assertPathContained(path.dirname(lock.lockPath), releasePath)
  await rename(lock.lockPath, releasePath)
  const moved = await readBoundedStableMetadataFile(
    releasePath,
    '已隔离运行锁',
    MAX_RUN_LOCK_METADATA_BYTES,
    'WORKTREE_BUSY',
    (fileStat) => assertPrivateLockFile(fileStat, '已隔离运行锁'),
  )
  if (
    moved.stat.dev !== lock.device ||
    moved.stat.ino !== lock.inode ||
    moved.payload !== lock.payload
  ) {
    if (!(await statIfExists(lock.lockPath))) {
      await rename(releasePath, lock.lockPath)
    }
    throw new Error('拒绝删除身份不匹配的运行锁')
  }
  await unlink(releasePath)
}

async function acquireIntegrationRunLock(
  runtimeRealPath: string,
  runId: string,
  failureCode: 'WORKTREE_CREATE_FAILED' | 'WORKTREE_CLEANUP_FAILED',
  requestedLeaseToken?: string,
): Promise<IntegrationRunLock> {
  const locksRoot = path.join(runtimeRealPath, '.locks')
  const lockPath = path.join(locksRoot, `${runId}.lock`)

  try {
    assertPathContained(runtimeRealPath, locksRoot)
    assertPathContained(runtimeRealPath, lockPath)
    try {
      await mkdir(locksRoot, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    const locksStat = await lstat(locksRoot)
    assertPrivateDirectory(locksStat, '运行锁目录', true)
    const locksRealPath = await realpath(locksRoot)
    assertPathContained(runtimeRealPath, locksRealPath)

    const canonicalLockPath = path.join(locksRealPath, `${runId}.lock`)
    const temporaryLockPath = path.join(
      locksRealPath,
      `.tmp-${runId}-${randomBytes(32).toString('hex')}`,
    )
    assertPathContained(locksRealPath, temporaryLockPath)
    if (
      requestedLeaseToken !== undefined &&
      !/^[a-f0-9]{64}$/.test(requestedLeaseToken)
    ) {
      throw new IntegrationGitError(
        'WORKTREE_CREATE_FAILED',
        '预生成的 leaseToken 格式无效',
      )
    }
    const leaseToken =
      requestedLeaseToken ?? randomBytes(32).toString('hex')
    const leaseTokenHash = hashLeaseToken(leaseToken)
    const processStartId = await readCurrentProcessStartIdentity()
    const payload = JSON.stringify({
      v: 1,
      runId,
      pid: process.pid,
      processStartId,
      leaseTokenHash,
    })
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let temporaryStat: Awaited<ReturnType<typeof lstat>> | undefined
    try {
      handle = await open(temporaryLockPath, 'wx', 0o600)
      await handle.writeFile(payload, 'utf8')
      await handle.sync()
      temporaryStat = await handle.stat()
      await handle.close()
      handle = undefined
      await link(temporaryLockPath, canonicalLockPath)
    } catch (error) {
      if (handle) {
        try {
          await handle.close()
        } catch {
          // Preserve the primary publication error.
        }
      }
      try {
        await unlink(temporaryLockPath)
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new AggregateError(
            [error, cleanupError],
            '运行锁发布与临时文件清理均失败',
          )
        }
      }
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new IntegrationGitError(
          'WORKTREE_BUSY',
          `集成运行 ${runId} 已存在锁；普通调用不会自动回收`,
          { cause: error },
        )
      }
      throw error
    }

    const publishedStat = await lstat(canonicalLockPath)
    assertPrivateLockFile(publishedStat, '已发布运行锁')
    if (
      !temporaryStat ||
      publishedStat.dev !== temporaryStat.dev ||
      publishedStat.ino !== temporaryStat.ino
    ) {
      throw new Error('hard-link 发布的运行锁身份不一致')
    }
    try {
      await unlink(temporaryLockPath)
    } catch {
      // A random private temp hard-link is harmless; the canonical lock is valid.
    }
    return {
      runId,
      lockPath: canonicalLockPath,
      leaseToken,
      leaseTokenHash,
      processStartId,
      payload,
      device: Number(publishedStat.dev),
      inode: Number(publishedStat.ino),
    }
  } catch (error) {
    if (error instanceof IntegrationGitError) throw error
    throw new IntegrationGitError(
      failureCode,
      `无法获取集成运行 ${runId} 的跨进程锁`,
      { cause: error },
    )
  }
}

async function loadIntegrationRunLease(
  runtimeRealPath: string,
  runId: string,
  leaseToken: string,
): Promise<IntegrationRunLock> {
  const lockPath = path.join(runtimeRealPath, '.locks', `${runId}.lock`)
  try {
    if (!/^[a-f0-9]{64}$/.test(leaseToken)) {
      throw new Error('leaseToken 格式无效')
    }
    const loaded = await readBoundedStableMetadataFile(
      lockPath,
      '运行 lease',
      MAX_RUN_LOCK_METADATA_BYTES,
      'WORKTREE_BUSY',
      (fileStat) => assertPrivateLockFile(fileStat, '运行 lease'),
    )
    const lockStat = loaded.stat
    const payloadText = loaded.payload
    const payload = parseIntegrationRunLockPayload(payloadText)
    const leaseTokenHash = hashLeaseToken(leaseToken)
    const processStartId = await readCurrentProcessStartIdentity()
    if (
      !payload ||
      payload.runId !== runId ||
      payload.pid !== process.pid ||
      payload.processStartId !== processStartId ||
      !leaseTokenHashesEqual(payload.leaseTokenHash, leaseTokenHash) ||
      lockStat.isSymbolicLink()
    ) {
      throw new Error('lease 身份不匹配')
    }
    return {
      runId,
      lockPath,
      leaseToken,
      leaseTokenHash,
      processStartId,
      payload: payloadText,
      device: Number(lockStat.dev),
      inode: Number(lockStat.ino),
    }
  } catch (error) {
    throw new IntegrationGitError(
      'WORKTREE_BUSY',
      `集成运行 ${runId} 的 lease 缺失或不匹配`,
      { cause: error },
    )
  }
}

async function integrationRunLockExists(
  runtimeRealPath: string,
  runId: string,
): Promise<boolean> {
  return Boolean(await statIfExists(
    path.join(runtimeRealPath, '.locks', `${runId}.lock`),
  ))
}

async function assertExistingPathContained(
  runtimeRealPath: string,
  targetPath: string,
  label: string,
): Promise<void> {
  const targetStat = await lstat(targetPath)
  if (targetStat.isSymbolicLink()) {
    throw new IntegrationGitError('WORKTREE_PATH_UNSAFE', `${label}不能是符号链接`)
  }

  const targetRealPath = await realpath(targetPath)
  assertPathContained(runtimeRealPath, targetRealPath)
}

function assertSafeGitMetadataEntry(
  entryStat: Awaited<ReturnType<typeof lstat>>,
  label: string,
  expectedKind: 'directory' | 'file',
): void {
  const correctKind = expectedKind === 'directory'
    ? entryStat.isDirectory()
    : entryStat.isFile()
  if (entryStat.isSymbolicLink() || !correctKind) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      `${label}不是安全的 Git 元数据${expectedKind === 'directory' ? '目录' : '文件'}`,
    )
  }
  if (
    typeof process.getuid === 'function' &&
    Number(entryStat.uid) !== process.getuid()
  ) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      `${label}不属于当前用户`,
    )
  }
  if (process.platform !== 'win32' && (Number(entryStat.mode) & 0o022) !== 0) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      `${label}不能允许组用户或其他用户写入`,
    )
  }
}

function parseAbsoluteGitMetadataPath(value: string, label: string): string {
  const normalizedValue = value.endsWith('\n') ? value.slice(0, -1) : value
  const withoutCarriageReturn = normalizedValue.endsWith('\r')
    ? normalizedValue.slice(0, -1)
    : normalizedValue
  const platformPath = process.platform === 'win32'
    ? withoutCarriageReturn.replaceAll('/', path.sep)
    : withoutCarriageReturn
  if (
    !platformPath ||
    CONTROL_CHARACTER_PATTERN.test(platformPath) ||
    !path.isAbsolute(platformPath) ||
    path.normalize(platformPath) !== platformPath
  ) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      `${label}未指向规范化绝对路径`,
    )
  }
  return platformPath
}

interface WorktreeRegistration {
  commonGitDir: string
  worktreesRoot: string
  registrationPath: string
  registrationName: string
  device: number
  inode: number
  gitdirDevice: number
  gitdirInode: number
  expectedRepoGitPath: string
}

interface GitWorktreeMetadataRoots {
  commonGitDir: string
  worktreesRoot?: string
}

async function resolveGitWorktreeMetadataRoots(
  repoRoot: string,
): Promise<GitWorktreeMetadataRoots> {
  const commonDirOutput = (await executeGit(repoRoot, [
    'rev-parse',
    '--git-common-dir',
  ])).toString('utf8').trim()
  const commonDirCandidate = path.isAbsolute(commonDirOutput)
    ? commonDirOutput
    : path.resolve(repoRoot, commonDirOutput)
  const commonGitDir = await realpath(commonDirCandidate)
  const commonGitStat = await lstat(commonGitDir)
  assertSafeGitMetadataEntry(commonGitStat, 'Git common dir', 'directory')

  const worktreesRoot = path.join(commonGitDir, 'worktrees')
  const worktreesStat = await statIfExists(worktreesRoot)
  if (!worktreesStat) return { commonGitDir }
  assertSafeGitMetadataEntry(worktreesStat, 'Git worktrees dir', 'directory')
  const worktreesRealPath = await realpath(worktreesRoot)
  if (path.dirname(worktreesRealPath) !== commonGitDir) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      'Git worktrees dir 必须是 common dir 的直接子目录',
    )
  }
  return { commonGitDir, worktreesRoot: worktreesRealPath }
}

async function assertRuntimeSeparatedFromGitTopology(
  repoRoot: string,
  runtimeRealPath: string,
): Promise<void> {
  assertRepoRuntimeSeparate(repoRoot, runtimeRealPath)
  const { commonGitDir, worktreesRoot } =
    await resolveGitWorktreeMetadataRoots(repoRoot)
  assertRepoRuntimeSeparate(commonGitDir, runtimeRealPath)
  if (worktreesRoot) {
    assertRepoRuntimeSeparate(worktreesRoot, runtimeRealPath)
  }
}

async function readRegistrationGitdir(
  registrationPath: string,
): Promise<{
  path: string
  device: number
  inode: number
}> {
  const gitdirPath = path.join(registrationPath, 'gitdir')
  const loaded = await readBoundedStableMetadataFile(
    gitdirPath,
    'worktree registration gitdir',
    MAX_GITDIR_METADATA_BYTES,
    'WORKTREE_PATH_UNSAFE',
    (fileStat) => assertSafeGitMetadataEntry(
      fileStat,
      'worktree registration gitdir',
      'file',
    ),
  )
  const gitdirStat = loaded.stat
  const targetPath = parseAbsoluteGitMetadataPath(
    loaded.payload,
    'worktree registration gitdir',
  )
  return {
    path: targetPath,
    device: Number(gitdirStat.dev),
    inode: Number(gitdirStat.ino),
  }
}

async function findExactWorktreeRegistration(
  repoRoot: string,
  repoPath: string,
): Promise<WorktreeRegistration | undefined> {
  const { commonGitDir, worktreesRoot } = await resolveGitWorktreeMetadataRoots(
    repoRoot,
  )
  if (!worktreesRoot) return undefined
  const expectedRepoGitPath = path.join(repoPath, '.git')
  const matches: WorktreeRegistration[] = []

  for (const registrationName of await readdir(worktreesRoot)) {
    const registrationPath = path.join(worktreesRoot, registrationName)
    if (path.dirname(registrationPath) !== worktreesRoot) continue
    const registrationStat = await lstat(registrationPath)
    if (registrationStat.isSymbolicLink() || !registrationStat.isDirectory()) {
      continue
    }
    assertSafeGitMetadataEntry(
      registrationStat,
      `worktree registration ${registrationName}`,
      'directory',
    )

    let gitdir: Awaited<ReturnType<typeof readRegistrationGitdir>>
    try {
      gitdir = await readRegistrationGitdir(registrationPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (gitdir.path !== expectedRepoGitPath) continue
    matches.push({
      commonGitDir,
      worktreesRoot,
      registrationPath,
      registrationName,
      device: Number(registrationStat.dev),
      inode: Number(registrationStat.ino),
      gitdirDevice: gitdir.device,
      gitdirInode: gitdir.inode,
      expectedRepoGitPath,
    })
  }

  if (matches.length > 1) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      '发现多个指向当前集成 worktree 的 Git registration',
    )
  }
  return matches[0]
}

async function removeIntegrationQuarantineDirectory(
  quarantinePath: string,
): Promise<void> {
  await rm(quarantinePath, {
    recursive: true,
    force: false,
    maxRetries: 5,
    retryDelay: 200,
  })
}

async function quarantineAndRemoveRegistration(
  registration: WorktreeRegistration,
  runId: string,
): Promise<void> {
  const registrationStat = await lstat(registration.registrationPath)
  const gitdir = await readRegistrationGitdir(registration.registrationPath)
  if (
    registrationStat.isSymbolicLink() ||
    registrationStat.dev !== registration.device ||
    registrationStat.ino !== registration.inode ||
    gitdir.device !== registration.gitdirDevice ||
    gitdir.inode !== registration.gitdirInode ||
    gitdir.path !== registration.expectedRepoGitPath
  ) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      '当前 worktree registration 在清理前被替换',
    )
  }

  const quarantineRoot = path.join(
    registration.commonGitDir,
    '.harmony-integration-worktree-quarantine',
  )
  try {
    await mkdir(quarantineRoot, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  assertPrivateDirectory(await lstat(quarantineRoot), 'registration quarantine', true)
  const quarantineRealPath = await realpath(quarantineRoot)
  if (path.dirname(quarantineRealPath) !== registration.commonGitDir) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      'registration quarantine 必须是 common dir 的直接子目录',
    )
  }
  const quarantinePath = path.join(
    quarantineRealPath,
    `${runId}-${randomBytes(32).toString('hex')}`,
  )
  if (path.dirname(quarantinePath) !== quarantineRealPath) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      'registration quarantine 逃逸 worktrees dir',
    )
  }
  await rename(registration.registrationPath, quarantinePath)
  const movedStat = await lstat(quarantinePath)
  if (
    movedStat.dev !== registration.device ||
    movedStat.ino !== registration.inode
  ) {
    try {
      if (!(await statIfExists(registration.registrationPath))) {
        await rename(quarantinePath, registration.registrationPath)
      }
    } catch {
      // Preserve the unexpected entry for manual recovery.
    }
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      '原子隔离的 registration 身份与已验证对象不一致',
    )
  }
  await removeIntegrationQuarantineDirectory(quarantinePath)
}

interface IntegrationRunManifest {
  v: 1
  phase: 'active' | 'cleanup_pending'
  runId: string
  runtimeRealPath: string
  runRoot: string
  repoPath: string
  runRootDevice: number
  runRootInode: number
  repoDevice: number
  repoInode: number
  leaseTokenHash: string
  commonGitDir: string
  worktreesRoot: string
  registrationName: string
  registrationDevice: number
  registrationInode: number
  gitdirDevice: number
  gitdirInode: number
  expectedRepoGitPath: string
  runQuarantineName?: string
  registrationQuarantineName?: string
}

interface LoadedIntegrationRunManifest {
  manifestPath: string
  payload: string
  device: number
  inode: number
  manifest: IntegrationRunManifest
}

function isSerializedFilesystemIdentity(value: unknown): value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) return false
  // Node exposes Windows file IDs as Numbers even when NTFS uses the full
  // unsigned 64-bit range. JSON round-trips the same stable numeric value.
  return process.platform === 'win32' || Number.isSafeInteger(value)
}

function parseIntegrationRunManifest(
  payload: string,
): IntegrationRunManifest | undefined {
  try {
    const value = JSON.parse(payload) as Partial<IntegrationRunManifest>
    if (
      !value ||
      value.v !== 1 ||
      (value.phase !== 'active' && value.phase !== 'cleanup_pending') ||
      typeof value.runId !== 'string' ||
      !SAFE_RUN_ID_PATTERN.test(value.runId) ||
      typeof value.runtimeRealPath !== 'string' ||
      typeof value.runRoot !== 'string' ||
      typeof value.repoPath !== 'string' ||
      !isSerializedFilesystemIdentity(value.runRootDevice) ||
      !isSerializedFilesystemIdentity(value.runRootInode) ||
      !isSerializedFilesystemIdentity(value.repoDevice) ||
      !isSerializedFilesystemIdentity(value.repoInode) ||
      typeof value.leaseTokenHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.leaseTokenHash) ||
      typeof value.commonGitDir !== 'string' ||
      typeof value.worktreesRoot !== 'string' ||
      typeof value.registrationName !== 'string' ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(value.registrationName) ||
      !isSerializedFilesystemIdentity(value.registrationDevice) ||
      !isSerializedFilesystemIdentity(value.registrationInode) ||
      !isSerializedFilesystemIdentity(value.gitdirDevice) ||
      !isSerializedFilesystemIdentity(value.gitdirInode) ||
      typeof value.expectedRepoGitPath !== 'string' ||
      (
        value.phase === 'cleanup_pending' &&
        (
          typeof value.runQuarantineName !== 'string' ||
          !new RegExp(`^\\.cleanup-${value.runId}-[a-f0-9]{64}$`)
            .test(value.runQuarantineName) ||
          typeof value.registrationQuarantineName !== 'string' ||
          !new RegExp(`^${value.runId}-[a-f0-9]{64}$`)
            .test(value.registrationQuarantineName)
        )
      )
    ) {
      return undefined
    }
    return value as IntegrationRunManifest
  } catch {
    return undefined
  }
}

async function ensureIntegrationStateRoot(runtimeRealPath: string): Promise<string> {
  const stateRoot = path.join(runtimeRealPath, '.state')
  assertPathContained(runtimeRealPath, stateRoot)
  try {
    await mkdir(stateRoot, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  assertPrivateDirectory(await lstat(stateRoot), 'integration state', true)
  const stateRealPath = await realpath(stateRoot)
  assertPathContained(runtimeRealPath, stateRealPath)
  return stateRealPath
}

async function writeIntegrationRunManifest(
  runtimeRealPath: string,
  manifest: IntegrationRunManifest,
  replace: boolean,
): Promise<LoadedIntegrationRunManifest> {
  const stateRoot = await ensureIntegrationStateRoot(runtimeRealPath)
  const manifestPath = path.join(stateRoot, `${manifest.runId}.json`)
  const temporaryPath = path.join(
    stateRoot,
    `.tmp-${manifest.runId}-${randomBytes(32).toString('hex')}`,
  )
  assertPathContained(stateRoot, manifestPath)
  assertPathContained(stateRoot, temporaryPath)
  const payload = JSON.stringify(manifest)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let temporaryStat: Awaited<ReturnType<typeof lstat>> | undefined
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(payload, 'utf8')
    await handle.sync()
    temporaryStat = await handle.stat()
    await handle.close()
    handle = undefined
    if (replace) {
      const existing = await lstat(manifestPath)
      assertPrivateLockFile(existing, 'integration manifest')
      await rename(temporaryPath, manifestPath)
    } else {
      await link(temporaryPath, manifestPath)
      await unlink(temporaryPath)
    }
  } catch (error) {
    if (handle) {
      try {
        await handle.close()
      } catch {
        // Preserve the primary manifest error.
      }
    }
    try {
      await unlink(temporaryPath)
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new AggregateError(
          [error, cleanupError],
          'manifest 写入与临时文件清理均失败',
        )
      }
    }
    throw error
  }

  const manifestStat = await lstat(manifestPath)
  assertPrivateLockFile(manifestStat, 'integration manifest')
  if (
    !replace &&
    temporaryStat &&
    (
      manifestStat.dev !== temporaryStat.dev ||
      manifestStat.ino !== temporaryStat.ino
    )
  ) {
    throw new Error('manifest hard-link 发布身份不一致')
  }
  return {
    manifestPath,
    payload,
    device: Number(manifestStat.dev),
    inode: Number(manifestStat.ino),
    manifest,
  }
}

async function loadIntegrationRunManifest(
  runtimeRealPath: string,
  runId: string,
): Promise<LoadedIntegrationRunManifest | undefined> {
  const manifestPath = path.join(runtimeRealPath, '.state', `${runId}.json`)
  const manifestStat = await statIfExists(manifestPath)
  if (!manifestStat) return undefined
  const loaded = await readBoundedStableMetadataFile(
    manifestPath,
    'integration manifest',
    MAX_MANIFEST_METADATA_BYTES,
    'WORKTREE_PATH_UNSAFE',
    (fileStat) => assertPrivateLockFile(fileStat, 'integration manifest'),
  )
  const payload = loaded.payload
  const manifest = parseIntegrationRunManifest(payload)
  if (!manifest) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      'integration manifest 无效或读取期间被替换',
    )
  }
  return {
    manifestPath,
    payload,
    device: Number(loaded.stat.dev),
    inode: Number(loaded.stat.ino),
    manifest,
  }
}

async function removeIntegrationRunManifest(
  loaded: LoadedIntegrationRunManifest,
): Promise<void> {
  const current = await readBoundedStableMetadataFile(
    loaded.manifestPath,
    'integration manifest',
    MAX_MANIFEST_METADATA_BYTES,
    'WORKTREE_PATH_UNSAFE',
    (fileStat) => assertPrivateLockFile(fileStat, 'integration manifest'),
  )
  if (
    current.stat.dev !== loaded.device ||
    current.stat.ino !== loaded.inode ||
    current.payload !== loaded.payload
  ) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      '拒绝删除身份已变化的 integration manifest',
    )
  }
  const releasePath = path.join(
    path.dirname(loaded.manifestPath),
    `.released-${loaded.manifest.runId}-${randomBytes(32).toString('hex')}`,
  )
  await rename(loaded.manifestPath, releasePath)
  const releasedStat = await lstat(releasePath)
  if (
    releasedStat.dev !== loaded.device ||
    releasedStat.ino !== loaded.inode
  ) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      'manifest 隔离后的身份不一致',
    )
  }
  await unlink(releasePath)
}

function registrationFromManifest(
  manifest: IntegrationRunManifest,
): WorktreeRegistration {
  return {
    commonGitDir: manifest.commonGitDir,
    worktreesRoot: manifest.worktreesRoot,
    registrationPath: path.join(
      manifest.worktreesRoot,
      manifest.registrationName,
    ),
    registrationName: manifest.registrationName,
    device: manifest.registrationDevice,
    inode: manifest.registrationInode,
    gitdirDevice: manifest.gitdirDevice,
    gitdirInode: manifest.gitdirInode,
    expectedRepoGitPath: manifest.expectedRepoGitPath,
  }
}

async function assertWorktreeRegistrationIdentity(
  registration: WorktreeRegistration,
  registrationPath = registration.registrationPath,
): Promise<void> {
  const registrationStat = await lstat(registrationPath)
  const gitdir = await readRegistrationGitdir(registrationPath)
  if (
    registrationStat.isSymbolicLink() ||
    registrationStat.dev !== registration.device ||
    registrationStat.ino !== registration.inode ||
    gitdir.device !== registration.gitdirDevice ||
    gitdir.inode !== registration.gitdirInode ||
    gitdir.path !== registration.expectedRepoGitPath
  ) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      'worktree registration 身份或 gitdir 指向已变化',
    )
  }
}

async function validateIntegrationRunManifest(
  loaded: LoadedIntegrationRunManifest,
  runtimeRealPath: string,
  paths: IntegrationWorktreeLocations,
  lock: IntegrationRunLock,
): Promise<void> {
  const manifest = loaded.manifest
  if (
    manifest.runtimeRealPath !== runtimeRealPath ||
    manifest.runRoot !== paths.runRoot ||
    manifest.repoPath !== paths.repoPath ||
    manifest.leaseTokenHash !== lock.leaseTokenHash ||
    manifest.expectedRepoGitPath !== path.join(paths.repoPath, '.git') ||
    manifest.worktreesRoot !== path.join(manifest.commonGitDir, 'worktrees') ||
    path.dirname(
      path.join(manifest.worktreesRoot, manifest.registrationName),
    ) !== manifest.worktreesRoot
  ) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      'integration manifest 与当前 canonical run/lease 不匹配',
    )
  }
  if (
    await realpath(manifest.commonGitDir) !== manifest.commonGitDir ||
    await realpath(manifest.worktreesRoot) !== manifest.worktreesRoot
  ) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      'manifest 中的 Git metadata 路径不是 canonical 路径',
    )
  }
}

async function ensureRegistrationQuarantineRoot(
  commonGitDir: string,
): Promise<string> {
  const quarantineRoot = path.join(
    commonGitDir,
    '.harmony-integration-worktree-quarantine',
  )
  try {
    await mkdir(quarantineRoot, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  assertPrivateDirectory(await lstat(quarantineRoot), 'registration quarantine', true)
  const quarantineRealPath = await realpath(quarantineRoot)
  if (path.dirname(quarantineRealPath) !== commonGitDir) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      'registration quarantine 必须位于 canonical common dir 下',
    )
  }
  return quarantineRealPath
}

async function cleanupIntegrationRunFromManifest(
  runtimeRealPath: string,
  paths: IntegrationWorktreeLocations,
  lock: IntegrationRunLock,
  initiallyLoaded: LoadedIntegrationRunManifest,
): Promise<void> {
  let loaded = initiallyLoaded
  await validateIntegrationRunManifest(loaded, runtimeRealPath, paths, lock)
  let manifest = loaded.manifest
  const registration = registrationFromManifest(manifest)

  if (manifest.phase === 'active') {
    const activeRunStat = await lstat(paths.runRoot)
    const activeRepoStat = await lstat(paths.repoPath)
    if (
      activeRunStat.isSymbolicLink() ||
      !activeRunStat.isDirectory() ||
      activeRunStat.dev !== manifest.runRootDevice ||
      activeRunStat.ino !== manifest.runRootInode ||
      activeRepoStat.isSymbolicLink() ||
      !activeRepoStat.isDirectory() ||
      activeRepoStat.dev !== manifest.repoDevice ||
      activeRepoStat.ino !== manifest.repoInode
    ) {
      throw new IntegrationGitError(
        'WORKTREE_PATH_UNSAFE',
        'active runRoot/repoPath 身份与 manifest 不一致',
      )
    }
    await assertWorktreeRegistrationIdentity(registration)
    manifest = {
      ...manifest,
      phase: 'cleanup_pending',
      runQuarantineName:
        `.cleanup-${manifest.runId}-${randomBytes(32).toString('hex')}`,
      registrationQuarantineName:
        `${manifest.runId}-${randomBytes(32).toString('hex')}`,
    }
    loaded = await writeIntegrationRunManifest(
      runtimeRealPath,
      manifest,
      true,
    )
  }

  const runQuarantinePath = path.join(
    runtimeRealPath,
    manifest.runQuarantineName as string,
  )
  assertPathContained(runtimeRealPath, runQuarantinePath)
  const originalRunStat = await statIfExists(paths.runRoot)
  const existingRunQuarantineStat = await statIfExists(runQuarantinePath)
  if (originalRunStat && existingRunQuarantineStat) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      'runRoot 与计划 quarantine 同时存在',
    )
  }
  if (originalRunStat) {
    await rename(paths.runRoot, runQuarantinePath)
  }
  const runQuarantineStat = await statIfExists(runQuarantinePath)
  if (
    runQuarantineStat &&
    (
      runQuarantineStat.dev !== manifest.runRootDevice ||
      runQuarantineStat.ino !== manifest.runRootInode
    )
  ) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      'run quarantine 身份与 manifest 不一致',
    )
  }
  if (
    runQuarantineStat?.isDirectory() &&
    !runQuarantineStat.isSymbolicLink()
  ) {
    assertPrivateDirectory(runQuarantineStat, 'run quarantine', true)
  } else if (runQuarantineStat && !runQuarantineStat.isSymbolicLink()) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      'run quarantine 不是安全目录或符号链接',
    )
  }

  const registrationQuarantineRoot = await ensureRegistrationQuarantineRoot(
    manifest.commonGitDir,
  )
  const registrationQuarantinePath = path.join(
    registrationQuarantineRoot,
    manifest.registrationQuarantineName as string,
  )
  if (path.dirname(registrationQuarantinePath) !== registrationQuarantineRoot) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      'registration quarantine 路径逃逸',
    )
  }
  const originalRegistrationStat = await statIfExists(
    registration.registrationPath,
  )
  const existingRegistrationQuarantineStat = await statIfExists(
    registrationQuarantinePath,
  )
  if (originalRegistrationStat && existingRegistrationQuarantineStat) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      'registration 与计划 quarantine 同时存在',
    )
  }
  if (originalRegistrationStat) {
    await assertWorktreeRegistrationIdentity(registration)
    await rename(
      registration.registrationPath,
      registrationQuarantinePath,
    )
  }
  const quarantinedRegistrationStat = await statIfExists(
    registrationQuarantinePath,
  )
  if (quarantinedRegistrationStat) {
    assertSafeGitMetadataEntry(
      quarantinedRegistrationStat,
      'quarantined worktree registration',
      'directory',
    )
    if (
      quarantinedRegistrationStat.dev !== registration.device ||
      quarantinedRegistrationStat.ino !== registration.inode
    ) {
      throw new IntegrationGitError(
        'WORKTREE_PATH_UNSAFE',
        'quarantined worktree registration 身份与 manifest 不一致',
      )
    }
    await removeIntegrationQuarantineDirectory(registrationQuarantinePath)
  }
  if (runQuarantineStat) {
    if (runQuarantineStat.isDirectory() && !runQuarantineStat.isSymbolicLink()) {
      await removeIntegrationQuarantineDirectory(runQuarantinePath)
    } else {
      await unlink(runQuarantinePath)
    }
  }
  await removeIntegrationRunManifest(loaded)
}

async function integrationRunResourcesAreFullyRemoved(
  repoRoot: string,
  runtimeRealPath: string,
  paths: IntegrationWorktreeLocations,
  runId: string,
): Promise<boolean> {
  if (await statIfExists(paths.runRoot)) return false
  const runtimeQuarantinePattern = new RegExp(
    `^\\.cleanup-${runId}-[a-f0-9]{64}$`,
  )
  if ((await readdir(runtimeRealPath)).some((name) =>
    runtimeQuarantinePattern.test(name))) {
    return false
  }
  if (await findExactWorktreeRegistration(repoRoot, paths.repoPath)) {
    return false
  }

  const { commonGitDir } = await resolveGitWorktreeMetadataRoots(repoRoot)
  const registrationQuarantineRoot = path.join(
    commonGitDir,
    '.harmony-integration-worktree-quarantine',
  )
  const quarantineRootStat = await statIfExists(registrationQuarantineRoot)
  if (!quarantineRootStat) return true
  assertPrivateDirectory(
    quarantineRootStat,
    'registration quarantine',
    true,
  )
  const registrationQuarantinePattern = new RegExp(
    `^${runId}-[a-f0-9]{64}$`,
  )
  return !(await readdir(registrationQuarantineRoot)).some((name) =>
    registrationQuarantinePattern.test(name))
}

async function validateActiveIntegrationWorktreeInternal(
  input: ValidateIntegrationWorktreeInput,
): Promise<IntegrationWorktreeLocations> {
  validateGitExecutionConfig()
  const repoRoot = await resolveCanonicalGitRepoRoot(input.repoRoot)
  const runtimeRoot = resolveIntegrationRuntimeRoot(input.runtimeRoot)
  const runId = validateRunId(input.runId)
  const prospectiveRuntimeRealPath = await resolveProspectiveRealPath(
    runtimeRoot,
    'WORKTREE_CREATE_FAILED',
  )
  await assertRuntimeSeparatedFromGitTopology(
    repoRoot,
    prospectiveRuntimeRealPath,
  )
  const runtimeRealPath = await resolveSafeRuntimeRootIfExists(runtimeRoot)
  if (!runtimeRealPath) {
    throw new IntegrationGitError(
      'WORKTREE_BUSY',
      `集成运行 ${runId} 的 runtime/lease 不存在`,
    )
  }
  await assertRuntimeSeparatedFromGitTopology(repoRoot, runtimeRealPath)
  const paths = resolveWorktreePaths(runtimeRealPath, runId)
  const lock = await loadIntegrationRunLease(
    runtimeRealPath,
    runId,
    input.leaseToken,
  )
  const loadedManifest = await loadIntegrationRunManifest(
    runtimeRealPath,
    runId,
  )
  if (!loadedManifest) {
    throw new IntegrationGitError(
      'WORKTREE_BUSY',
      `集成运行 ${runId} 缺少 active manifest`,
    )
  }
  await validateIntegrationRunManifest(
    loadedManifest,
    runtimeRealPath,
    paths,
    lock,
  )
  const manifest = loadedManifest.manifest
  if (manifest.phase !== 'active') {
    throw new IntegrationGitError(
      'WORKTREE_BUSY',
      `集成运行 ${runId} 已进入 cleanup_pending，不能继续执行`,
    )
  }

  const runRootStat = await lstat(paths.runRoot)
  const repoStat = await lstat(paths.repoPath)
  assertPrivateDirectory(runRootStat, 'runRoot', true)
  assertSafeGitMetadataEntry(repoStat, 'repoPath', 'directory')
  if (
    runRootStat.dev !== manifest.runRootDevice ||
    runRootStat.ino !== manifest.runRootInode ||
    repoStat.dev !== manifest.repoDevice ||
    repoStat.ino !== manifest.repoInode ||
    await realpath(paths.runRoot) !== paths.runRoot ||
    await realpath(paths.repoPath) !== paths.repoPath
  ) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      'active runRoot/repoPath 身份与 manifest 不一致',
    )
  }

  const registration = registrationFromManifest(manifest)
  await assertWorktreeRegistrationIdentity(registration)
  const exactRegistration = await findExactWorktreeRegistration(
    repoRoot,
    paths.repoPath,
  )
  if (
    !exactRegistration ||
    exactRegistration.commonGitDir !== registration.commonGitDir ||
    exactRegistration.worktreesRoot !== registration.worktreesRoot ||
    exactRegistration.registrationPath !== registration.registrationPath ||
    exactRegistration.device !== registration.device ||
    exactRegistration.inode !== registration.inode ||
    exactRegistration.gitdirDevice !== registration.gitdirDevice ||
    exactRegistration.gitdirInode !== registration.gitdirInode
  ) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      '当前 Git worktree registration 与私有 manifest 不一致',
    )
  }

  const repoGitFile = await readBoundedStableMetadataFile(
    manifest.expectedRepoGitPath,
    'integration worktree .git',
    MAX_GITDIR_METADATA_BYTES,
    'WORKTREE_PATH_UNSAFE',
    (fileStat) => assertSafeGitMetadataEntry(
      fileStat,
      'integration worktree .git',
      'file',
    ),
  )
  const gitFileLine = repoGitFile.payload.replace(/\r?\n$/, '')
  if (!gitFileLine.startsWith('gitdir: ')) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      'integration worktree .git 格式无效',
    )
  }
  const gitDirectory = parseAbsoluteGitMetadataPath(
    gitFileLine.slice('gitdir: '.length),
    'integration worktree .git',
  )
  if (gitDirectory !== registration.registrationPath) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      'integration worktree .git 未指向已登记的私有 registration',
    )
  }

  return paths
}

export async function validateActiveIntegrationWorktree(
  input: ValidateIntegrationWorktreeInput,
): Promise<IntegrationWorktreeLocations> {
  try {
    return await validateActiveIntegrationWorktreeInternal(input)
  } catch (error) {
    if (error instanceof IntegrationGitError) throw error
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      '校验 active 集成 worktree 时发生文件系统错误',
      { cause: error },
    )
  }
}

async function reclaimIntegrationWorktreeLeaseInternal(
  input: ValidateIntegrationWorktreeInput,
  allowCleanupPending: boolean,
): Promise<IntegrationWorktreeLocations> {
  validateGitExecutionConfig()
  const repoRoot = await resolveCanonicalGitRepoRoot(input.repoRoot)
  const runtimeRoot = resolveIntegrationRuntimeRoot(input.runtimeRoot)
  const runId = validateRunId(input.runId)
  if (!/^[a-f0-9]{64}$/.test(input.leaseToken)) {
    throw new IntegrationGitError(
      'WORKTREE_BUSY',
      `集成运行 ${runId} 的 recovery lease 格式无效`,
    )
  }
  const prospectiveRuntimeRealPath = await resolveProspectiveRealPath(
    runtimeRoot,
    'WORKTREE_CLEANUP_FAILED',
  )
  await assertRuntimeSeparatedFromGitTopology(
    repoRoot,
    prospectiveRuntimeRealPath,
  )
  const runtimeRealPath = await resolveSafeRuntimeRootIfExists(runtimeRoot)
  if (!runtimeRealPath) {
    throw new IntegrationGitError(
      'WORKTREE_BUSY',
      `集成运行 ${runId} 的 runtime/lease 不存在`,
    )
  }
  await assertRuntimeSeparatedFromGitTopology(repoRoot, runtimeRealPath)
  const paths = resolveWorktreePaths(runtimeRealPath, runId)
  const lockPath = path.join(runtimeRealPath, '.locks', `${runId}.lock`)
  const loaded = await readBoundedStableMetadataFile(
    lockPath,
    '待恢复运行 lease',
    MAX_RUN_LOCK_METADATA_BYTES,
    'WORKTREE_BUSY',
    (fileStat) => assertPrivateLockFile(fileStat, '待恢复运行 lease'),
  )
  const oldPayload = parseIntegrationRunLockPayload(loaded.payload)
  const leaseTokenHash = hashLeaseToken(input.leaseToken)
  if (
    !oldPayload ||
    oldPayload.runId !== runId ||
    !leaseTokenHashesEqual(oldPayload.leaseTokenHash, leaseTokenHash)
  ) {
    throw new IntegrationGitError(
      'WORKTREE_BUSY',
      `集成运行 ${runId} 的 recovery capability 不匹配`,
    )
  }
  const oldLock: IntegrationRunLock = {
    runId,
    lockPath,
    leaseToken: input.leaseToken,
    leaseTokenHash,
    processStartId: oldPayload.processStartId,
    payload: loaded.payload,
    device: Number(loaded.stat.dev),
    inode: Number(loaded.stat.ino),
  }
  const loadedManifest = await loadIntegrationRunManifest(
    runtimeRealPath,
    runId,
  )
  if (
    !loadedManifest ||
    (
      loadedManifest.manifest.phase !== 'active' &&
      !(allowCleanupPending && loadedManifest.manifest.phase === 'cleanup_pending')
    )
  ) {
    throw new IntegrationGitError(
      'WORKTREE_BUSY',
      `集成运行 ${runId} 不存在可恢复的 manifest`,
    )
  }
  const manifestPhase = loadedManifest.manifest.phase
  await validateIntegrationRunManifest(
    loadedManifest,
    runtimeRealPath,
    paths,
    oldLock,
  )

  const currentProcessStartId = await readCurrentProcessStartIdentity()
  if (
    oldPayload.pid === process.pid &&
    oldPayload.processStartId === currentProcessStartId
  ) {
    return manifestPhase === 'active'
      ? validateActiveIntegrationWorktreeInternal(input)
      : paths
  }
  if (await processIdentityIsAlive(
    oldPayload.pid,
    oldPayload.processStartId,
  )) {
    throw new IntegrationGitError(
      'WORKTREE_BUSY',
      `集成运行 ${runId} 的原执行进程仍存活，拒绝接管`,
    )
  }

  const replacementPayload = JSON.stringify({
    v: 1,
    runId,
    pid: process.pid,
    processStartId: currentProcessStartId,
    leaseTokenHash,
  })
  const locksRoot = path.dirname(lockPath)
  const temporaryPath = path.join(
    locksRoot,
    `.reclaim-${runId}-${randomBytes(32).toString('hex')}`,
  )
  assertPathContained(locksRoot, temporaryPath)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(replacementPayload, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined

    const confirmedOld = await readBoundedStableMetadataFile(
      lockPath,
      '待替换运行 lease',
      MAX_RUN_LOCK_METADATA_BYTES,
      'WORKTREE_BUSY',
      (fileStat) => assertPrivateLockFile(fileStat, '待替换运行 lease'),
    )
    if (
      confirmedOld.stat.dev !== loaded.stat.dev ||
      confirmedOld.stat.ino !== loaded.stat.ino ||
      confirmedOld.payload !== loaded.payload
    ) {
      throw new IntegrationGitError(
        'WORKTREE_BUSY',
        `集成运行 ${runId} 的 lease 在接管期间已变化`,
      )
    }
    await rename(temporaryPath, lockPath)
    const published = await readBoundedStableMetadataFile(
      lockPath,
      '已接管运行 lease',
      MAX_RUN_LOCK_METADATA_BYTES,
      'WORKTREE_BUSY',
      (fileStat) => assertPrivateLockFile(fileStat, '已接管运行 lease'),
    )
    if (published.payload !== replacementPayload) {
      throw new IntegrationGitError(
        'WORKTREE_BUSY',
        `集成运行 ${runId} 的新 lease 发布身份不一致`,
      )
    }
  } finally {
    await handle?.close().catch(() => {})
    await unlink(temporaryPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }

  return manifestPhase === 'active'
    ? validateActiveIntegrationWorktreeInternal(input)
    : paths
}

export async function reclaimActiveIntegrationWorktreeLease(
  input: ValidateIntegrationWorktreeInput,
): Promise<IntegrationWorktreeLocations> {
  try {
    return await reclaimIntegrationWorktreeLeaseInternal(input, false)
  } catch (error) {
    if (error instanceof IntegrationGitError) throw error
    throw new IntegrationGitError(
      'WORKTREE_BUSY',
      '接管崩溃进程的 active 集成 worktree lease 失败',
      { cause: error },
    )
  }
}

export async function reclaimIntegrationWorktreeLeaseForCleanup(
  input: ValidateIntegrationWorktreeInput,
): Promise<IntegrationWorktreeLocations> {
  try {
    return await reclaimIntegrationWorktreeLeaseInternal(input, true)
  } catch (error) {
    if (error instanceof IntegrationGitError) throw error
    throw new IntegrationGitError(
      'WORKTREE_BUSY',
      '接管待清理的集成 worktree lease 失败',
      { cause: error },
    )
  }
}

interface CreatedRunRootIdentity {
  runRoot: string
  device: number
  inode: number
}

interface CreatedRepoIdentity {
  repoPath: string
  device: number
  inode: number
}

async function assertRollbackRunRootOwnership(
  createdRunRoot: CreatedRunRootIdentity,
  actualRunRoot: string,
  createdRepo: CreatedRepoIdentity | undefined,
  createdRegistration: WorktreeRegistration | undefined,
): Promise<void> {
  const runStat = await lstat(actualRunRoot)
  if (
    runStat.isSymbolicLink() ||
    !runStat.isDirectory() ||
    runStat.dev !== createdRunRoot.device ||
    runStat.ino !== createdRunRoot.inode
  ) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      '拒绝回滚身份已变化的本次 runRoot',
    )
  }
  assertPrivateDirectory(runStat, 'rollback runRoot', true)

  const entries = await readdir(actualRunRoot)
  if (!createdRepo && !createdRegistration) {
    if (entries.length !== 0) {
      throw new IntegrationGitError(
        'WORKTREE_PATH_UNSAFE',
        '本次 add 未捕获 owned repo/registration，runRoot 出现未知子项，不能安全回滚',
      )
    }
    return
  }
  if (!createdRepo || !createdRegistration) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      '本次 add 未完整捕获 owned repo 与 registration，不能安全回滚',
    )
  }
  if (
    path.dirname(createdRepo.repoPath) !== createdRunRoot.runRoot ||
    createdRegistration.expectedRepoGitPath !==
      path.join(createdRepo.repoPath, '.git')
  ) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      '本次捕获的 repo/registration 不属于已记录 runRoot',
    )
  }

  const repoName = path.basename(createdRepo.repoPath)
  if (entries.length !== 1 || entries[0] !== repoName) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      'runRoot 含有未明确归属本次 add 的子项，不能安全回滚',
    )
  }
  const actualRepoPath = path.join(actualRunRoot, repoName)
  const repoStat = await lstat(actualRepoPath)
  if (
    repoStat.isSymbolicLink() ||
    !repoStat.isDirectory() ||
    repoStat.dev !== createdRepo.device ||
    repoStat.ino !== createdRepo.inode
  ) {
    throw new IntegrationGitError(
      'WORKTREE_PATH_UNSAFE',
      'rollback repo 身份与本次 add 捕获值不一致',
    )
  }
}

async function rollbackCreatedIntegrationWorktree(
  runtimeRealPath: string,
  runId: string,
  createdRunRoot: CreatedRunRootIdentity | undefined,
  createdRepo: CreatedRepoIdentity | undefined,
  createdRegistration: WorktreeRegistration | undefined,
): Promise<unknown[]> {
  const cleanupErrors: unknown[] = []
  let runQuarantinePath: string | undefined

  if (createdRunRoot) {
    try {
      assertPathContained(runtimeRealPath, createdRunRoot.runRoot)
      await assertRollbackRunRootOwnership(
        createdRunRoot,
        createdRunRoot.runRoot,
        createdRepo,
        createdRegistration,
      )
      runQuarantinePath = path.join(
        runtimeRealPath,
        `.cleanup-${runId}-${randomBytes(32).toString('hex')}`,
      )
      assertPathContained(runtimeRealPath, runQuarantinePath)
      await rename(createdRunRoot.runRoot, runQuarantinePath)
      try {
        await assertRollbackRunRootOwnership(
          createdRunRoot,
          runQuarantinePath,
          createdRepo,
          createdRegistration,
        )
      } catch (error) {
        try {
          if (!(await statIfExists(createdRunRoot.runRoot))) {
            await rename(runQuarantinePath, createdRunRoot.runRoot)
          }
        } catch {
          // Preserve both entries for explicit recovery.
        }
        throw error
      }
    } catch (error) {
      cleanupErrors.push(error)
    }
  }

  if (cleanupErrors.length > 0) return cleanupErrors

  if (createdRegistration) {
    try {
      await quarantineAndRemoveRegistration(createdRegistration, runId)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }

  if (cleanupErrors.length === 0 && runQuarantinePath) {
    try {
      const quarantinedStat = await statIfExists(runQuarantinePath)
      if (quarantinedStat) {
        if (quarantinedStat.isDirectory() && !quarantinedStat.isSymbolicLink()) {
          await removeIntegrationQuarantineDirectory(runQuarantinePath)
        } else {
          await unlink(runQuarantinePath)
        }
      }
    } catch (error) {
      cleanupErrors.push(error)
    }
  }

  return cleanupErrors
}

async function createDetachedIntegrationWorktreeInternal(
  input: CreateIntegrationWorktreeInput,
): Promise<IntegrationWorktreePaths> {
  validateGitExecutionConfig()
  if (
    input.leaseToken !== undefined &&
    !/^[a-f0-9]{64}$/.test(input.leaseToken)
  ) {
    throw new IntegrationGitError(
      'WORKTREE_CREATE_FAILED',
      '预生成的 leaseToken 格式无效',
    )
  }
  const repoRoot = await resolveCanonicalGitRepoRoot(input.repoRoot)
  const runtimeRoot = resolveIntegrationRuntimeRoot(input.runtimeRoot)
  const runId = validateRunId(input.runId)
  const headSha = validateCommitSha(input.headSha)
  await ensureCommitExists(repoRoot, headSha)
  const prospectiveRuntimeRealPath = await resolveProspectiveRealPath(
    runtimeRoot,
    'WORKTREE_CREATE_FAILED',
  )
  await assertRuntimeSeparatedFromGitTopology(
    repoRoot,
    prospectiveRuntimeRealPath,
  )
  const runtimeRealPath = await ensureSafeRuntimeRoot(runtimeRoot)
  await assertRuntimeSeparatedFromGitTopology(repoRoot, runtimeRealPath)
  const paths = resolveWorktreePaths(runtimeRealPath, runId)

  const lock = await acquireIntegrationRunLock(
    runtimeRealPath,
    runId,
    'WORKTREE_CREATE_FAILED',
    input.leaseToken,
  )
  try {
    const preexistingRunRoot = await statIfExists(paths.runRoot)
    if (preexistingRunRoot?.isSymbolicLink()) {
      throw new IntegrationGitError(
        'WORKTREE_PATH_UNSAFE',
        'runRoot 不能是符号链接',
      )
    }
    if (preexistingRunRoot) {
      throw new IntegrationGitError(
        'WORKTREE_PATH_EXISTS',
        '本次运行的 worktree 路径已存在',
      )
    }
    if (await loadIntegrationRunManifest(runtimeRealPath, runId)) {
      throw new IntegrationGitError(
        'WORKTREE_BUSY',
        `集成运行 ${runId} 已存在 manifest；需要显式 recovery`,
      )
    }
    if (!(await integrationRunResourcesAreFullyRemoved(
      repoRoot,
      runtimeRealPath,
      paths,
      runId,
    ))) {
      throw new IntegrationGitError(
        'WORKTREE_BUSY',
        `集成运行 ${runId} 已存在同路径 registration/quarantine 资源`,
      )
    }

    let createdRunRoot: CreatedRunRootIdentity | undefined
    let createdRepo: CreatedRepoIdentity | undefined
    let createdRegistration: WorktreeRegistration | undefined
    return await (async () => {
      const existingRunRoot = await statIfExists(paths.runRoot)
      if (existingRunRoot?.isSymbolicLink()) {
        throw new IntegrationGitError(
          'WORKTREE_PATH_UNSAFE',
          'runRoot 不能是符号链接',
        )
      }
      if (existingRunRoot) {
        throw new IntegrationGitError(
          'WORKTREE_PATH_EXISTS',
          '本次运行的 worktree 路径已存在',
        )
      }

      try {
        await mkdir(paths.runRoot, { mode: 0o700 })
        const createdRunRootStat = await lstat(paths.runRoot)
        assertPrivateDirectory(createdRunRootStat, 'runRoot', true)
        createdRunRoot = {
          runRoot: paths.runRoot,
          device: Number(createdRunRootStat.dev),
          inode: Number(createdRunRootStat.ino),
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          const racedRunRoot = await statIfExists(paths.runRoot)
          if (racedRunRoot?.isSymbolicLink()) {
            throw new IntegrationGitError(
              'WORKTREE_PATH_UNSAFE',
              'runRoot 不能是符号链接',
              { cause: error },
            )
          }
          throw new IntegrationGitError(
            'WORKTREE_PATH_EXISTS',
            '本次运行的 worktree 路径已存在',
            { cause: error },
          )
        }

        throw new IntegrationGitError(
          'WORKTREE_CREATE_FAILED',
          '无法创建本次运行的目录',
          { cause: error },
        )
      }

      try {
        await assertExistingPathContained(
          runtimeRealPath,
          paths.runRoot,
          'runRoot',
        )
        if (await statIfExists(paths.repoPath)) {
          throw new IntegrationGitError(
            'WORKTREE_PATH_EXISTS',
            '本次运行的 repo 路径已存在',
          )
        }
        await executeGit(repoRoot, [
          'worktree',
          'add',
          '--detach',
          paths.repoPath,
          headSha,
        ])
        const createdRepoStat = await lstat(paths.repoPath)
        if (
          createdRepoStat.isSymbolicLink() ||
          !createdRepoStat.isDirectory()
        ) {
          throw new IntegrationGitError(
            'WORKTREE_PATH_UNSAFE',
            'git worktree add 未创建安全 repo 目录',
          )
        }
        createdRepo = {
          repoPath: paths.repoPath,
          device: Number(createdRepoStat.dev),
          inode: Number(createdRepoStat.ino),
        }
        await assertExistingPathContained(
          runtimeRealPath,
          paths.repoPath,
          'repoPath',
        )
        const registration = await findExactWorktreeRegistration(
          repoRoot,
          paths.repoPath,
        )
        if (!registration) {
          throw new IntegrationGitError(
            'WORKTREE_PATH_UNSAFE',
            'Git 未创建可验证的当前 worktree registration',
          )
        }
        const confirmedCreatedRepoStat = await lstat(paths.repoPath)
        if (
          confirmedCreatedRepoStat.isSymbolicLink() ||
          !confirmedCreatedRepoStat.isDirectory() ||
          confirmedCreatedRepoStat.dev !== createdRepo.device ||
          confirmedCreatedRepoStat.ino !== createdRepo.inode
        ) {
          throw new IntegrationGitError(
            'WORKTREE_PATH_UNSAFE',
            'repoPath 在捕获 registration 前被替换',
          )
        }
        createdRegistration = registration
        await executeGit(repoRoot, [
          'worktree',
          'lock',
          '--reason',
          `harmony-integration:${runId}`,
          paths.repoPath,
        ])
        await assertWorktreeRegistrationIdentity(registration)
        const runRootStat = await lstat(paths.runRoot)
        const repoStat = await lstat(paths.repoPath)
        assertPrivateDirectory(runRootStat, 'runRoot', true)
        if (
          repoStat.isSymbolicLink() ||
          !repoStat.isDirectory() ||
          repoStat.dev !== createdRepo.device ||
          repoStat.ino !== createdRepo.inode
        ) {
          throw new IntegrationGitError(
            'WORKTREE_PATH_UNSAFE',
            'repoPath 不是本次 add 捕获的安全目录',
          )
        }
        await writeIntegrationRunManifest(
          runtimeRealPath,
          {
            v: 1,
            phase: 'active',
            runId,
            runtimeRealPath,
            runRoot: paths.runRoot,
            repoPath: paths.repoPath,
            runRootDevice: Number(runRootStat.dev),
            runRootInode: Number(runRootStat.ino),
            repoDevice: Number(repoStat.dev),
            repoInode: Number(repoStat.ino),
            leaseTokenHash: lock.leaseTokenHash,
            commonGitDir: registration.commonGitDir,
            worktreesRoot: registration.worktreesRoot,
            registrationName: registration.registrationName,
            registrationDevice: registration.device,
            registrationInode: registration.inode,
            gitdirDevice: registration.gitdirDevice,
            gitdirInode: registration.gitdirInode,
            expectedRepoGitPath: registration.expectedRepoGitPath,
          },
          false,
        )
        return { ...paths, leaseToken: lock.leaseToken }
      } catch (error) {
        const rollbackErrors = await rollbackCreatedIntegrationWorktree(
          runtimeRealPath,
          runId,
          createdRunRoot,
          createdRepo,
          createdRegistration,
        )
        if (rollbackErrors.length > 0) {
          throw new IntegrationCreateRecoveryRequiredError(
            'WORKTREE_CREATE_FAILED',
            '创建失败且不能安全回滚；运行 lease 已保留，需要显式恢复',
            {
              cause: new AggregateError(
                [error, ...rollbackErrors],
                'worktree 创建与安全回滚均失败',
              ),
            },
          )
        }

        if (error instanceof IntegrationGitError) throw error
        throw new IntegrationGitError(
          'WORKTREE_CREATE_FAILED',
          '创建 detached 集成 worktree 失败',
          { cause: error },
        )
      }
    })()
  } catch (actionError) {
    if (actionError instanceof IntegrationCreateRecoveryRequiredError) {
      throw actionError
    }
    try {
      await releaseIntegrationRunLock(lock)
    } catch (releaseError) {
      throw new IntegrationGitError(
        'WORKTREE_CREATE_FAILED',
        '创建失败且释放运行 lease 失败',
        {
          cause: new AggregateError(
            [actionError, releaseError],
            '创建与 lease 释放均失败',
          ),
        },
      )
    }
    throw actionError
  }
}

export async function createDetachedIntegrationWorktree(
  input: CreateIntegrationWorktreeInput,
): Promise<IntegrationWorktreePaths> {
  try {
    return await createDetachedIntegrationWorktreeInternal(input)
  } catch (error) {
    if (error instanceof IntegrationGitError) throw error
    throw new IntegrationGitError(
      'WORKTREE_CREATE_FAILED',
      '创建 detached 集成 worktree 时发生文件系统错误',
      { cause: error },
    )
  }
}

async function cleanupIntegrationWorktreeInternal(
  input: IntegrationWorktreeInput,
): Promise<void> {
  validateGitExecutionConfig()
  const repoRoot = await resolveCanonicalGitRepoRoot(input.repoRoot)
  const runtimeRoot = resolveIntegrationRuntimeRoot(input.runtimeRoot)
  const runId = validateRunId(input.runId)
  const prospectiveRuntimeRealPath = await resolveProspectiveRealPath(
    runtimeRoot,
    'WORKTREE_CLEANUP_FAILED',
  )
  await assertRuntimeSeparatedFromGitTopology(
    repoRoot,
    prospectiveRuntimeRealPath,
  )
  const runtimeRealPath = await resolveSafeRuntimeRootIfExists(runtimeRoot)
  if (!runtimeRealPath) {
    if (!input.leaseToken) return
    throw new IntegrationGitError(
      'WORKTREE_BUSY',
      `集成运行 ${runId} 的 runtime/lease 不存在`,
    )
  }
  await assertRuntimeSeparatedFromGitTopology(repoRoot, runtimeRealPath)
  const paths = resolveWorktreePaths(runtimeRealPath, runId)
  if (!input.leaseToken) {
    if (await integrationRunLockExists(runtimeRealPath, runId)) {
      throw new IntegrationGitError(
        'WORKTREE_BUSY',
        `集成运行 ${runId} 仍持有 live/stale lease；普通 cleanup fail-closed`,
      )
    }
    if (await loadIntegrationRunManifest(runtimeRealPath, runId)) {
      throw new IntegrationGitError(
        'WORKTREE_BUSY',
        `集成运行 ${runId} 仍存在 active/cleanup_pending manifest`,
      )
    }
    if (await integrationRunResourcesAreFullyRemoved(
      repoRoot,
      runtimeRealPath,
      paths,
      runId,
    )) return
    throw new IntegrationGitError(
      'WORKTREE_BUSY',
      `集成运行 ${runId} 存在待恢复资源；需要显式 recovery 领取后处理`,
    )
  }

  const lock = await loadIntegrationRunLease(
    runtimeRealPath,
    runId,
    input.leaseToken,
  )
  const loadedManifest = await loadIntegrationRunManifest(
    runtimeRealPath,
    runId,
  )
  if (!loadedManifest) {
    if (await integrationRunResourcesAreFullyRemoved(
      repoRoot,
      runtimeRealPath,
      paths,
      runId,
    )) {
      await releaseIntegrationRunLock(lock)
      return
    }
    throw new IntegrationGitError(
      'WORKTREE_CLEANUP_FAILED',
      'live lease 缺少私有 manifest；需要显式 crash recovery',
    )
  }
  let cleanupError: unknown
  try {
      await cleanupIntegrationRunFromManifest(
        runtimeRealPath,
        paths,
        lock,
        loadedManifest,
      )
  } catch (error) {
    cleanupError = error
  }

  if (cleanupError) {
    throw new IntegrationGitError(
      'WORKTREE_CLEANUP_FAILED',
      'cleanup 失败，live lease 已保留；调用方确认 Agent 停止后可用同一 token 重试',
      { cause: cleanupError },
    )
  }

  let releaseError: unknown
  try {
    await releaseIntegrationRunLock(lock)
  } catch (error) {
    releaseError = error
  }
  if (releaseError) {
    throw new IntegrationGitError(
      'WORKTREE_CLEANUP_FAILED',
      'cleanup 结束但释放运行 lease 失败',
      {
        cause: releaseError,
      },
    )
  }
}

export async function cleanupIntegrationWorktree(
  input: IntegrationWorktreeInput,
): Promise<void> {
  try {
    await cleanupIntegrationWorktreeInternal(input)
  } catch (error) {
    if (error instanceof IntegrationGitError) throw error
    throw new IntegrationGitError(
      'WORKTREE_CLEANUP_FAILED',
      '清理集成 worktree 时发生文件系统错误，运行目录已保留',
      { cause: error },
    )
  }
}
