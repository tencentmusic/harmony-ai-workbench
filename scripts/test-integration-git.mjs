#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  IntegrationGitError,
  checkIntegrationMergeConflicts,
  cleanupIntegrationWorktree,
  createDetachedIntegrationWorktree,
  freezeIntegrationGitSnapshot,
  reclaimActiveIntegrationWorktreeLease,
  reclaimIntegrationWorktreeLeaseForCleanup,
  refreshIntegrationBranchTips,
  validateActiveIntegrationWorktree,
} from '../src/server/modules/integration/integration-git.ts'
import * as integrationGit from '../src/server/modules/integration/integration-git.ts'

const projectRoot = path.resolve(import.meta.dirname, '..')
const integrationGitSource = readFileSync(
  path.join(projectRoot, 'src/server/modules/integration/integration-git.ts'),
  'utf8',
)
assert.doesNotMatch(
  integrationGitSource,
  /\bwriteSync\b/,
  'streaming frozen diff writes must not block the Node event loop',
)

function runCreateInIndependentProcess(input) {
  const moduleUrl = pathToFileURL(path.join(
    projectRoot,
    'src/server/modules/integration/integration-git.ts',
  )).href
  const source = `
    import { createDetachedIntegrationWorktree } from ${JSON.stringify(moduleUrl)}
    const input = JSON.parse(process.env.INTEGRATION_GIT_CHILD_INPUT)
    try {
      await createDetachedIntegrationWorktree(input)
      process.stdout.write('UNEXPECTED_SUCCESS')
    } catch (error) {
      process.stdout.write(String(error?.code ?? error?.name ?? 'UNKNOWN'))
    }
  `
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        '--import',
        path.join(projectRoot, 'scripts/register-ts.mjs'),
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        source,
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          INTEGRATION_GIT_CHILD_INPUT: JSON.stringify(input),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString('utf8')))
        return
      }
      resolve(Buffer.concat(stdout).toString('utf8'))
    })
  })
}

function createThenExitInIndependentProcess(input) {
  const moduleUrl = pathToFileURL(path.join(
    projectRoot,
    'src/server/modules/integration/integration-git.ts',
  )).href
  const source = `
    import { createDetachedIntegrationWorktree } from ${JSON.stringify(moduleUrl)}
    const input = JSON.parse(process.env.INTEGRATION_GIT_CHILD_INPUT)
    const created = await createDetachedIntegrationWorktree(input)
    process.stdout.write(JSON.stringify(created))
  `
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        '--import',
        path.join(projectRoot, 'scripts/register-ts.mjs'),
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        source,
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          INTEGRATION_GIT_CHILD_INPUT: JSON.stringify(input),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString('utf8')))
        return
      }
      resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')))
    })
  })
}

function git(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: options.encoding ?? 'utf8',
    stdio: options.stdio,
  })
}

function gitWorktreePaths(cwd) {
  return git(cwd, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
}

function gitWorktreeRecord(cwd, worktreePath) {
  return git(cwd, ['worktree', 'list', '--porcelain'])
    .split('\n\n')
    .find((record) => record.split('\n')[0] === `worktree ${worktreePath}`)
}

async function expectGitError(action, expectedCode) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof IntegrationGitError)
    assert.equal(error.code, expectedCode)
    return true
  })
}

async function captureGitError(action, expectedCode) {
  let captured
  try {
    await action()
  } catch (error) {
    captured = error
  }
  assert.ok(captured instanceof IntegrationGitError)
  assert.equal(captured.code, expectedCode)
  return captured
}

function errorChainText(error, visited = new Set()) {
  if (!error || typeof error !== 'object' || visited.has(error)) return ''
  visited.add(error)
  const messages = []
  if (typeof error.message === 'string') messages.push(error.message)
  if (error.cause) messages.push(errorChainText(error.cause, visited))
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      messages.push(errorChainText(nested, visited))
    }
  }
  return messages.filter(Boolean).join('\n')
}

async function waitForPath(targetPath, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(targetPath)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${targetPath}`)
}

async function waitForProcessExit(pid, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error?.code === 'ESRCH') return
      throw error
    }
    try {
      const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
      if (state.startsWith('Z')) return
    } catch (error) {
      if (error?.status === 1) return
      if (!/operation not permitted/i.test(String(error?.stderr ?? error?.message))) {
        throw error
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Git descendant process ${pid} leaked past timeout`)
}

async function runWindowsIntegrationGitContract() {
  const windowsTempRoot = mkdtempSync(path.join(tmpdir(), 'integration-git-windows-'))
  const repoRoot = path.join(windowsTempRoot, 'repo')
  const runtimeRoot = path.join(windowsTempRoot, 'runtime')
  const runId = 'windows-worktree-contract'
  let created

  try {
    execFileSync('git', ['init', repoRoot], { stdio: 'ignore' })
    git(repoRoot, ['config', 'user.name', 'Integration Test'])
    git(repoRoot, ['config', 'user.email', 'integration-test@example.invalid'])
    writeFileSync(path.join(repoRoot, 'README.md'), 'windows contract\n')
    git(repoRoot, ['add', 'README.md'])
    git(repoRoot, ['commit', '-m', 'windows contract'])

    const headSha = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    created = await createDetachedIntegrationWorktree({
      repoRoot,
      runtimeRoot,
      runId,
      headSha,
    })
    assert.equal(
      readFileSync(path.join(created.repoPath, 'README.md'), 'utf8').trim(),
      'windows contract',
    )
    assert.deepEqual(
      await validateActiveIntegrationWorktree({
        repoRoot,
        runtimeRoot,
        runId,
        leaseToken: created.leaseToken,
      }),
      { runRoot: created.runRoot, repoPath: created.repoPath },
    )

    await cleanupIntegrationWorktree({
      repoRoot,
      runtimeRoot,
      runId,
      leaseToken: created.leaseToken,
    })
    created = undefined
    assert.equal(existsSync(path.join(runtimeRoot, runId)), false)
    assert.equal(
      gitWorktreePaths(repoRoot).some((worktreePath) =>
        path.resolve(worktreePath) === path.resolve(runtimeRoot, runId, 'repo')),
      false,
    )
  } finally {
    if (created) {
      await cleanupIntegrationWorktree({
        repoRoot,
        runtimeRoot,
        runId,
        leaseToken: created.leaseToken,
      }).catch(() => undefined)
    }
    rmSync(windowsTempRoot, { recursive: true, force: true })
  }
}

assert.equal(
  typeof integrationGit.resolveIntegrationRuntimeRoot,
  'function',
  'integration runtime root resolver must be exported',
)

const previousRuntimeRoot = process.env.HARMONY_INTEGRATION_RUNTIME_ROOT
try {
  delete process.env.HARMONY_INTEGRATION_RUNTIME_ROOT
  assert.equal(
    integrationGit.resolveIntegrationRuntimeRoot(),
    path.join(tmpdir(), 'harmony-integration-runs'),
    'runtime root must have a stable OS-temp default',
  )

  process.env.HARMONY_INTEGRATION_RUNTIME_ROOT = ''
  assert.equal(
    integrationGit.resolveIntegrationRuntimeRoot(),
    path.join(tmpdir(), 'harmony-integration-runs'),
    'an empty runtime-root environment value must fall back to the default',
  )

  const envRuntimeRoot = path.join(tmpdir(), 'harmony-integration-runs-env')
  process.env.HARMONY_INTEGRATION_RUNTIME_ROOT = envRuntimeRoot
  assert.equal(integrationGit.resolveIntegrationRuntimeRoot(), envRuntimeRoot)

  const explicitRuntimeRoot = path.join(tmpdir(), 'harmony-integration-runs-explicit')
  assert.equal(
    integrationGit.resolveIntegrationRuntimeRoot(explicitRuntimeRoot),
    explicitRuntimeRoot,
    'explicit runtime root must override the environment',
  )

  assert.throws(
    () => integrationGit.resolveIntegrationRuntimeRoot('relative/runtime'),
    (error) => error instanceof IntegrationGitError && error.code === 'INVALID_RUNTIME_ROOT',
  )
  assert.throws(
    () => integrationGit.resolveIntegrationRuntimeRoot(path.parse(tmpdir()).root),
    (error) => error instanceof IntegrationGitError && error.code === 'INVALID_RUNTIME_ROOT',
  )
} finally {
  if (previousRuntimeRoot === undefined) {
    delete process.env.HARMONY_INTEGRATION_RUNTIME_ROOT
  } else {
    process.env.HARMONY_INTEGRATION_RUNTIME_ROOT = previousRuntimeRoot
  }
}

if (process.platform === 'win32') {
  await runWindowsIntegrationGitContract()
  process.stdout.write('integration git Windows contract tests passed\n')
  process.exit(0)
}

const tempRoot = mkdtempSync(path.join(tmpdir(), 'integration-git-contract-'))
const originRoot = path.join(tempRoot, 'origin.git')
const seedRoot = path.join(tempRoot, 'seed')
const publisherRoot = path.join(tempRoot, 'publisher')
const runtimeRoot = path.join(tempRoot, 'runtime')
const realGitPath = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim()
const gitWrapperRoot = path.join(tempRoot, 'git-wrapper')
const gitWrapperPath = path.join(gitWrapperRoot, 'git')
const previousTestRuntimeRoot = process.env.HARMONY_INTEGRATION_RUNTIME_ROOT
process.env.HARMONY_INTEGRATION_RUNTIME_ROOT = runtimeRoot

