#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { writeFile, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  cleanupIntegrationOpencodeResources,
} from '../src/server/modules/integration/integration-opencode-cleanup.ts'
import {
  cleanupIntegrationWorktree,
  createDetachedIntegrationWorktree,
  IntegrationGitError,
} from '../src/server/modules/integration/integration-git.ts'

const execFileAsync = promisify(execFile)
const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'integration-opencode-cleanup-'))
const repoRoot = path.join(fixtureRoot, 'repo')
const runtimeRoot = path.join(fixtureRoot, 'runtime')
let worktreeLease
let worktreeDirectory

const TEST_CFG = {
  baseUrl: 'http://127.0.0.1:4110',
  timeoutMs: 1_000,
  username: 'integration-cleanup',
  password: 'a'.repeat(64),
}

try {
  await execFileAsync('git', ['init', '-q', repoRoot])
  await execFileAsync('git', ['config', 'user.email', 'cleanup@example.invalid'], {
    cwd: repoRoot,
  })
  await execFileAsync('git', ['config', 'user.name', 'Cleanup Test'], {
    cwd: repoRoot,
  })
  await writeFile(path.join(repoRoot, 'README.md'), 'fixture\n', 'utf8')
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot })
  await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot })

  const canonicalRepoRoot = await realpath(repoRoot)
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: canonicalRepoRoot,
  })
  const created = await createDetachedIntegrationWorktree({
    repoRoot: canonicalRepoRoot,
    runtimeRoot,
    runId: 'cleanup-test',
    headSha: stdout.trim(),
  })
  worktreeLease = {
    repoRoot: canonicalRepoRoot,
    runtimeRoot,
    runId: 'cleanup-test',
    leaseToken: created.leaseToken,
  }
  worktreeDirectory = await realpath(created.repoPath)

  let networkCalls = 0
  await assert.rejects(
    cleanupIntegrationOpencodeResources({
      worktreeLease: {
        ...worktreeLease,
        leaseToken: '0'.repeat(64),
      },
      sessionIds: ['ses_one'],
      cfg: TEST_CFG,
      fetchImpl: async () => {
        networkCalls += 1
        return Response.json(true)
      },
    }),
    (error) => error instanceof IntegrationGitError,
  )
  assert.equal(
    networkCalls,
    0,
    'a forged worktree lease must fail before any OpenCode request',
  )

  const requests = []
  const result = await cleanupIntegrationOpencodeResources({
    worktreeLease,
    sessionIds: ['ses_one', 'ses_two', 'ses_one'],
    cfg: TEST_CFG,
    fetchImpl: async (url, init = {}) => {
      const headers = new Headers(init.headers)
      requests.push({
        method: init.method ?? 'GET',
        path: new URL(url).pathname,
        authorization: headers.get('authorization'),
        directory: headers.get('x-opencode-directory'),
      })
      return Response.json(true)
    },
  })
  assert.deepEqual(result, {
    status: 'safe',
    sessionIds: ['ses_one', 'ses_two'],
    deletedSessionIds: ['ses_one', 'ses_two'],
    pendingSessionIds: [],
    dispose: { status: 'confirmed' },
    issues: [],
  })
  assert.deepEqual(
    requests.map(({ method, path: requestPath }) => `${method} ${requestPath}`),
    [
      'DELETE /session/ses_one',
      'DELETE /session/ses_two',
      'POST /instance/dispose',
    ],
  )
  const expectedAuthorization = `Basic ${Buffer.from(
    `${TEST_CFG.username}:${TEST_CFG.password}`,
    'utf8',
  ).toString('base64')}`
  assert.ok(
    requests.every((request) => request.directory === worktreeDirectory),
    'cleanup must bind every request to the lease-validated directory',
  )
  assert.ok(
    requests.every((request) => request.authorization === expectedAuthorization),
    'cleanup must reuse the authenticated directory client',
  )

  const falseResponsePaths = []
  const falseResponseResult = await cleanupIntegrationOpencodeResources({
    worktreeLease,
    sessionIds: ['ses_not_confirmed', 'ses_confirmed'],
    cfg: TEST_CFG,
    fetchImpl: async (url, init = {}) => {
      const pathname = new URL(url).pathname
      falseResponsePaths.push(pathname)
      if (
        init.method === 'DELETE' &&
        pathname === '/session/ses_not_confirmed'
      ) {
        return Response.json(false)
      }
      return Response.json(true)
    },
  })
  assert.deepEqual(falseResponseResult, {
    status: 'pending',
    sessionIds: ['ses_not_confirmed', 'ses_confirmed'],
    deletedSessionIds: ['ses_confirmed'],
    pendingSessionIds: ['ses_not_confirmed'],
    dispose: { status: 'not_attempted' },
    issues: [{
      operation: 'session_delete',
      sessionId: 'ses_not_confirmed',
      errorCode: 'SESSION_DELETE_NOT_CONFIRMED',
      error: 'OpenCode 未确认删除会话',
    }],
  })
  assert.deepEqual(
    falseResponsePaths,
    [
      '/session/ses_not_confirmed',
      '/session/ses_confirmed',
    ],
    'all unique sessions should be attempted, but dispose must remain blocked',
  )

  const secretBearingError = `transport exposed ${TEST_CFG.password}`
  const exceptionResult = await cleanupIntegrationOpencodeResources({
    worktreeLease,
    sessionIds: ['ses_transport_error', 'ses_after_error'],
    cfg: TEST_CFG,
    fetchImpl: async (url, init = {}) => {
      const pathname = new URL(url).pathname
      if (
        init.method === 'DELETE' &&
        pathname === '/session/ses_transport_error'
      ) {
        throw new Error(secretBearingError)
      }
      return Response.json(true)
    },
  })
  assert.deepEqual(exceptionResult, {
    status: 'pending',
    sessionIds: ['ses_transport_error', 'ses_after_error'],
    deletedSessionIds: ['ses_after_error'],
    pendingSessionIds: ['ses_transport_error'],
    dispose: { status: 'not_attempted' },
    issues: [{
      operation: 'session_delete',
      sessionId: 'ses_transport_error',
      errorCode: 'SESSION_DELETE_FAILED',
      error: 'OpenCode 会话删除请求失败',
    }],
  })
  assert.doesNotMatch(
    JSON.stringify(exceptionResult),
    new RegExp(TEST_CFG.password),
    'cleanup results must not expose Basic credentials through transport errors',
  )

  const disposeFalseResult = await cleanupIntegrationOpencodeResources({
    worktreeLease,
    sessionIds: ['ses_before_dispose_false'],
    cfg: TEST_CFG,
    fetchImpl: async (url, init = {}) => {
      if (
        init.method === 'POST' &&
        new URL(url).pathname === '/instance/dispose'
      ) {
        return Response.json(false)
      }
      return Response.json(true)
    },
  })
  assert.deepEqual(disposeFalseResult, {
    status: 'pending',
    sessionIds: ['ses_before_dispose_false'],
    deletedSessionIds: ['ses_before_dispose_false'],
    pendingSessionIds: [],
    dispose: {
      status: 'pending',
      errorCode: 'INSTANCE_DISPOSE_NOT_CONFIRMED',
      error: 'OpenCode 未确认释放 directory instance',
    },
    issues: [{
      operation: 'instance_dispose',
      errorCode: 'INSTANCE_DISPOSE_NOT_CONFIRMED',
      error: 'OpenCode 未确认释放 directory instance',
    }],
  })
  const disposeRetryPaths = []
  const disposeRetryResult = await cleanupIntegrationOpencodeResources({
    worktreeLease,
    sessionIds: disposeFalseResult.sessionIds,
    confirmedDeletedSessionIds: disposeFalseResult.deletedSessionIds,
    cfg: TEST_CFG,
    fetchImpl: async (url) => {
      disposeRetryPaths.push(new URL(url).pathname)
      return Response.json(true)
    },
  })
  assert.equal(disposeRetryResult.status, 'safe')
  assert.deepEqual(
    disposeRetryPaths,
    ['/instance/dispose'],
    'a dispose retry must not re-delete sessions already confirmed by the prior result',
  )

  const disposeExceptionResult = await cleanupIntegrationOpencodeResources({
    worktreeLease,
    sessionIds: [],
    cfg: TEST_CFG,
    fetchImpl: async () => {
      throw new Error(secretBearingError)
    },
  })
  assert.deepEqual(disposeExceptionResult, {
    status: 'pending',
    sessionIds: [],
    deletedSessionIds: [],
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
  })
  assert.doesNotMatch(
    JSON.stringify(disposeExceptionResult),
    new RegExp(TEST_CFG.password),
  )

  const retryPaths = []
  const retryResult = await cleanupIntegrationOpencodeResources({
    worktreeLease,
    sessionIds: falseResponseResult.sessionIds,
    confirmedDeletedSessionIds: falseResponseResult.deletedSessionIds,
    cfg: TEST_CFG,
    fetchImpl: async (url) => {
      retryPaths.push(new URL(url).pathname)
      return Response.json(true)
    },
  })
  assert.deepEqual(retryResult, {
    status: 'safe',
    sessionIds: ['ses_not_confirmed', 'ses_confirmed'],
    deletedSessionIds: ['ses_not_confirmed', 'ses_confirmed'],
    pendingSessionIds: [],
    dispose: { status: 'confirmed' },
    issues: [],
  })
  assert.deepEqual(
    retryPaths,
    [
      '/session/ses_not_confirmed',
      '/instance/dispose',
    ],
    'retry must skip sessions whose deletion was already confirmed',
  )

  const savedIntegrationConfig = {
    baseUrl: process.env.OPENCODE_INTEGRATION_BASE_URL,
    username: process.env.OPENCODE_INTEGRATION_SERVER_USERNAME,
    password: process.env.OPENCODE_INTEGRATION_SERVER_PASSWORD,
  }
  delete process.env.OPENCODE_INTEGRATION_BASE_URL
  delete process.env.OPENCODE_INTEGRATION_SERVER_USERNAME
  delete process.env.OPENCODE_INTEGRATION_SERVER_PASSWORD
  try {
    const configFailureResult = await cleanupIntegrationOpencodeResources({
      worktreeLease,
      sessionIds: ['ses_waiting_for_config'],
      fetchImpl: async () => {
        throw new Error('network must not run without a client')
      },
    })
    assert.deepEqual(configFailureResult, {
      status: 'pending',
      sessionIds: ['ses_waiting_for_config'],
      deletedSessionIds: [],
      pendingSessionIds: ['ses_waiting_for_config'],
      dispose: { status: 'not_attempted' },
      issues: [{
        operation: 'client_create',
        errorCode: 'OPENCODE_CLIENT_CREATE_FAILED',
        error: 'OpenCode 清理客户端初始化失败',
      }],
    })
  } finally {
    for (const [name, value] of Object.entries({
      OPENCODE_INTEGRATION_BASE_URL: savedIntegrationConfig.baseUrl,
      OPENCODE_INTEGRATION_SERVER_USERNAME: savedIntegrationConfig.username,
      OPENCODE_INTEGRATION_SERVER_PASSWORD: savedIntegrationConfig.password,
    })) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
} finally {
  if (worktreeLease) {
    await cleanupIntegrationWorktree(worktreeLease)
  }
  await rm(fixtureRoot, { recursive: true, force: true })
}