try {
  mkdirSync(runtimeRoot, { mode: 0o700 })
  mkdirSync(gitWrapperRoot)
  writeFileSync(
    gitWrapperPath,
    `#!/bin/sh
git_arguments=" $* "
case "$git_arguments" in
  *" worktree add "*) is_worktree_add=1 ;;
  *) is_worktree_add=0 ;;
esac
case "$git_arguments" in
  *" fetch "*) is_fetch=1 ;;
  *) is_fetch=0 ;;
esac
case "$git_arguments" in
  *" diff "*) is_diff=1 ;;
  *) is_diff=0 ;;
esac
case "$git_arguments" in
  *" merge-tree "*) is_merge_tree=1 ;;
  *) is_merge_tree=0 ;;
esac
if [ "$is_worktree_add" = "1" ] && [ "$INTEGRATION_GIT_TEST_FORCE_ADD_FAILURE" = "1" ]; then
  echo "forced worktree add failure" >&2
  exit 71
fi
if [ "$is_worktree_add" = "1" ] && [ "$INTEGRATION_GIT_TEST_PAUSE_ADD" = "1" ]; then
  : > "$INTEGRATION_GIT_TEST_ADD_STARTED_FILE"
  while [ ! -f "$INTEGRATION_GIT_TEST_RELEASE_ADD_FILE" ]; do
    sleep 0.01
  done
fi
if [ "$is_worktree_add" = "1" ] && [ "$INTEGRATION_GIT_TEST_DELAY_ADD" = "1" ]; then
  : > "$INTEGRATION_GIT_TEST_ADD_STARTED_FILE"
  sleep 1
fi
if [ "$is_fetch" = "1" ] && [ "$INTEGRATION_GIT_TEST_SLEEP_FETCH" = "1" ]; then
  printf '%s|%s|%s|%s\n' "$LC_ALL" "$LANG" "$GIT_TERMINAL_PROMPT" "$GCM_INTERACTIVE" > "$INTEGRATION_GIT_TEST_ENV_FILE"
  sleep 5 &
  child=$!
  printf '%s\n' "$child" > "$INTEGRATION_GIT_TEST_CHILD_PID_FILE"
  wait "$child"
fi
if [ "$is_diff" = "1" ] && [ -n "$INTEGRATION_GIT_TEST_DIFF_ARGS_FILE" ]; then
  : > "$INTEGRATION_GIT_TEST_DIFF_ARGS_FILE"
  for argument in "$@"; do
    printf '%s\n' "$argument" >> "$INTEGRATION_GIT_TEST_DIFF_ARGS_FILE"
  done
fi
if [ "$is_diff" = "1" ] && [ "$INTEGRATION_GIT_TEST_STREAM_OVERFLOW" = "1" ]; then
  printf '%s\n' "$$" > "$INTEGRATION_GIT_TEST_STREAM_PID_FILE"
  chunk='xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
  count=0
  while [ "$count" -lt 100 ]; do
    printf '%s' "$chunk"
    printf '%s' "$chunk" >&2
    count=$((count + 1))
    sleep 0.02
  done
  : > "$INTEGRATION_GIT_TEST_STREAM_COMPLETED_FILE"
  exit 0
fi
if [ "$is_merge_tree" = "1" ] && [ "$INTEGRATION_GIT_TEST_FORCE_MERGE_TREE_FAILURE" = "1" ]; then
  echo "forced merge-tree failure" >&2
  exit 72
fi
if [ -n "$INTEGRATION_GIT_TEST_SECRET_CAPTURE" ]; then
  printf '%s|%s|%s|%s|%s\n' "$APP_CIPHER_KEY" "$SUB2API_API_KEY" "$OPENAI_API_KEY" "$OPENCODE_INTEGRATION_SERVER_PASSWORD" "$DATABASE_URL" > "$INTEGRATION_GIT_TEST_SECRET_CAPTURE"
fi
exec "${realGitPath}" "$@"
`,
  )
  chmodSync(gitWrapperPath, 0o755)

  execFileSync('git', ['init', '--bare', originRoot], { stdio: 'ignore' })
  execFileSync('git', ['init', seedRoot], { stdio: 'ignore' })
  git(seedRoot, ['config', 'user.name', 'Integration Test'])
  git(seedRoot, ['config', 'user.email', 'integration-test@example.invalid'])

  mkdirSync(path.join(seedRoot, 'scoped'), { recursive: true })
  writeFileSync(path.join(seedRoot, 'README.md'), 'base\n')
  writeFileSync(path.join(seedRoot, 'scoped', 'inside.txt'), 'inside base\n')
  writeFileSync(path.join(seedRoot, 'outside.txt'), 'outside base\n')
  git(seedRoot, ['add', '.'])
  git(seedRoot, ['commit', '-m', 'base'])
  git(seedRoot, ['branch', '-M', 'develop'])
  git(seedRoot, ['remote', 'add', 'origin', originRoot])
  git(seedRoot, ['push', '-u', 'origin', 'develop'])

  git(seedRoot, ['switch', '-c', 'feature/song-list'])
  writeFileSync(path.join(seedRoot, 'scoped', 'inside.txt'), 'inside feature\n')
  writeFileSync(path.join(seedRoot, 'outside.txt'), 'outside feature\n')
  git(seedRoot, ['add', '.'])
  git(seedRoot, ['commit', '-m', 'feature'])
  git(seedRoot, ['push', '-u', 'origin', 'feature/song-list'])

  const targetTipSha = git(seedRoot, ['rev-parse', 'develop']).trim()
  const staleTrackingSha = git(
    seedRoot,
    ['rev-parse', 'refs/remotes/origin/feature/song-list'],
  ).trim()

  // Advance the source branch from another clone. The seed's origin/* ref is now
  // deliberately stale, so the snapshot can only pass by fetching first.
  execFileSync(
    'git',
    ['clone', '--branch', 'feature/song-list', originRoot, publisherRoot],
    { stdio: 'ignore' },
  )
  git(publisherRoot, ['config', 'user.name', 'Integration Publisher'])
  git(publisherRoot, ['config', 'user.email', 'publisher@example.invalid'])
  writeFileSync(path.join(publisherRoot, 'scoped', 'fetched.txt'), 'fetched remote change\n')
  writeFileSync(
    path.join(publisherRoot, 'scoped', 'large-diff.txt'),
    'streamed diff payload\n'.repeat(4_096),
  )
  git(publisherRoot, ['add', '.'])
  git(publisherRoot, ['commit', '-m', 'advance remote source'])
  git(publisherRoot, ['push', 'origin', 'feature/song-list'])
  const headSha = git(publisherRoot, ['rev-parse', 'HEAD']).trim()
  assert.notEqual(headSha, staleTrackingSha)

  const secretCapturePath = path.join(tempRoot, 'git-secret-environment.txt')
  const sensitiveEnvironment = {
    APP_CIPHER_KEY: process.env.APP_CIPHER_KEY,
    SUB2API_API_KEY: process.env.SUB2API_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENCODE_INTEGRATION_SERVER_PASSWORD:
      process.env.OPENCODE_INTEGRATION_SERVER_PASSWORD,
    DATABASE_URL: process.env.DATABASE_URL,
    PATH: process.env.PATH,
  }
  process.env.APP_CIPHER_KEY = 'must-not-reach-git'
  process.env.SUB2API_API_KEY = 'must-not-reach-git'
  process.env.OPENAI_API_KEY = 'must-not-reach-git'
  process.env.OPENCODE_INTEGRATION_SERVER_PASSWORD = 'a'.repeat(64)
  process.env.DATABASE_URL = 'file:/must-not-reach-git.db'
  process.env.INTEGRATION_GIT_TEST_SECRET_CAPTURE = secretCapturePath
  process.env.PATH = `${gitWrapperRoot}${path.delimiter}${process.env.PATH ?? ''}`
  try {
    await freezeIntegrationGitSnapshot({
      repoRoot: seedRoot,
      runtimeRoot,
      sourceBranch: 'feature/song-list',
      targetBranch: 'develop',
      scopePath: 'scoped',
    })
  } finally {
    delete process.env.INTEGRATION_GIT_TEST_SECRET_CAPTURE
    for (const [name, value] of Object.entries(sensitiveEnvironment)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  assert.equal(
    readFileSync(secretCapturePath, 'utf8'),
    '||||\n',
    'Git subprocesses must not inherit app, model, OpenCode, or database secrets',
  )

  const maliciousHooksRoot = path.join(tempRoot, 'malicious-hooks')
  const hookMarkerPath = path.join(tempRoot, 'post-checkout-executed')
  const hookRuntimeRoot = path.join(tempRoot, 'hook-runtime')
  mkdirSync(maliciousHooksRoot, { mode: 0o700 })
  writeFileSync(
    path.join(maliciousHooksRoot, 'post-checkout'),
    `#!/bin/sh\n: > ${JSON.stringify(hookMarkerPath)}\n`,
    { mode: 0o700 },
  )
  git(seedRoot, ['config', 'core.hooksPath', maliciousHooksRoot])
  let hookWorktree
  const controllerLeaseToken = 'a'.repeat(64)
  try {
    hookWorktree = await createDetachedIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot: hookRuntimeRoot,
      runId: 'hook-disabled',
      headSha,
      leaseToken: controllerLeaseToken,
    })
    assert.equal(
      hookWorktree.leaseToken,
      controllerLeaseToken,
      'Git must honor the controller capability persisted before creation',
    )
    assert.equal(
      existsSync(hookMarkerPath),
      false,
      'git worktree add must override repository-configured hooks',
    )
  } finally {
    if (hookWorktree) {
      await cleanupIntegrationWorktree({
        repoRoot: seedRoot,
        runtimeRoot: hookRuntimeRoot,
        runId: 'hook-disabled',
        leaseToken: hookWorktree.leaseToken,
      })
    }
    git(seedRoot, ['config', '--unset', 'core.hooksPath'])
  }

  const previousMaxChangedFiles =
    process.env.HARMONY_INTEGRATION_MAX_CHANGED_FILES
  process.env.HARMONY_INTEGRATION_MAX_CHANGED_FILES = '1'
  try {
    await expectGitError(
      () => freezeIntegrationGitSnapshot({
        repoRoot: seedRoot,
        runtimeRoot,
        sourceBranch: 'feature/song-list',
        targetBranch: 'develop',
        scopePath: 'scoped',
      }),
      'GIT_DIFF_TOO_MANY_FILES',
    )
  } finally {
    if (previousMaxChangedFiles === undefined) {
      delete process.env.HARMONY_INTEGRATION_MAX_CHANGED_FILES
    } else {
      process.env.HARMONY_INTEGRATION_MAX_CHANGED_FILES =
        previousMaxChangedFiles
    }
  }

  const overflowGitPath = process.env.PATH
  const overflowPidPath = path.join(tempRoot, 'diff-overflow.pid')
  const overflowCompletedPath = path.join(tempRoot, 'diff-overflow.completed')
  const previousOverflowLimit = process.env.HARMONY_INTEGRATION_MAX_DIFF_BYTES
  process.env.PATH = `${gitWrapperRoot}${path.delimiter}${overflowGitPath ?? ''}`
  process.env.HARMONY_INTEGRATION_MAX_DIFF_BYTES = '1024'
  process.env.INTEGRATION_GIT_TEST_STREAM_OVERFLOW = '1'
  process.env.INTEGRATION_GIT_TEST_STREAM_PID_FILE = overflowPidPath
  process.env.INTEGRATION_GIT_TEST_STREAM_COMPLETED_FILE = overflowCompletedPath
  let overflowProducerStartedAt = 0
  try {
    const overflowExpectation = expectGitError(
      () => freezeIntegrationGitSnapshot({
        repoRoot: seedRoot,
        runtimeRoot,
        sourceBranch: 'feature/song-list',
        targetBranch: 'develop',
        scopePath: 'scoped',
      }),
      'GIT_DIFF_TOO_LARGE',
    )
    await Promise.race([
      waitForPath(overflowPidPath, 10_000),
      overflowExpectation.then(() => {
        throw new Error('overflow command settled before publishing its PID marker')
      }),
    ])
    overflowProducerStartedAt = Date.now()
    await overflowExpectation
  } finally {
    process.env.PATH = overflowGitPath
    delete process.env.INTEGRATION_GIT_TEST_STREAM_OVERFLOW
    delete process.env.INTEGRATION_GIT_TEST_STREAM_PID_FILE
    delete process.env.INTEGRATION_GIT_TEST_STREAM_COMPLETED_FILE
    if (previousOverflowLimit === undefined) {
      delete process.env.HARMONY_INTEGRATION_MAX_DIFF_BYTES
    } else {
      process.env.HARMONY_INTEGRATION_MAX_DIFF_BYTES = previousOverflowLimit
    }
  }
  assert.ok(
    Date.now() - overflowProducerStartedAt < 1_500,
    'an overflowing diff producer must be terminated before it finishes output',
  )
  await waitForProcessExit(Number(readFileSync(overflowPidPath, 'utf8').trim()))
  assert.equal(
    existsSync(overflowCompletedPath),
    false,
    'the fake Git process must be killed at the hard diff limit',
  )

  const previousSnapshotGitPath = process.env.PATH
  const diffArgsCapturePath = path.join(tempRoot, 'diff-args.txt')
  process.env.PATH = `${gitWrapperRoot}${path.delimiter}${previousSnapshotGitPath ?? ''}`
  process.env.INTEGRATION_GIT_TEST_DIFF_ARGS_FILE = diffArgsCapturePath
  let scopedSnapshot
  try {
    scopedSnapshot = await freezeIntegrationGitSnapshot({
      repoRoot: seedRoot,
      runtimeRoot,
      sourceBranch: 'feature/song-list',
      targetBranch: 'develop',
      scopePath: 'scoped',
    })
  } finally {
    process.env.PATH = previousSnapshotGitPath
    delete process.env.INTEGRATION_GIT_TEST_DIFF_ARGS_FILE
  }
  const capturedDiffArgs = readFileSync(diffArgsCapturePath, 'utf8').split('\n')
  assert.equal(
    capturedDiffArgs.some((argument) => argument.startsWith('--output=')),
    false,
    'snapshot diff must stream over stdout and never use a disk output target',
  )
  assert.equal(
    capturedDiffArgs.includes('--no-textconv'),
    true,
    'snapshot diff must not execute repository-configured textconv commands',
  )
  assert.equal(
    readdirSync(runtimeRoot).some((name) => name.startsWith('.diff-')),
    false,
    'a successful streamed snapshot must not create a diff directory',
  )
  assert.deepEqual(
    {
      sourceRef: scopedSnapshot.sourceRef,
      targetRef: scopedSnapshot.targetRef,
      targetTipSha: scopedSnapshot.targetTipSha,
      baseSha: scopedSnapshot.baseSha,
      headSha: scopedSnapshot.headSha,
    },
    {
      sourceRef: 'refs/remotes/origin/feature/song-list',
      targetRef: 'refs/remotes/origin/develop',
      targetTipSha,
      baseSha: targetTipSha,
      headSha,
    },
  )
  assert.match(scopedSnapshot.diffHash, /^[a-f0-9]{64}$/)

  const scopedDiff = git(
    seedRoot,
    [
      'diff',
      '--full-index',
      '--no-ext-diff',
      `${targetTipSha}...${headSha}`,
      '--',
      'scoped',
    ],
    { encoding: null },
  )
  assert.equal(
    scopedSnapshot.diffHash,
    createHash('sha256').update(scopedDiff).digest('hex'),
    'diffHash must hash the exact scoped review diff with full blob IDs',
  )

  const repeatedSnapshot = await freezeIntegrationGitSnapshot({
    repoRoot: seedRoot,
    sourceBranch: 'feature/song-list',
    targetBranch: 'develop',
    scopePath: 'scoped',
  })
  assert.deepEqual(repeatedSnapshot, scopedSnapshot, 'the same refs must produce a stable snapshot')

  const unscopedSnapshot = await freezeIntegrationGitSnapshot({
    repoRoot: seedRoot,
    sourceBranch: 'feature/song-list',
    targetBranch: 'develop',
  })
  assert.notEqual(
    unscopedSnapshot.diffHash,
    scopedSnapshot.diffHash,
    'scopePath must be passed after -- and restrict the diff',
  )

  const cleanStatusBefore = git(seedRoot, ['status', '--porcelain=v1'])
  const cleanHeadBefore = git(seedRoot, ['rev-parse', 'HEAD']).trim()
  const cleanWorktreesBefore = gitWorktreePaths(seedRoot)
  assert.deepEqual(
    await checkIntegrationMergeConflicts({
      repoRoot: seedRoot,
      targetTipSha: scopedSnapshot.targetTipSha,
      headSha: scopedSnapshot.headSha,
    }),
    {
      hasConflicts: false,
      conflictPaths: [],
      conflictPathCount: 0,
      conflictPathsTruncated: false,
    },
    'a source branch that cleanly merges into the frozen target must report no conflicts',
  )
  assert.equal(
    git(seedRoot, ['status', '--porcelain=v1']),
    cleanStatusBefore,
    'a clean merge-tree check must not modify the repository worktree or index',
  )
  assert.equal(git(seedRoot, ['rev-parse', 'HEAD']).trim(), cleanHeadBefore)
  assert.deepEqual(gitWorktreePaths(seedRoot), cleanWorktreesBefore)

  const conflictRepoRoot = path.join(tempRoot, 'merge-conflict-repo')
  const unsafeConflictName = 'unsafe-\n-\u001b-[link](javascript:boom)-`.txt'
  const maliciousDriverMarkerPath = path.join(tempRoot, 'malicious-merge-driver-ran')
  const maliciousDriverPath = path.join(tempRoot, 'malicious-merge-driver.sh')
  execFileSync('git', ['init', conflictRepoRoot], { stdio: 'ignore' })
  git(conflictRepoRoot, ['config', 'user.name', 'Conflict Test'])
  git(conflictRepoRoot, ['config', 'user.email', 'conflict@example.invalid'])
  mkdirSync(path.join(conflictRepoRoot, 'driver'))
  writeFileSync(path.join(conflictRepoRoot, 'shared.txt'), 'base\n')
  writeFileSync(path.join(conflictRepoRoot, unsafeConflictName), 'base\n')
  writeFileSync(path.join(conflictRepoRoot, 'driver', 'custom.txt'), 'base\n')
  writeFileSync(
    path.join(conflictRepoRoot, 'driver', '.gitattributes'),
    '*.txt merge=evil\n',
  )
  git(conflictRepoRoot, ['add', '.'])
  git(conflictRepoRoot, ['commit', '-m', 'conflict base'])
  const conflictBaseSha = git(conflictRepoRoot, ['rev-parse', 'HEAD']).trim()

  git(conflictRepoRoot, ['switch', '-c', 'target-conflict'])
  writeFileSync(path.join(conflictRepoRoot, 'shared.txt'), 'target\n')
  writeFileSync(path.join(conflictRepoRoot, unsafeConflictName), 'target\n')
  writeFileSync(path.join(conflictRepoRoot, 'driver', 'custom.txt'), 'target\n')
  git(conflictRepoRoot, ['add', '.'])
  git(conflictRepoRoot, ['commit', '-m', 'target conflict'])
  const conflictTargetSha = git(conflictRepoRoot, ['rev-parse', 'HEAD']).trim()

  git(conflictRepoRoot, ['switch', '-c', 'source-conflict', conflictBaseSha])
  writeFileSync(path.join(conflictRepoRoot, 'shared.txt'), 'source\n')
  writeFileSync(path.join(conflictRepoRoot, unsafeConflictName), 'source\n')
  writeFileSync(path.join(conflictRepoRoot, 'driver', 'custom.txt'), 'source\n')
  git(conflictRepoRoot, ['add', '.'])
  git(conflictRepoRoot, ['commit', '-m', 'source conflict'])
  const conflictHeadSha = git(conflictRepoRoot, ['rev-parse', 'HEAD']).trim()
  writeFileSync(
    maliciousDriverPath,
    `#!/bin/sh\n: > ${JSON.stringify(maliciousDriverMarkerPath)}\nexit 0\n`,
    { mode: 0o700 },
  )
  git(conflictRepoRoot, [
    'config',
    'merge.evil.driver',
    `${maliciousDriverPath} %O %A %B`,
  ])
  writeFileSync(
    path.join(conflictRepoRoot, '.gitattributes'),
    '*.txt merge=union\n',
  )
  const conflictStatusBefore = git(conflictRepoRoot, ['status', '--porcelain=v1'])
  const conflictWorktreesBefore = gitWorktreePaths(conflictRepoRoot)
  const conflictObjectCountBefore = git(conflictRepoRoot, ['count-objects', '-v'])

  const conflictResult = await checkIntegrationMergeConflicts({
    repoRoot: conflictRepoRoot,
    targetTipSha: conflictTargetSha,
    headSha: conflictHeadSha,
  })
  assert.equal(conflictResult.hasConflicts, true)
  assert.equal(conflictResult.conflictPathCount, 3)
  assert.equal(conflictResult.conflictPathsTruncated, false)
  assert.deepEqual(
    [...conflictResult.conflictPaths].sort(),
    [
      'driver/custom.txt',
      'shared.txt',
      'unsafe-\\u000a-\\u001b-\\u005blink\\u005d\\u0028javascript:boom\\u0029-\\u0060.txt',
    ].sort(),
    'exit code 1 must be treated as a successful check and parse NUL-delimited paths',
  )
  assert.equal(
    conflictResult.conflictPaths.some((conflictPath) =>
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029`<>\[\]()]/u.test(conflictPath)),
    false,
    'untrusted conflict filenames must be returned without raw controls or markup delimiters',
  )
  assert.equal(
    existsSync(maliciousDriverMarkerPath),
    false,
    'merge checks must not execute a custom driver from repository configuration',
  )
  assert.equal(
    git(conflictRepoRoot, ['count-objects', '-v']),
    conflictObjectCountBefore,
    'merge-tree result objects must be written only to the temporary isolated object database',
  )
  assert.equal(
    git(conflictRepoRoot, ['status', '--porcelain=v1']),
    conflictStatusBefore,
    'a conflicted merge-tree check must not modify the repository worktree or index',
  )
  assert.equal(git(conflictRepoRoot, ['rev-parse', 'HEAD']).trim(), conflictHeadSha)
  assert.deepEqual(gitWorktreePaths(conflictRepoRoot), conflictWorktreesBefore)

  const manyConflictRepoRoot = path.join(tempRoot, 'many-merge-conflicts-repo')
  execFileSync('git', ['init', manyConflictRepoRoot], { stdio: 'ignore' })
  git(manyConflictRepoRoot, ['config', 'user.name', 'Many Conflicts Test'])
  git(manyConflictRepoRoot, ['config', 'user.email', 'many-conflicts@example.invalid'])
  mkdirSync(path.join(manyConflictRepoRoot, 'many'))
  const manyConflictPath = (index) => path.join(
    'many',
    `group-${String(index).padStart(3, '0')}-${'d'.repeat(180)}`,
    `conflict-${String(index).padStart(3, '0')}-${'f'.repeat(180)}.txt`,
  )
  for (let index = 0; index < 205; index += 1) {
    const relativePath = manyConflictPath(index)
    mkdirSync(path.join(manyConflictRepoRoot, path.dirname(relativePath)), {
      recursive: true,
    })
    writeFileSync(
      path.join(manyConflictRepoRoot, relativePath),
      'base\n',
    )
  }
  git(manyConflictRepoRoot, ['add', '.'])
  git(manyConflictRepoRoot, ['commit', '-m', 'many conflicts base'])
  const manyConflictBaseSha = git(manyConflictRepoRoot, ['rev-parse', 'HEAD']).trim()
  git(manyConflictRepoRoot, ['switch', '-c', 'many-target'])
  for (let index = 0; index < 205; index += 1) {
    writeFileSync(
      path.join(manyConflictRepoRoot, manyConflictPath(index)),
      'target\n',
    )
  }
  git(manyConflictRepoRoot, ['add', '.'])
  git(manyConflictRepoRoot, ['commit', '-m', 'many target conflicts'])
  const manyConflictTargetSha = git(manyConflictRepoRoot, ['rev-parse', 'HEAD']).trim()
  git(manyConflictRepoRoot, ['switch', '-c', 'many-source', manyConflictBaseSha])
  for (let index = 0; index < 205; index += 1) {
    writeFileSync(
      path.join(manyConflictRepoRoot, manyConflictPath(index)),
      'source\n',
    )
  }
  git(manyConflictRepoRoot, ['add', '.'])
  git(manyConflictRepoRoot, ['commit', '-m', 'many source conflicts'])
  const manyConflictHeadSha = git(manyConflictRepoRoot, ['rev-parse', 'HEAD']).trim()
  const manyConflictResult = await checkIntegrationMergeConflicts({
    repoRoot: manyConflictRepoRoot,
    targetTipSha: manyConflictTargetSha,
    headSha: manyConflictHeadSha,
  })
  assert.equal(manyConflictResult.hasConflicts, true)
  assert.equal(manyConflictResult.conflictPathCount, 205)
  assert.ok(manyConflictResult.conflictPaths.length < 200)
  assert.equal(manyConflictResult.conflictPathsTruncated, true)
  assert.ok(
    Buffer.byteLength(JSON.stringify(manyConflictResult.conflictPaths), 'utf8')
      <= 70 * 1_024,
    '对外返回的冲突路径必须有累计字节上限',
  )

  const sha256RepoRoot = path.join(tempRoot, 'sha256-merge-conflict-repo')
  execFileSync('git', ['init', '--object-format=sha256', sha256RepoRoot], {
    stdio: 'ignore',
  })
  git(sha256RepoRoot, ['config', 'user.name', 'SHA256 Conflict Test'])
  git(sha256RepoRoot, ['config', 'user.email', 'sha256-conflict@example.invalid'])
  writeFileSync(path.join(sha256RepoRoot, 'shared.txt'), 'base\n')
  git(sha256RepoRoot, ['add', '.'])
  git(sha256RepoRoot, ['commit', '-m', 'sha256 base'])
  const sha256BaseSha = git(sha256RepoRoot, ['rev-parse', 'HEAD']).trim()
  git(sha256RepoRoot, ['switch', '-c', 'sha256-target'])
  writeFileSync(path.join(sha256RepoRoot, 'shared.txt'), 'target\n')
  git(sha256RepoRoot, ['commit', '-am', 'sha256 target'])
  const sha256TargetSha = git(sha256RepoRoot, ['rev-parse', 'HEAD']).trim()
  git(sha256RepoRoot, ['switch', '-c', 'sha256-source', sha256BaseSha])
  writeFileSync(path.join(sha256RepoRoot, 'shared.txt'), 'source\n')
  git(sha256RepoRoot, ['commit', '-am', 'sha256 source'])
  const sha256HeadSha = git(sha256RepoRoot, ['rev-parse', 'HEAD']).trim()
  const sha256ConflictResult = await checkIntegrationMergeConflicts({
    repoRoot: sha256RepoRoot,
    targetTipSha: sha256TargetSha,
    headSha: sha256HeadSha,
  })
  assert.equal(sha256ConflictResult.hasConflicts, true)
  assert.deepEqual(sha256ConflictResult.conflictPaths, ['shared.txt'])

  const mergeTreeFailurePath = process.env.PATH
  process.env.PATH = `${gitWrapperRoot}${path.delimiter}${mergeTreeFailurePath ?? ''}`
  process.env.INTEGRATION_GIT_TEST_FORCE_MERGE_TREE_FAILURE = '1'
  try {
    await expectGitError(
      () => checkIntegrationMergeConflicts({
        repoRoot: conflictRepoRoot,
        targetTipSha: conflictTargetSha,
        headSha: conflictHeadSha,
      }),
      'MERGE_CONFLICT_CHECK_FAILED',
    )
  } finally {
    delete process.env.INTEGRATION_GIT_TEST_FORCE_MERGE_TREE_FAILURE
    process.env.PATH = mergeTreeFailurePath
  }

  const previousGitMaxBuffer = process.env.HARMONY_INTEGRATION_GIT_MAX_BUFFER_BYTES
  process.env.HARMONY_INTEGRATION_GIT_MAX_BUFFER_BYTES = '1024'
  try {
    const smallBufferSnapshot = await freezeIntegrationGitSnapshot({
      repoRoot: seedRoot,
      sourceBranch: 'feature/song-list',
      targetBranch: 'develop',
      scopePath: 'scoped',
    })
    assert.equal(
      smallBufferSnapshot.diffHash,
      scopedSnapshot.diffHash,
      'diff hashing must not depend on the execFile stdout maxBuffer',
    )
  } finally {
    if (previousGitMaxBuffer === undefined) {
      delete process.env.HARMONY_INTEGRATION_GIT_MAX_BUFFER_BYTES
    } else {
      process.env.HARMONY_INTEGRATION_GIT_MAX_BUFFER_BYTES = previousGitMaxBuffer
    }
  }

  const diffTempEntriesBefore = readdirSync(runtimeRoot)
    .filter((name) => name.startsWith('.diff-'))
    .sort()
  const previousMaxDiffBytes = process.env.HARMONY_INTEGRATION_MAX_DIFF_BYTES
  process.env.HARMONY_INTEGRATION_MAX_DIFF_BYTES = '128'
  try {
    await expectGitError(
      () => freezeIntegrationGitSnapshot({
        repoRoot: seedRoot,
        sourceBranch: 'feature/song-list',
        targetBranch: 'develop',
        scopePath: 'scoped',
      }),
      'GIT_DIFF_TOO_LARGE',
    )
  } finally {
    if (previousMaxDiffBytes === undefined) {
      delete process.env.HARMONY_INTEGRATION_MAX_DIFF_BYTES
    } else {
      process.env.HARMONY_INTEGRATION_MAX_DIFF_BYTES = previousMaxDiffBytes
    }
  }
  assert.deepEqual(
    readdirSync(runtimeRoot)
      .filter((name) => name.startsWith('.diff-'))
      .sort(),
    diffTempEntriesBefore,
    'diff temp directories must be removed after an explicit size-limit failure',
  )

  const previousGitPath = process.env.PATH
  const previousFetchTimeout = process.env.HARMONY_INTEGRATION_GIT_FETCH_TIMEOUT_MS
  const gitEnvironmentCapturePath = path.join(tempRoot, 'git-environment.txt')
  const gitChildPidPath = path.join(tempRoot, 'git-child-pid.txt')
  process.env.PATH = `${gitWrapperRoot}${path.delimiter}${previousGitPath ?? ''}`
  process.env.HARMONY_INTEGRATION_GIT_FETCH_TIMEOUT_MS = '150'
  process.env.INTEGRATION_GIT_TEST_SLEEP_FETCH = '1'
  process.env.INTEGRATION_GIT_TEST_ENV_FILE = gitEnvironmentCapturePath
  process.env.INTEGRATION_GIT_TEST_CHILD_PID_FILE = gitChildPidPath
  const timeoutStartedAt = Date.now()
  try {
    await assert.rejects(
      () => freezeIntegrationGitSnapshot({
        repoRoot: seedRoot,
        sourceBranch: 'feature/song-list',
        targetBranch: 'develop',
      }),
      (error) => {
        assert.ok(error instanceof IntegrationGitError)
        assert.equal(error.code, 'GIT_FETCH_FAILED')
        assert.equal(error.cause?.code, 'GIT_COMMAND_TIMEOUT')
        return true
      },
    )
  } finally {
    delete process.env.INTEGRATION_GIT_TEST_SLEEP_FETCH
    delete process.env.INTEGRATION_GIT_TEST_ENV_FILE
    delete process.env.INTEGRATION_GIT_TEST_CHILD_PID_FILE
    process.env.PATH = previousGitPath
    if (previousFetchTimeout === undefined) {
      delete process.env.HARMONY_INTEGRATION_GIT_FETCH_TIMEOUT_MS
    } else {
      process.env.HARMONY_INTEGRATION_GIT_FETCH_TIMEOUT_MS = previousFetchTimeout
    }
  }
  assert.ok(
    Date.now() - timeoutStartedAt < 2_000,
    'a hung fetch and its process group must be terminated before the hard limit',
  )
  await waitForProcessExit(Number(readFileSync(gitChildPidPath, 'utf8').trim()))
  assert.equal(
    readFileSync(gitEnvironmentCapturePath, 'utf8'),
    'C|C|0|Never\n',
    'Git must run with deterministic locale and no interactive credential prompts',
  )

  const previousLocalTimeout = process.env.HARMONY_INTEGRATION_GIT_TIMEOUT_MS
  process.env.HARMONY_INTEGRATION_GIT_TIMEOUT_MS = '99'
  try {
    await expectGitError(
      () => freezeIntegrationGitSnapshot({
        repoRoot: seedRoot,
        sourceBranch: 'feature/song-list',
        targetBranch: 'develop',
      }),
      'INVALID_GIT_CONFIG',
    )
  } finally {
    if (previousLocalTimeout === undefined) {
      delete process.env.HARMONY_INTEGRATION_GIT_TIMEOUT_MS
    } else {
      process.env.HARMONY_INTEGRATION_GIT_TIMEOUT_MS = previousLocalTimeout
    }
  }

  const snapshotRuntimeInsideRepo = path.join(
    seedRoot,
    'must-not-create-snapshot-runtime',
  )
  await expectGitError(
    () => freezeIntegrationGitSnapshot({
      repoRoot: seedRoot,
      runtimeRoot: snapshotRuntimeInsideRepo,
      sourceBranch: 'feature/song-list',
      targetBranch: 'develop',
    }),
    'REPO_RUNTIME_OVERLAP',
  )
  assert.equal(
    existsSync(snapshotRuntimeInsideRepo),
    false,
    'snapshot overlap rejection must happen before creating a runtime inside the repository',
  )

  await expectGitError(
    () => freezeIntegrationGitSnapshot({
      repoRoot: seedRoot,
      runtimeRoot: tempRoot,
      sourceBranch: 'feature/song-list',
      targetBranch: 'develop',
    }),
    'REPO_RUNTIME_OVERLAP',
  )

  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    const blockedSnapshotParent = path.join(tempRoot, 'blocked-snapshot-runtime')
    mkdirSync(blockedSnapshotParent, { mode: 0o700 })
    chmodSync(blockedSnapshotParent, 0o500)
    try {
      await assert.rejects(
        () => freezeIntegrationGitSnapshot({
          repoRoot: seedRoot,
          runtimeRoot: path.join(blockedSnapshotParent, 'missing-child'),
          sourceBranch: 'feature/song-list',
          targetBranch: 'develop',
        }),
        (error) => {
          assert.ok(error instanceof IntegrationGitError)
          assert.equal(error.code, 'GIT_DIFF_FAILED')
          assert.equal(error.cause?.code, 'EACCES')
          return true
        },
      )
    } finally {
      chmodSync(blockedSnapshotParent, 0o700)
    }
  }

  const runtimeInsideRepo = path.join(seedRoot, 'must-not-create-runtime')
  await expectGitError(
    () => createDetachedIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot: runtimeInsideRepo,
      runId: 'overlap-runtime-in-repo',
      headSha,
    }),
    'REPO_RUNTIME_OVERLAP',
  )
  assert.equal(
    existsSync(runtimeInsideRepo),
    false,
    'rejecting a runtime root inside the repository must not modify the repository',
  )

  await expectGitError(
    () => createDetachedIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot: tempRoot,
      runId: 'overlap-repo-in-runtime',
      headSha,
    }),
    'REPO_RUNTIME_OVERLAP',
  )
  assert.equal(existsSync(path.join(tempRoot, 'overlap-repo-in-runtime')), false)

  await expectGitError(
    () => createDetachedIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot: seedRoot,
      runId: 'overlap-same-path',
      headSha,
    }),
    'REPO_RUNTIME_OVERLAP',
  )

  const repoAlias = path.join(tempRoot, 'repo-alias')
  symlinkSync(seedRoot, repoAlias, 'dir')
  await expectGitError(
    () => createDetachedIntegrationWorktree({
      repoRoot: repoAlias,
      runtimeRoot: seedRoot,
      runId: 'overlap-real-path',
      headSha,
    }),
    'REPO_RUNTIME_OVERLAP',
  )

  const linkedTopologyRepoRoot = path.join(tempRoot, 'linked-topology-repo')
  git(seedRoot, [
    'worktree',
    'add',
    '--detach',
    linkedTopologyRepoRoot,
    headSha,
  ])
  const linkedCommonDirOutput = git(linkedTopologyRepoRoot, [
    'rev-parse',
    '--git-common-dir',
  ]).trim()
  const linkedCommonDir = realpathSync(path.isAbsolute(linkedCommonDirOutput)
    ? linkedCommonDirOutput
    : path.resolve(linkedTopologyRepoRoot, linkedCommonDirOutput))
  const linkedTopologyRuntimeRoots = {
    freeze: path.join(linkedCommonDir, 'integration-runtime-freeze'),
    cleanup: path.join(linkedCommonDir, 'integration-runtime-cleanup'),
    create: path.join(linkedCommonDir, 'integration-runtime-create'),
  }
  const linkedTopologyOutcomes = []
  try {
    await freezeIntegrationGitSnapshot({
      repoRoot: linkedTopologyRepoRoot,
      runtimeRoot: linkedTopologyRuntimeRoots.freeze,
      sourceBranch: 'feature/song-list',
      targetBranch: 'develop',
    })
    linkedTopologyOutcomes.push('SUCCESS')
  } catch (error) {
    linkedTopologyOutcomes.push(error?.code ?? error?.name)
  }
  try {
    await cleanupIntegrationWorktree({
      repoRoot: linkedTopologyRepoRoot,
      runtimeRoot: linkedTopologyRuntimeRoots.cleanup,
      runId: 'linked-topology-cleanup',
    })
    linkedTopologyOutcomes.push('SUCCESS')
  } catch (error) {
    linkedTopologyOutcomes.push(error?.code ?? error?.name)
  }
  let linkedTopologyCreatedWorktree
  try {
    linkedTopologyCreatedWorktree = await createDetachedIntegrationWorktree({
      repoRoot: linkedTopologyRepoRoot,
      runtimeRoot: linkedTopologyRuntimeRoots.create,
      runId: 'linked-topology-create',
      headSha,
    })
    linkedTopologyOutcomes.push('SUCCESS')
  } catch (error) {
    linkedTopologyOutcomes.push(error?.code ?? error?.name)
  }
  const linkedTopologyRuntimeWasCreated = Object.values(
    linkedTopologyRuntimeRoots,
  ).map((candidate) => existsSync(candidate))
  if (linkedTopologyCreatedWorktree) {
    await cleanupIntegrationWorktree({
      repoRoot: linkedTopologyRepoRoot,
      runtimeRoot: linkedTopologyRuntimeRoots.create,
      runId: 'linked-topology-create',
      leaseToken: linkedTopologyCreatedWorktree.leaseToken,
    })
  }
  for (const candidate of Object.values(linkedTopologyRuntimeRoots)) {
    rmSync(candidate, { recursive: true, force: true })
  }
  assert.deepEqual(
    linkedTopologyOutcomes,
    [
      'REPO_RUNTIME_OVERLAP',
      'REPO_RUNTIME_OVERLAP',
      'REPO_RUNTIME_OVERLAP',
    ],
    'linked worktree operations must reject runtime paths inside their shared common Git dir',
  )
  assert.deepEqual(
    linkedTopologyRuntimeWasCreated,
    [false, false, false],
    'Git topology overlap must be rejected before any runtime directory write',
  )
  git(seedRoot, [
    'worktree',
    'remove',
    '--force',
    linkedTopologyRepoRoot,
  ])

  const cleanupWithoutWrites = async (input) => {
    try {
      await cleanupIntegrationWorktree(input)
      return 'SUCCESS'
    } catch (error) {
      return error?.code ?? error?.name
    }
  }
  const absentNoTokenRuntimeRoot = path.join(
    tempRoot,
    'absent-cleanup-no-token',
  )
  const absentWrongTokenRuntimeRoot = path.join(
    tempRoot,
    'absent-cleanup-wrong-token',
  )
  const absentCleanupOutcomes = [
    await cleanupWithoutWrites({
      repoRoot: seedRoot,
      runtimeRoot: absentNoTokenRuntimeRoot,
      runId: 'absent-no-token',
    }),
    await cleanupWithoutWrites({
      repoRoot: seedRoot,
      runtimeRoot: absentWrongTokenRuntimeRoot,
      runId: 'absent-wrong-token',
      leaseToken: '0'.repeat(64),
    }),
  ]
  const absentRuntimeWasCreated = [
    existsSync(absentNoTokenRuntimeRoot),
    existsSync(absentWrongTokenRuntimeRoot),
  ]
  rmSync(absentNoTokenRuntimeRoot, { recursive: true, force: true })
  rmSync(absentWrongTokenRuntimeRoot, { recursive: true, force: true })

  const emptyCleanupRuntimeRoot = path.join(
    tempRoot,
    'empty-cleanup-runtime',
  )
  mkdirSync(emptyCleanupRuntimeRoot, { mode: 0o700 })
  const emptyCleanupOutcomes = [
    await cleanupWithoutWrites({
      repoRoot: seedRoot,
      runtimeRoot: emptyCleanupRuntimeRoot,
      runId: 'empty-no-token',
    }),
    await cleanupWithoutWrites({
      repoRoot: seedRoot,
      runtimeRoot: emptyCleanupRuntimeRoot,
      runId: 'empty-wrong-token',
      leaseToken: '0'.repeat(64),
    }),
  ]
  const emptyRuntimeEntries = readdirSync(emptyCleanupRuntimeRoot)
  rmSync(emptyCleanupRuntimeRoot, { recursive: true, force: false })
  assert.deepEqual(
    {
      absentCleanupOutcomes,
      absentRuntimeWasCreated,
      emptyCleanupOutcomes,
      emptyRuntimeEntries,
    },
    {
      absentCleanupOutcomes: ['SUCCESS', 'WORKTREE_BUSY'],
      absentRuntimeWasCreated: [false, false],
      emptyCleanupOutcomes: ['SUCCESS', 'WORKTREE_BUSY'],
      emptyRuntimeEntries: [],
    },
    'cleanup without a valid lease must never create runtime, lock, state, or quarantine entries',
  )

  await expectGitError(
    () => createDetachedIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot,
      runId: 'invalid-sha-format',
      headSha: 'not-a-complete-sha',
    }),
    'INVALID_COMMIT_SHA',
  )

  await assert.rejects(
    () => createDetachedIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot,
      runId: 'invalid-sha-length',
      headSha: 'a'.repeat(41),
    }),
    (error) => {
      assert.ok(error instanceof IntegrationGitError)
      assert.equal(error.code, 'INVALID_COMMIT_SHA')
      assert.equal(
        error.cause,
        undefined,
        'a 41-character value is a format error, not a missing commit lookup',
      )
      return true
    },
  )

  const missingCommitSha = 'f'.repeat(40)
  await expectGitError(
    () => createDetachedIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot,
      runId: 'missing-commit-sha',
      headSha: missingCommitSha,
    }),
    'INVALID_COMMIT_SHA',
  )
  assert.equal(
    existsSync(path.join(runtimeRoot, 'missing-commit-sha')),
    false,
    'a missing commit must be rejected before a runRoot is created',
  )

  const collisionRepoPath = path.join(runtimeRoot, 'collision', 'repo')
  git(seedRoot, [
    'worktree',
    'add',
    '--detach',
    collisionRepoPath,
    headSha,
  ])
  git(seedRoot, [
    'worktree',
    'lock',
    '--reason',
    'human-offline-collision',
    collisionRepoPath,
  ])
  const collisionGitdirPointer = readFileSync(
    path.join(collisionRepoPath, '.git'),
    'utf8',
  ).trim()
  assert.match(collisionGitdirPointer, /^gitdir: \/.+/)
  const collisionRegistrationPath = realpathSync(
    collisionGitdirPointer.slice('gitdir: '.length),
  )
  rmSync(path.dirname(collisionRepoPath), { recursive: true, force: true })
  const collisionRegistrationBefore = {
    record: gitWorktreeRecord(seedRoot, collisionRepoPath),
    device: statSync(collisionRegistrationPath).dev,
    inode: statSync(collisionRegistrationPath).ino,
    gitdir: readFileSync(
      path.join(collisionRegistrationPath, 'gitdir'),
      'utf8',
    ),
    locked: readFileSync(
      path.join(collisionRegistrationPath, 'locked'),
      'utf8',
    ),
  }
  const collisionAddMarker = path.join(tempRoot, 'collision-add-invoked')
  const collisionPreviousPath = process.env.PATH
  process.env.PATH = `${gitWrapperRoot}${path.delimiter}${collisionPreviousPath ?? ''}`
  process.env.INTEGRATION_GIT_TEST_DELAY_ADD = '1'
  process.env.INTEGRATION_GIT_TEST_ADD_STARTED_FILE = collisionAddMarker
  let collisionError
  try {
    await createDetachedIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot,
      runId: 'collision',
      headSha,
    })
  } catch (error) {
    collisionError = error
  } finally {
    delete process.env.INTEGRATION_GIT_TEST_DELAY_ADD
    delete process.env.INTEGRATION_GIT_TEST_ADD_STARTED_FILE
    process.env.PATH = collisionPreviousPath
  }
  assert.equal(
    existsSync(collisionRegistrationPath),
    true,
    'create rollback must preserve a pre-existing same-path registration',
  )
  assert.deepEqual(
    {
      record: gitWorktreeRecord(seedRoot, collisionRepoPath),
      device: statSync(collisionRegistrationPath).dev,
      inode: statSync(collisionRegistrationPath).ino,
      gitdir: readFileSync(
        path.join(collisionRegistrationPath, 'gitdir'),
        'utf8',
      ),
      locked: readFileSync(
        path.join(collisionRegistrationPath, 'locked'),
        'utf8',
      ),
    },
    collisionRegistrationBefore,
    'create rollback must never claim or delete a pre-existing same-path registration',
  )
  assert.equal(
    existsSync(collisionAddMarker),
    false,
    'a same-path registration collision must be rejected before git worktree add',
  )
  assert.ok(collisionError instanceof IntegrationGitError)
  assert.equal(collisionError.code, 'WORKTREE_BUSY')
  assert.equal(
    existsSync(path.join(runtimeRoot, 'collision')),
    false,
    'collision preflight must not create or quarantine a runRoot',
  )
  rmSync(collisionRegistrationPath, { recursive: true, force: false })

  const addRaceRunRoot = path.join(
    realpathSync(runtimeRoot),
    'add-race-collision',
  )
  const addRaceRepoPath = path.join(addRaceRunRoot, 'repo')
  const addRaceStartedPath = path.join(tempRoot, 'add-race-started')
  const addRaceReleasePath = path.join(tempRoot, 'add-race-release')
  const addRacePreviousPath = process.env.PATH
  process.env.PATH = `${gitWrapperRoot}${path.delimiter}${addRacePreviousPath ?? ''}`
  process.env.INTEGRATION_GIT_TEST_PAUSE_ADD = '1'
  process.env.INTEGRATION_GIT_TEST_ADD_STARTED_FILE = addRaceStartedPath
  process.env.INTEGRATION_GIT_TEST_RELEASE_ADD_FILE = addRaceReleasePath
  let addRaceCreatePromise
  let addRaceError
  let addRaceRegistrationPath
  let addRaceRegistrationBefore
  try {
    addRaceCreatePromise = createDetachedIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot,
      runId: 'add-race-collision',
      headSha,
    })
    await waitForPath(addRaceStartedPath, 10_000)
    execFileSync(realGitPath, [
      '-C',
      seedRoot,
      'worktree',
      'add',
      '--detach',
      addRaceRepoPath,
      headSha,
    ], { stdio: 'ignore' })
    writeFileSync(
      path.join(addRaceRepoPath, 'external-owner.marker'),
      'owned by external worktree\n',
    )
    const addRaceGitdirPointer = readFileSync(
      path.join(addRaceRepoPath, '.git'),
      'utf8',
    ).trim()
    assert.match(addRaceGitdirPointer, /^gitdir: \/.+/)
    addRaceRegistrationPath = realpathSync(
      addRaceGitdirPointer.slice('gitdir: '.length),
    )
    addRaceRegistrationBefore = {
      repoDevice: statSync(addRaceRepoPath).dev,
      repoInode: statSync(addRaceRepoPath).ino,
      registrationDevice: statSync(addRaceRegistrationPath).dev,
      registrationInode: statSync(addRaceRegistrationPath).ino,
      gitdir: readFileSync(
        path.join(addRaceRegistrationPath, 'gitdir'),
        'utf8',
      ),
      record: gitWorktreeRecord(seedRoot, addRaceRepoPath),
    }
    writeFileSync(addRaceReleasePath, 'release\n')
    addRaceError = await captureGitError(
      () => addRaceCreatePromise,
      'WORKTREE_CREATE_FAILED',
    )
  } finally {
    if (!existsSync(addRaceReleasePath)) {
      writeFileSync(addRaceReleasePath, 'release after setup failure\n')
    }
    delete process.env.INTEGRATION_GIT_TEST_PAUSE_ADD
    delete process.env.INTEGRATION_GIT_TEST_ADD_STARTED_FILE
    delete process.env.INTEGRATION_GIT_TEST_RELEASE_ADD_FILE
    process.env.PATH = addRacePreviousPath
    if (addRaceCreatePromise && !addRaceError) {
      await addRaceCreatePromise.catch(() => undefined)
    }
  }
  assert.equal(
    existsSync(addRaceRepoPath),
    true,
    'rollback must not delete a repoPath created externally after preflight',
  )
  assert.equal(
    readFileSync(
      path.join(addRaceRepoPath, 'external-owner.marker'),
      'utf8',
    ),
    'owned by external worktree\n',
  )
  assert.equal(existsSync(addRaceRegistrationPath), true)
  assert.deepEqual(
    {
      repoDevice: statSync(addRaceRepoPath).dev,
      repoInode: statSync(addRaceRepoPath).ino,
      registrationDevice: statSync(addRaceRegistrationPath).dev,
      registrationInode: statSync(addRaceRegistrationPath).ino,
      gitdir: readFileSync(
        path.join(addRaceRegistrationPath, 'gitdir'),
        'utf8',
      ),
      record: gitWorktreeRecord(seedRoot, addRaceRepoPath),
    },
    addRaceRegistrationBefore,
    'unsafe rollback must preserve the external repo and registration identities',
  )
  assert.match(
    errorChainText(addRaceError),
    /不能安全回滚.*lease 已保留.*需要显式恢复/s,
  )
  const addRaceLockPath = path.join(
    realpathSync(runtimeRoot),
    '.locks',
    'add-race-collision.lock',
  )
  assert.doesNotThrow(() => JSON.parse(readFileSync(addRaceLockPath, 'utf8')))
  await expectGitError(
    () => createDetachedIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot,
      runId: 'add-race-collision',
      headSha,
    }),
    'WORKTREE_BUSY',
  )
  assert.equal(existsSync(addRaceRepoPath), true)
  unlinkSync(addRaceLockPath)
  execFileSync(realGitPath, [
    '-C',
    seedRoot,
    'worktree',
    'remove',
    '--force',
    addRaceRepoPath,
  ], { stdio: 'ignore' })
  rmSync(addRaceRunRoot, { recursive: true, force: false })

  const crashedWorktree = await createThenExitInIndependentProcess({
    repoRoot: seedRoot,
    runtimeRoot,
    runId: 'crash-reclaim',
    headSha: scopedSnapshot.headSha,
  })
  await expectGitError(
    () => validateActiveIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot,
      runId: 'crash-reclaim',
      leaseToken: crashedWorktree.leaseToken,
    }),
    'WORKTREE_BUSY',
  )
  assert.deepEqual(
    await reclaimActiveIntegrationWorktreeLease({
      repoRoot: seedRoot,
      runtimeRoot,
      runId: 'crash-reclaim',
      leaseToken: crashedWorktree.leaseToken,
    }),
    {
      runRoot: crashedWorktree.runRoot,
      repoPath: crashedWorktree.repoPath,
    },
    'a new worker must explicitly reclaim a dead process lease before recovery',
  )
  assert.deepEqual(
    await validateActiveIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot,
      runId: 'crash-reclaim',
      leaseToken: crashedWorktree.leaseToken,
    }),
    {
      runRoot: crashedWorktree.runRoot,
      repoPath: crashedWorktree.repoPath,
    },
  )
  await cleanupIntegrationWorktree({
    repoRoot: seedRoot,
    runtimeRoot,
    runId: 'crash-reclaim',
    leaseToken: crashedWorktree.leaseToken,
  })

  const worktree = await createDetachedIntegrationWorktree({
    repoRoot: seedRoot,
    runtimeRoot,
    runId: 'run-001',
    headSha: scopedSnapshot.headSha,
  })
  assert.equal(
    worktree.runRoot,
    path.join(realpathSync(runtimeRoot), 'run-001'),
    'create must return a path rooted at the canonical runtime directory',
  )
  assert.equal(
    worktree.repoPath,
    path.join(realpathSync(runtimeRoot), 'run-001', 'repo'),
  )
  assert.match(
    worktree.leaseToken,
    /^[a-f0-9]{64}$/,
    'create must return an opaque lease token while retaining the run lock',
  )
  const runManifestPath = path.join(
    realpathSync(runtimeRoot),
    '.state',
    'run-001.json',
  )
  const runManifestText = readFileSync(runManifestPath, 'utf8')
  const runManifest = JSON.parse(runManifestText)
  assert.equal(
    runManifest.leaseTokenHash,
    createHash('sha256').update(worktree.leaseToken).digest('hex'),
    'the private manifest must bind the lease by hash',
  )
  assert.equal(
    runManifestText.includes(worktree.leaseToken),
    false,
    'the raw cleanup capability must never be persisted',
  )
  assert.equal(runManifest.runRootDevice, statSync(worktree.runRoot).dev)
  assert.equal(runManifest.runRootInode, statSync(worktree.runRoot).ino)
  assert.equal(runManifest.repoDevice, statSync(worktree.repoPath).dev)
  assert.equal(runManifest.repoInode, statSync(worktree.repoPath).ino)
  if (process.platform !== 'win32') {
    assert.equal(statSync(runManifestPath).mode & 0o777, 0o600)
  }
  if (process.platform !== 'win32') {
    assert.equal(
      statSync(runtimeRoot).mode & 0o777,
      0o700,
      'new runtime roots must be private',
    )
    assert.equal(
      statSync(worktree.runRoot).mode & 0o777,
      0o700,
      'run roots must protect source and generated reports',
    )
    assert.equal(
      statSync(path.join(runtimeRoot, '.locks')).mode & 0o777,
      0o700,
      'the lock directory must be private',
    )
  }
  assert.equal(git(worktree.repoPath, ['rev-parse', 'HEAD']).trim(), headSha)
  assert.throws(
    () => git(worktree.repoPath, ['symbolic-ref', '--quiet', 'HEAD']),
    /Command failed/,
    'integration worktree must have a detached HEAD',
  )
  assert.equal(existsSync(originRoot), true, 'the source repository must remain untouched')
  const canonicalRepoPath = path.join(realpathSync(runtimeRoot), 'run-001', 'repo')
  assert.equal(
    gitWorktreePaths(seedRoot).includes(canonicalRepoPath),
    true,
    'git worktree list must contain the created detached worktree',
  )
  assert.match(
    gitWorktreeRecord(seedRoot, canonicalRepoPath) ?? '',
    /\nlocked harmony-integration:run-001(?:\n|$)/,
    'integration worktrees must be Git-locked before control returns to the Agent',
  )
  assert.deepEqual(
    await validateActiveIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot,
      runId: 'run-001',
      leaseToken: worktree.leaseToken,
    }),
    {
      runRoot: worktree.runRoot,
      repoPath: worktree.repoPath,
    },
    'execution must resolve its worktree from the live run lease instead of trusting a caller path',
  )
  await expectGitError(
    () => validateActiveIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot,
      runId: 'run-001',
      leaseToken: '0'.repeat(64),
    }),
    'WORKTREE_BUSY',
  )

  const offlineHumanWorktreePath = path.join(tempRoot, 'offline-human-worktree')
  const canonicalOfflineHumanWorktreePath = path.join(
    realpathSync(tempRoot),
    'offline-human-worktree',
  )
  git(seedRoot, [
    'worktree',
    'add',
    '--detach',
    offlineHumanWorktreePath,
    headSha,
  ])
  rmSync(offlineHumanWorktreePath, { recursive: true, force: true })
  assert.equal(
    gitWorktreePaths(seedRoot).includes(canonicalOfflineHumanWorktreePath),
    true,
    'the fixture human worktree must remain registered while temporarily offline',
  )

  await expectGitError(
    () => cleanupIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot,
      runId: 'run-001',
    }),
    'WORKTREE_BUSY',
  )
  await expectGitError(
    () => cleanupIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot,
      runId: 'run-001',
      leaseToken: '0'.repeat(64),
    }),
    'WORKTREE_BUSY',
  )
  assert.equal(existsSync(worktree.runRoot), true)
  assert.equal(
    gitWorktreePaths(seedRoot).includes(canonicalRepoPath),
    true,
    'cleanup without the live lease must not mutate the path or registration',
  )

  await cleanupIntegrationWorktree({
    repoRoot: seedRoot,
    runtimeRoot,
    runId: 'run-001',
    leaseToken: worktree.leaseToken,
  })
  assert.equal(existsSync(worktree.runRoot), false)
  assert.equal(existsSync(runManifestPath), false)
  assert.equal(
    gitWorktreePaths(seedRoot).includes(canonicalRepoPath),
    false,
    'successful cleanup must remove the Git worktree registration',
  )
  assert.equal(
    gitWorktreePaths(seedRoot).includes(canonicalOfflineHumanWorktreePath),
    true,
    'integration cleanup must not prune another temporarily offline worktree',
  )
  await cleanupIntegrationWorktree({ repoRoot: seedRoot, runtimeRoot, runId: 'run-001' })
  assert.equal(existsSync(originRoot), true, 'idempotent cleanup must not remove the source repo')

  const commonGitDirOutput = git(seedRoot, [
    'rev-parse',
    '--git-common-dir',
  ]).trim()
  const commonGitDir = realpathSync(path.isAbsolute(commonGitDirOutput)
    ? commonGitDirOutput
    : path.resolve(seedRoot, commonGitDirOutput))
  const orphanedRegistrationQuarantineRoot = path.join(
    commonGitDir,
    '.harmony-integration-worktree-quarantine',
  )
  const orphanedRegistrationQuarantine = path.join(
    orphanedRegistrationQuarantineRoot,
    `orphaned-registration-${'d'.repeat(64)}`,
  )
  mkdirSync(orphanedRegistrationQuarantine, {
    recursive: true,
    mode: 0o700,
  })
  await expectGitError(
    () => cleanupIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot,
      runId: 'orphaned-registration',
    }),
    'WORKTREE_BUSY',
  )
  assert.equal(
    existsSync(orphanedRegistrationQuarantine),
    true,
    'ordinary cleanup must preserve a dedicated registration quarantine for recovery',
  )
  rmSync(orphanedRegistrationQuarantine, { recursive: true, force: false })

  const previousPath = process.env.PATH
  process.env.PATH = `${gitWrapperRoot}${path.delimiter}${previousPath ?? ''}`
  process.env.INTEGRATION_GIT_TEST_FORCE_ADD_FAILURE = '1'
  try {
    await expectGitError(
      () => createDetachedIntegrationWorktree({
        repoRoot: seedRoot,
        runtimeRoot,
        runId: 'forced-add-failure',
        headSha,
      }),
      'WORKTREE_CREATE_FAILED',
    )
  } finally {
    delete process.env.INTEGRATION_GIT_TEST_FORCE_ADD_FAILURE
    process.env.PATH = previousPath
  }
  const failedRepoPath = path.join(
    realpathSync(runtimeRoot),
    'forced-add-failure',
    'repo',
  )
  assert.equal(existsSync(path.join(runtimeRoot, 'forced-add-failure')), false)
  assert.equal(
    gitWorktreePaths(seedRoot).includes(failedRepoPath),
    false,
    'a failed worktree add must leave no Git worktree registration',
  )

  const concurrentRuntimeRoot = path.join(tempRoot, 'concurrent-runtime')
  const addStartedPath = path.join(tempRoot, 'concurrent-add-started')
  let concurrentWorktree
  let firstCreatePromise
  process.env.PATH = `${gitWrapperRoot}${path.delimiter}${previousPath ?? ''}`
  process.env.INTEGRATION_GIT_TEST_DELAY_ADD = '1'
  process.env.INTEGRATION_GIT_TEST_ADD_STARTED_FILE = addStartedPath
  try {
    firstCreatePromise = createDetachedIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot: concurrentRuntimeRoot,
      runId: 'concurrent-run',
      headSha,
    })
    await waitForPath(addStartedPath)
    if (process.platform !== 'win32') {
      assert.equal(
        statSync(
          path.join(concurrentRuntimeRoot, '.locks', 'concurrent-run.lock'),
        ).mode & 0o777,
        0o600,
        'per-run lock files must be private',
      )
    }
    const publishedLockPayload = JSON.parse(readFileSync(
      path.join(concurrentRuntimeRoot, '.locks', 'concurrent-run.lock'),
      'utf8',
    ))
    assert.deepEqual(
      Object.keys(publishedLockPayload).sort(),
      ['leaseTokenHash', 'pid', 'processStartId', 'runId', 'v'],
      'the canonical lock must appear only as a complete identity-bound payload',
    )
    assert.equal(publishedLockPayload.runId, 'concurrent-run')
    assert.match(publishedLockPayload.processStartId, /^(?:linux|darwin|win32):/)
    assert.match(publishedLockPayload.leaseTokenHash, /^[a-f0-9]{64}$/)
    await expectGitError(
      () => createDetachedIntegrationWorktree({
        repoRoot: seedRoot,
        runtimeRoot: concurrentRuntimeRoot,
        runId: 'concurrent-run',
        headSha,
      }),
      'WORKTREE_BUSY',
    )
    concurrentWorktree = await firstCreatePromise
  } finally {
    delete process.env.INTEGRATION_GIT_TEST_DELAY_ADD
    delete process.env.INTEGRATION_GIT_TEST_ADD_STARTED_FILE
    process.env.PATH = previousPath
    if (firstCreatePromise && !concurrentWorktree) {
      await firstCreatePromise.catch(() => undefined)
    }
  }
  await cleanupIntegrationWorktree({
    repoRoot: seedRoot,
    runtimeRoot: concurrentRuntimeRoot,
    runId: 'concurrent-run',
    leaseToken: concurrentWorktree.leaseToken,
  })
  assert.equal(
    existsSync(path.join(concurrentRuntimeRoot, '.locks', 'concurrent-run.lock')),
    false,
    'the owner must release its own per-run lock',
  )

  const occupiedRuntimeRoot = path.join(tempRoot, 'occupied-lock-runtime')
  const occupiedLocksRoot = path.join(occupiedRuntimeRoot, '.locks')
  const occupiedLockPath = path.join(occupiedLocksRoot, 'occupied-run.lock')
  mkdirSync(occupiedLocksRoot, { recursive: true, mode: 0o700 })
  writeFileSync(occupiedLockPath, 'foreign-token', { mode: 0o600 })
  await expectGitError(
    () => createDetachedIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot: occupiedRuntimeRoot,
      runId: 'occupied-run',
      headSha,
    }),
    'WORKTREE_BUSY',
  )
  assert.equal(
    readFileSync(occupiedLockPath, 'utf8'),
    'foreign-token',
    'a caller that does not own the lock must never release or overwrite it',
  )

  const staleRuntimeRoot = path.join(tempRoot, 'stale-lock-runtime')
  const staleLocksRoot = path.join(staleRuntimeRoot, '.locks')
  const staleLockPath = path.join(staleLocksRoot, 'stale-run.lock')
  const stalePid = 99_999_999
  assert.throws(
    () => process.kill(stalePid, 0),
    (error) => error?.code === 'ESRCH',
    'the stale-lock fixture PID must not exist',
  )
  mkdirSync(staleLocksRoot, { recursive: true, mode: 0o700 })
  writeFileSync(
    staleLockPath,
    JSON.stringify({ pid: stalePid, token: 'a'.repeat(64) }),
    { mode: 0o600 },
  )
  utimesSync(staleLockPath, new Date(0), new Date(0))
  const staleLockContents = readFileSync(staleLockPath, 'utf8')
  const staleChildInput = {
    repoRoot: seedRoot,
    runtimeRoot: staleRuntimeRoot,
    runId: 'stale-run',
    headSha,
  }
  assert.deepEqual(
    await Promise.all([
      runCreateInIndependentProcess(staleChildInput),
      runCreateInIndependentProcess(staleChildInput),
    ]),
    ['WORKTREE_BUSY', 'WORKTREE_BUSY'],
    'independent ordinary callers must both fail closed on a stale canonical lock',
  )
  assert.equal(
    readFileSync(staleLockPath, 'utf8'),
    staleLockContents,
    'ordinary callers must never reclaim or move a stale/malformed canonical lock',
  )

  const identityMismatchRuntimeRoot = path.join(
    tempRoot,
    'identity-mismatch-runtime',
  )
  const identityMismatchLocksRoot = path.join(
    identityMismatchRuntimeRoot,
    '.locks',
  )
  const identityMismatchLockPath = path.join(
    identityMismatchLocksRoot,
    'identity-mismatch.lock',
  )
  mkdirSync(identityMismatchLocksRoot, { recursive: true, mode: 0o700 })
  const identityMismatchPayload = JSON.stringify({
    v: 1,
    runId: 'identity-mismatch',
    pid: process.pid,
    processStartId: 'darwin:not-this-process-start',
    leaseTokenHash: 'b'.repeat(64),
  })
  writeFileSync(identityMismatchLockPath, identityMismatchPayload, {
    mode: 0o600,
  })
  await expectGitError(
    () => createDetachedIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot: identityMismatchRuntimeRoot,
      runId: 'identity-mismatch',
      headSha,
    }),
    'WORKTREE_BUSY',
  )
  assert.equal(
    readFileSync(identityMismatchLockPath, 'utf8'),
    identityMismatchPayload,
    'PID reuse/start-identity mismatch must never trigger automatic lock recovery',
  )

  const halfWriteRuntimeRoot = path.join(tempRoot, 'half-write-runtime')
  const halfWriteLocksRoot = path.join(halfWriteRuntimeRoot, '.locks')
  const halfWriteTempPath = path.join(
    halfWriteLocksRoot,
    `.tmp-half-write-${'c'.repeat(64)}`,
  )
  mkdirSync(halfWriteLocksRoot, { recursive: true, mode: 0o700 })
  writeFileSync(halfWriteTempPath, '{"v":1', { mode: 0o600 })
  const halfWriteWorktree = await createDetachedIntegrationWorktree({
    repoRoot: seedRoot,
    runtimeRoot: halfWriteRuntimeRoot,
    runId: 'half-write',
    headSha,
  })
  assert.equal(
    readFileSync(halfWriteTempPath, 'utf8'),
    '{"v":1',
    'a crashed unpublished temp file must not be mistaken for the canonical lock',
  )
  assert.doesNotThrow(() => JSON.parse(readFileSync(
    path.join(halfWriteLocksRoot, 'half-write.lock'),
    'utf8',
  )))
  await cleanupIntegrationWorktree({
    repoRoot: seedRoot,
    runtimeRoot: halfWriteRuntimeRoot,
    runId: 'half-write',
    leaseToken: halfWriteWorktree.leaseToken,
  })

  const oversizedMetadataPayload = 'x'.repeat(2 * 1024 * 1024)
  const oversizedMetadataErrors = []

  const oversizedLeaseRuntimeRoot = path.join(
    tempRoot,
    'oversized-lease-runtime',
  )
  const oversizedLeaseWorktree = await createDetachedIntegrationWorktree({
    repoRoot: seedRoot,
    runtimeRoot: oversizedLeaseRuntimeRoot,
    runId: 'oversized-lease',
    headSha,
  })
  const oversizedLeasePath = path.join(
    realpathSync(oversizedLeaseRuntimeRoot),
    '.locks',
    'oversized-lease.lock',
  )
  const originalLeasePayload = readFileSync(oversizedLeasePath, 'utf8')
  writeFileSync(oversizedLeasePath, oversizedMetadataPayload)
  oversizedMetadataErrors.push(await captureGitError(
    () => cleanupIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot: oversizedLeaseRuntimeRoot,
      runId: 'oversized-lease',
      leaseToken: oversizedLeaseWorktree.leaseToken,
    }),
    'WORKTREE_BUSY',
  ))
  assert.equal(
    existsSync(oversizedLeaseWorktree.runRoot),
    true,
    'an oversized lease must be rejected before cleanup mutates run resources',
  )
  writeFileSync(oversizedLeasePath, originalLeasePayload)
  await cleanupIntegrationWorktree({
    repoRoot: seedRoot,
    runtimeRoot: oversizedLeaseRuntimeRoot,
    runId: 'oversized-lease',
    leaseToken: oversizedLeaseWorktree.leaseToken,
  })

  const oversizedManifestRuntimeRoot = path.join(
    tempRoot,
    'oversized-manifest-runtime',
  )
  const oversizedManifestWorktree = await createDetachedIntegrationWorktree({
    repoRoot: seedRoot,
    runtimeRoot: oversizedManifestRuntimeRoot,
    runId: 'oversized-manifest',
    headSha,
  })
  const oversizedManifestPath = path.join(
    realpathSync(oversizedManifestRuntimeRoot),
    '.state',
    'oversized-manifest.json',
  )
  const originalManifestPayload = readFileSync(oversizedManifestPath, 'utf8')
  writeFileSync(oversizedManifestPath, oversizedMetadataPayload)
  oversizedMetadataErrors.push(await captureGitError(
    () => cleanupIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot: oversizedManifestRuntimeRoot,
      runId: 'oversized-manifest',
      leaseToken: oversizedManifestWorktree.leaseToken,
    }),
    'WORKTREE_PATH_UNSAFE',
  ))
  assert.equal(
    existsSync(oversizedManifestWorktree.runRoot),
    true,
    'an oversized manifest must be rejected before cleanup mutates run resources',
  )
  writeFileSync(oversizedManifestPath, originalManifestPayload)
  await cleanupIntegrationWorktree({
    repoRoot: seedRoot,
    runtimeRoot: oversizedManifestRuntimeRoot,
    runId: 'oversized-manifest',
    leaseToken: oversizedManifestWorktree.leaseToken,
  })

  const oversizedGitdirRuntimeRoot = path.join(
    tempRoot,
    'oversized-gitdir-runtime',
  )
  const oversizedGitdirWorktree = await createDetachedIntegrationWorktree({
    repoRoot: seedRoot,
    runtimeRoot: oversizedGitdirRuntimeRoot,
    runId: 'oversized-gitdir',
    headSha,
  })
  const oversizedGitdirManifest = JSON.parse(readFileSync(
    path.join(
      realpathSync(oversizedGitdirRuntimeRoot),
      '.state',
      'oversized-gitdir.json',
    ),
    'utf8',
  ))
  const oversizedRegistrationPath = path.join(
    oversizedGitdirManifest.worktreesRoot,
    oversizedGitdirManifest.registrationName,
  )
  const oversizedGitdirPath = path.join(
    oversizedRegistrationPath,
    'gitdir',
  )
  const originalGitdirPayload = readFileSync(oversizedGitdirPath, 'utf8')
  writeFileSync(oversizedGitdirPath, oversizedMetadataPayload)
  oversizedMetadataErrors.push(await captureGitError(
    () => cleanupIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot: oversizedGitdirRuntimeRoot,
      runId: 'oversized-gitdir',
      leaseToken: oversizedGitdirWorktree.leaseToken,
    }),
    'WORKTREE_CLEANUP_FAILED',
  ))
  assert.equal(existsSync(oversizedGitdirWorktree.runRoot), true)
  assert.equal(
    existsSync(oversizedRegistrationPath),
    true,
    'an oversized registration gitdir must not cause its registration to be removed',
  )
  writeFileSync(oversizedGitdirPath, originalGitdirPayload)
  await cleanupIntegrationWorktree({
    repoRoot: seedRoot,
    runtimeRoot: oversizedGitdirRuntimeRoot,
    runId: 'oversized-gitdir',
    leaseToken: oversizedGitdirWorktree.leaseToken,
  })

  assert.deepEqual(
    oversizedMetadataErrors.map((error) =>
      /元数据文件超过 [0-9]+ 字节上限/.test(errorChainText(error))),
    [true, true, true],
    'lease, manifest, and registration gitdir must reject oversize before reading payloads',
  )

  const partialRegistrationRuntimeRoot = path.join(
    tempRoot,
    'partial-registration-runtime',
  )
  const partialRegistrationWorktree = await createThenExitInIndependentProcess({
    repoRoot: seedRoot,
    runtimeRoot: partialRegistrationRuntimeRoot,
    runId: 'partial-registration',
    headSha,
  })
  const partialRegistrationRuntimeRealPath = realpathSync(
    partialRegistrationRuntimeRoot,
  )
  const partialRegistrationManifestPath = path.join(
    partialRegistrationRuntimeRealPath,
    '.state',
    'partial-registration.json',
  )
  const partialRegistrationManifest = JSON.parse(readFileSync(
    partialRegistrationManifestPath,
    'utf8',
  ))
  partialRegistrationManifest.phase = 'cleanup_pending'
  partialRegistrationManifest.runQuarantineName =
    `.cleanup-partial-registration-${'e'.repeat(64)}`
  partialRegistrationManifest.registrationQuarantineName =
    `partial-registration-${'f'.repeat(64)}`
  writeFileSync(
    partialRegistrationManifestPath,
    JSON.stringify(partialRegistrationManifest),
  )
  const partialRunQuarantinePath = path.join(
    partialRegistrationRuntimeRealPath,
    partialRegistrationManifest.runQuarantineName,
  )
  renameSync(
    partialRegistrationWorktree.runRoot,
    partialRunQuarantinePath,
  )
  const partialRegistrationOriginalPath = path.join(
    partialRegistrationManifest.worktreesRoot,
    partialRegistrationManifest.registrationName,
  )
  const partialRegistrationQuarantineRoot = path.join(
    partialRegistrationManifest.commonGitDir,
    '.harmony-integration-worktree-quarantine',
  )
  mkdirSync(partialRegistrationQuarantineRoot, {
    recursive: true,
    mode: 0o700,
  })
  const partialRegistrationQuarantinePath = path.join(
    partialRegistrationQuarantineRoot,
    partialRegistrationManifest.registrationQuarantineName,
  )
  renameSync(
    partialRegistrationOriginalPath,
    partialRegistrationQuarantinePath,
  )
  assert.deepEqual(
    await reclaimIntegrationWorktreeLeaseForCleanup({
      repoRoot: seedRoot,
      runtimeRoot: partialRegistrationRuntimeRoot,
      runId: 'partial-registration',
      leaseToken: partialRegistrationWorktree.leaseToken,
    }),
    {
      runRoot: partialRegistrationWorktree.runRoot,
      repoPath: partialRegistrationWorktree.repoPath,
    },
    'cleanup recovery must reclaim a cleanup_pending manifest with the same capability',
  )
  assert.equal(
    statSync(partialRegistrationQuarantinePath).ino,
    partialRegistrationManifest.registrationInode,
  )
  unlinkSync(path.join(partialRegistrationQuarantinePath, 'gitdir'))
  const unrelatedRegistrationQuarantine = path.join(
    partialRegistrationQuarantineRoot,
    `unrelated-registration-${'a'.repeat(64)}`,
  )
  mkdirSync(unrelatedRegistrationQuarantine, { mode: 0o700 })

  await cleanupIntegrationWorktree({
    repoRoot: seedRoot,
    runtimeRoot: partialRegistrationRuntimeRoot,
    runId: 'partial-registration',
    leaseToken: partialRegistrationWorktree.leaseToken,
  })
  assert.equal(existsSync(partialRunQuarantinePath), false)
  assert.equal(existsSync(partialRegistrationQuarantinePath), false)
  assert.equal(existsSync(partialRegistrationManifestPath), false)
  assert.equal(
    existsSync(unrelatedRegistrationQuarantine),
    true,
    'cleanup retry must delete only the inode claimed by this manifest',
  )
  rmSync(unrelatedRegistrationQuarantine, { recursive: true, force: false })

  assert.match(
    integrationGitSource,
    /async function removeIntegrationQuarantineDirectory[\s\S]*maxRetries:\s*[1-9][0-9]*[\s\S]*retryDelay:\s*[1-9][0-9]*/,
    'quarantine deletion must retry bounded transient filesystem failures',
  )

  const previousExecutionRuntimeRoot = process.env.HARMONY_INTEGRATION_RUNTIME_ROOT
  const envExecutionRuntimeRoot = path.join(tempRoot, 'env-execution-runtime')
  process.env.HARMONY_INTEGRATION_RUNTIME_ROOT = envExecutionRuntimeRoot
  try {
    const envWorktree = await createDetachedIntegrationWorktree({
      repoRoot: seedRoot,
      runId: 'env-runtime-root',
      headSha,
    })
    assert.equal(
      envWorktree.repoPath,
      path.join(
        realpathSync(envExecutionRuntimeRoot),
        'env-runtime-root',
        'repo',
      ),
      'create must resolve an omitted runtimeRoot through the shared resolver',
    )
    await cleanupIntegrationWorktree({
      repoRoot: seedRoot,
      runId: 'env-runtime-root',
      leaseToken: envWorktree.leaseToken,
    })
    assert.equal(existsSync(envWorktree.runRoot), false)
  } finally {
    if (previousExecutionRuntimeRoot === undefined) {
      delete process.env.HARMONY_INTEGRATION_RUNTIME_ROOT
    } else {
      process.env.HARMONY_INTEGRATION_RUNTIME_ROOT = previousExecutionRuntimeRoot
    }
  }

  const existingRunRoot = path.join(runtimeRoot, 'already-exists')
  mkdirSync(existingRunRoot, { mode: 0o700 })
  await expectGitError(
    () => createDetachedIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot,
      runId: 'already-exists',
      headSha,
    }),
    'WORKTREE_PATH_EXISTS',
  )
  rmSync(existingRunRoot, { recursive: true, force: true })

  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    const blockedRuntimeRoot = path.join(tempRoot, 'blocked-runtime')
    mkdirSync(blockedRuntimeRoot)
    chmodSync(blockedRuntimeRoot, 0o500)
    try {
      await expectGitError(
        () => createDetachedIntegrationWorktree({
          repoRoot: seedRoot,
          runtimeRoot: blockedRuntimeRoot,
          runId: 'mkdir-permission-denied',
          headSha,
        }),
        'WORKTREE_CREATE_FAILED',
      )
    } finally {
      chmodSync(blockedRuntimeRoot, 0o700)
    }

    const cleanupBlockedRuntimeRoot = path.join(tempRoot, 'cleanup-blocked-runtime')
    const cleanupBlockedWorktree = await createDetachedIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot: cleanupBlockedRuntimeRoot,
      runId: 'cleanup-permission-denied',
      headSha,
    })
    chmodSync(cleanupBlockedRuntimeRoot, 0o500)
    try {
      await expectGitError(
        () => cleanupIntegrationWorktree({
          repoRoot: seedRoot,
          runtimeRoot: cleanupBlockedRuntimeRoot,
          runId: 'cleanup-permission-denied',
          leaseToken: cleanupBlockedWorktree.leaseToken,
        }),
        'WORKTREE_CLEANUP_FAILED',
      )
    } finally {
      chmodSync(cleanupBlockedRuntimeRoot, 0o700)
    }
    assert.equal(
      existsSync(cleanupBlockedWorktree.runRoot),
      true,
      'a filesystem cleanup failure must preserve runRoot for retry',
    )
    await cleanupIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot: cleanupBlockedRuntimeRoot,
      runId: 'cleanup-permission-denied',
      leaseToken: cleanupBlockedWorktree.leaseToken,
    })

    const releaseFailureRuntimeRoot = path.join(
      tempRoot,
      'release-failure-runtime',
    )
    const releaseFailureWorktree = await createDetachedIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot: releaseFailureRuntimeRoot,
      runId: 'release-failure',
      headSha,
    })
    const releaseFailureLocksRoot = path.join(
      realpathSync(releaseFailureRuntimeRoot),
      '.locks',
    )
    chmodSync(releaseFailureLocksRoot, 0o500)
    try {
      await expectGitError(
        () => cleanupIntegrationWorktree({
          repoRoot: seedRoot,
          runtimeRoot: releaseFailureRuntimeRoot,
          runId: 'release-failure',
          leaseToken: releaseFailureWorktree.leaseToken,
        }),
        'WORKTREE_CLEANUP_FAILED',
      )
    } finally {
      chmodSync(releaseFailureLocksRoot, 0o700)
    }
    assert.equal(existsSync(releaseFailureWorktree.runRoot), false)
    assert.equal(
      existsSync(path.join(
        realpathSync(releaseFailureRuntimeRoot),
        '.state',
        'release-failure.json',
      )),
      false,
      'resources and manifest should already be gone when only lease release failed',
    )
    await cleanupIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot: releaseFailureRuntimeRoot,
      runId: 'release-failure',
      leaseToken: releaseFailureWorktree.leaseToken,
    })
    assert.equal(
      existsSync(path.join(
        releaseFailureLocksRoot,
        'release-failure.lock',
      )),
      false,
      'same-token retry must idempotently release the remaining lease',
    )
  }

  if (process.platform !== 'win32') {
    for (const insecureMode of [0o755, 0o777]) {
      const insecureRuntimeRoot = path.join(
        tempRoot,
        `insecure-runtime-${insecureMode.toString(8)}`,
      )
      mkdirSync(insecureRuntimeRoot, { mode: insecureMode })
      chmodSync(insecureRuntimeRoot, insecureMode)
      await expectGitError(
        () => createDetachedIntegrationWorktree({
          repoRoot: seedRoot,
          runtimeRoot: insecureRuntimeRoot,
          runId: 'insecure-runtime',
          headSha,
        }),
        'WORKTREE_PATH_UNSAFE',
      )
      assert.equal(
        statSync(insecureRuntimeRoot).mode & 0o777,
        insecureMode,
        'existing insecure runtime roots must be rejected without chmod',
      )
    }
  }

  git(seedRoot, ['branch', 'feature/local-only'])
  assert.equal(
    git(seedRoot, ['rev-parse', '--verify', 'feature/local-only']).trim(),
    staleTrackingSha,
  )
  await expectGitError(
    () => freezeIntegrationGitSnapshot({
      repoRoot: seedRoot,
      sourceBranch: 'feature/local-only',
      targetBranch: 'develop',
    }),
    'ORIGIN_REF_NOT_FOUND',
  )
  await expectGitError(
    () => freezeIntegrationGitSnapshot({
      repoRoot: seedRoot,
      sourceBranch: 'feature/missing',
      targetBranch: 'develop',
    }),
    'ORIGIN_REF_NOT_FOUND',
  )
  await expectGitError(
    () => freezeIntegrationGitSnapshot({
      repoRoot: seedRoot,
      sourceBranch: 'feature/song-list',
      targetBranch: 'target/missing',
    }),
    'ORIGIN_REF_NOT_FOUND',
  )
  await expectGitError(
    () => freezeIntegrationGitSnapshot({
      repoRoot: 'relative/repo',
      sourceBranch: 'feature/song-list',
      targetBranch: 'develop',
    }),
    'INVALID_REPO_ROOT',
  )
  await expectGitError(
    () => freezeIntegrationGitSnapshot({
      repoRoot: '/',
      sourceBranch: 'feature/song-list',
      targetBranch: 'develop',
    }),
    'INVALID_REPO_ROOT',
  )
  await expectGitError(
    () => freezeIntegrationGitSnapshot({
      repoRoot: `${seedRoot}/../${path.basename(seedRoot)}`,
      sourceBranch: 'feature/song-list',
      targetBranch: 'develop',
    }),
    'INVALID_REPO_ROOT',
  )

  const missingRepoRoot = path.join(tempRoot, 'missing-repo')
  await expectGitError(
    () => freezeIntegrationGitSnapshot({
      repoRoot: missingRepoRoot,
      sourceBranch: 'feature/song-list',
      targetBranch: 'develop',
    }),
    'INVALID_REPO_ROOT',
  )

  const fileRepoRoot = path.join(tempRoot, 'repo-file')
  writeFileSync(fileRepoRoot, 'not a directory\n')
  await expectGitError(
    () => freezeIntegrationGitSnapshot({
      repoRoot: fileRepoRoot,
      sourceBranch: 'feature/song-list',
      targetBranch: 'develop',
    }),
    'INVALID_REPO_ROOT',
  )

  const nonGitRepoRoot = path.join(tempRoot, 'not-a-git-worktree')
  mkdirSync(nonGitRepoRoot)
  await expectGitError(
    () => freezeIntegrationGitSnapshot({
      repoRoot: nonGitRepoRoot,
      sourceBranch: 'feature/song-list',
      targetBranch: 'develop',
    }),
    'INVALID_REPO_ROOT',
  )
  await expectGitError(
    () => freezeIntegrationGitSnapshot({
      repoRoot: seedRoot,
      sourceBranch: 'feature/song-list;touch-pwned',
      targetBranch: 'develop',
    }),
    'INVALID_BRANCH',
  )
  await expectGitError(
    () => freezeIntegrationGitSnapshot({
      repoRoot: seedRoot,
      sourceBranch: 'feature/song-list',
      targetBranch: 'develop',
      scopePath: '../outside',
    }),
    'INVALID_SCOPE_PATH',
  )

  await expectGitError(
    () => createDetachedIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot: 'relative/runtime',
      runId: 'run-002',
      headSha,
    }),
    'INVALID_RUNTIME_ROOT',
  )
  await expectGitError(
    () => createDetachedIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot: '/',
      runId: 'run-002',
      headSha,
    }),
    'INVALID_RUNTIME_ROOT',
  )
  await expectGitError(
    () => createDetachedIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot: `${runtimeRoot}/../${path.basename(runtimeRoot)}`,
      runId: 'run-002',
      headSha,
    }),
    'INVALID_RUNTIME_ROOT',
  )
  await expectGitError(
    () => createDetachedIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot,
      runId: '../escape',
      headSha,
    }),
    'INVALID_RUN_ID',
  )

  const symlinkTarget = path.join(tempRoot, 'symlink-target')
  const symlinkRuntime = path.join(tempRoot, 'symlink-runtime')
  mkdirSync(symlinkTarget)
  symlinkSync(symlinkTarget, symlinkRuntime, 'dir')
  await expectGitError(
    () => createDetachedIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot: symlinkRuntime,
      runId: 'run-003',
      headSha,
    }),
    'WORKTREE_PATH_UNSAFE',
  )

  const escapedRunTarget = path.join(tempRoot, 'escaped-run-target')
  mkdirSync(escapedRunTarget)
  writeFileSync(path.join(escapedRunTarget, 'must-survive.txt'), 'outside runtime\n')
  symlinkSync(escapedRunTarget, path.join(runtimeRoot, 'run-004'), 'dir')
  await expectGitError(
    () => createDetachedIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot,
      runId: 'run-004',
      headSha,
    }),
    'WORKTREE_PATH_UNSAFE',
  )
  assert.equal(
    existsSync(path.join(escapedRunTarget, 'must-survive.txt')),
    true,
    'rejecting a symlinked runRoot must not touch its target',
  )

  const cleanupRunTarget = path.join(tempRoot, 'cleanup-run-symlink-target')
  mkdirSync(cleanupRunTarget)
  writeFileSync(path.join(cleanupRunTarget, 'must-survive.txt'), 'run target marker\n')
  symlinkSync(cleanupRunTarget, path.join(runtimeRoot, 'cleanup-run-symlink'), 'dir')
  await expectGitError(
    () => cleanupIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot,
      runId: 'cleanup-run-symlink',
    }),
    'WORKTREE_BUSY',
  )
  assert.equal(
    existsSync(path.join(cleanupRunTarget, 'must-survive.txt')),
    true,
    'cleanup must not follow a symlinked runRoot',
  )
  assert.deepEqual(
    readdirSync(cleanupRunTarget),
    ['must-survive.txt'],
    'quarantine must be created under runtimeRoot, never inside a symlink target',
  )
  unlinkSync(path.join(runtimeRoot, 'cleanup-run-symlink'))

  const cleanupRepoWorktree = await createDetachedIntegrationWorktree({
    repoRoot: seedRoot,
    runtimeRoot,
    runId: 'cleanup-repo-symlink',
    headSha,
  })
  const displacedRepoPath = path.join(
    cleanupRepoWorktree.runRoot,
    'displaced-agent-worktree',
  )
  const cleanupRepoTarget = path.join(tempRoot, 'cleanup-repo-symlink-target')
  mkdirSync(cleanupRepoTarget)
  writeFileSync(path.join(cleanupRepoTarget, 'must-survive.txt'), 'repo target marker\n')
  renameSync(cleanupRepoWorktree.repoPath, displacedRepoPath)
  symlinkSync(cleanupRepoTarget, cleanupRepoWorktree.repoPath, 'dir')
  await expectGitError(
    () => cleanupIntegrationWorktree({
      repoRoot: seedRoot,
      runtimeRoot,
      runId: 'cleanup-repo-symlink',
      leaseToken: cleanupRepoWorktree.leaseToken,
    }),
    'WORKTREE_CLEANUP_FAILED',
  )
  assert.equal(
    existsSync(path.join(cleanupRepoTarget, 'must-survive.txt')),
    true,
    'cleanup must not follow a symlinked repoPath',
  )
  assert.equal(existsSync(cleanupRepoWorktree.runRoot), true)
  unlinkSync(cleanupRepoWorktree.repoPath)
  renameSync(displacedRepoPath, cleanupRepoWorktree.repoPath)
  await cleanupIntegrationWorktree({
    repoRoot: seedRoot,
    runtimeRoot,
    runId: 'cleanup-repo-symlink',
    leaseToken: cleanupRepoWorktree.leaseToken,
  })
  assert.equal(existsSync(cleanupRepoWorktree.runRoot), false)
  assert.equal(
    gitWorktreePaths(seedRoot).includes(cleanupRepoWorktree.repoPath),
    false,
    'targeted cleanup must clear only the matching metadata after repoPath replacement',
  )

  const refreshTargetPublisherRoot = path.join(tempRoot, 'refresh-target-publisher')
  execFileSync(
    'git',
    ['clone', '--branch', 'develop', originRoot, refreshTargetPublisherRoot],
    { stdio: 'ignore' },
  )
  git(refreshTargetPublisherRoot, ['config', 'user.name', 'Refresh Target Publisher'])
  git(refreshTargetPublisherRoot, [
    'config',
    'user.email',
    'refresh-target@example.invalid',
  ])
  writeFileSync(
    path.join(refreshTargetPublisherRoot, 'target-refresh.txt'),
    'latest target\n',
  )
  git(refreshTargetPublisherRoot, ['add', '.'])
  git(refreshTargetPublisherRoot, ['commit', '-m', 'advance target for refresh'])
  git(refreshTargetPublisherRoot, ['push', 'origin', 'develop'])
  const refreshedTargetTipSha = git(
    refreshTargetPublisherRoot,
    ['rev-parse', 'HEAD'],
  ).trim()

  writeFileSync(path.join(publisherRoot, 'source-refresh.txt'), 'latest source\n')
  git(publisherRoot, ['add', '.'])
  git(publisherRoot, ['commit', '-m', 'advance source for refresh'])
  git(publisherRoot, ['push', 'origin', 'feature/song-list'])
  const refreshedHeadSha = git(publisherRoot, ['rev-parse', 'HEAD']).trim()
  assert.notEqual(
    git(seedRoot, ['rev-parse', 'refs/remotes/origin/develop']).trim(),
    refreshedTargetTipSha,
    'the target tracking ref must be stale before refresh',
  )
  assert.notEqual(
    git(seedRoot, ['rev-parse', 'refs/remotes/origin/feature/song-list']).trim(),
    refreshedHeadSha,
    'the source tracking ref must be stale before refresh',
  )

  assert.deepEqual(
    await refreshIntegrationBranchTips({
      repoRoot: seedRoot,
      sourceBranch: 'feature/song-list',
      targetBranch: 'develop',
    }),
    {
      headSha: refreshedHeadSha,
      targetTipSha: refreshedTargetTipSha,
    },
    'refresh must fetch both remote branches and return their latest tips',
  )
  assert.equal(
    git(seedRoot, ['rev-parse', 'refs/remotes/origin/develop']).trim(),
    refreshedTargetTipSha,
  )
  assert.equal(
    git(seedRoot, ['rev-parse', 'refs/remotes/origin/feature/song-list']).trim(),
    refreshedHeadSha,
  )

  assert.equal(
    git(seedRoot, ['status', '--porcelain']),
    '',
    'snapshot, worktree creation, rollback, and cleanup must not modify repo files',
  )

  console.log('integration git tests passed')
} finally {
  if (previousTestRuntimeRoot === undefined) {
    delete process.env.HARMONY_INTEGRATION_RUNTIME_ROOT
  } else {
    process.env.HARMONY_INTEGRATION_RUNTIME_ROOT = previousTestRuntimeRoot
  }
  rmSync(tempRoot, { recursive: true, force: true })
}
