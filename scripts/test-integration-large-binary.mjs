import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  freezeIntegrationGitSnapshot,
  materializeIntegrationFrozenDiff,
} from '../src/server/modules/integration/integration-git.ts'

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'integration-large-binary-')))
const repo = path.join(root, 'repo')
const origin = path.join(root, 'origin.git')
const runtimeRoot = path.join(root, 'runs')
const git = (...args) => execFileSync('git', ['-C', repo, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
})
const previousLimit = process.env.HARMONY_INTEGRATION_MAX_DIFF_BYTES
process.env.HARMONY_INTEGRATION_MAX_DIFF_BYTES = '2097152'
try {
  mkdirSync(repo)
  execFileSync('git', ['init', '--bare', origin], { stdio: 'ignore' })
  git('init')
  git('config', 'user.email', 'integration@example.invalid')
  git('config', 'user.name', 'Integration Test')
  const binary = randomBytes(3 * 1024 * 1024)
  binary[0] = 0
  writeFileSync(path.join(repo, 'player.har'), binary)
  writeFileSync(path.join(repo, 'player.ets'), 'export const quic = false\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  git('branch', '-M', 'develop')
  git('remote', 'add', 'origin', origin)
  git('push', 'origin', 'develop')
  git('switch', '-c', 'feature/quic')
  // Replacing a binary archive can generate a multi-MiB literal patch.
  const replacement = randomBytes(binary.length)
  replacement[0] = 0
  writeFileSync(path.join(repo, 'player.har'), replacement)
  writeFileSync(path.join(repo, 'player.ets'), 'export const quic = true\n')
  git('add', '.')
  git('commit', '-qm', 'replace player and enable quic')
  git('push', 'origin', 'feature/quic')
  assert.ok(Buffer.byteLength(git('diff', '--binary', 'develop...HEAD')) > 2097152)

  const input = { repoRoot: repo, runtimeRoot, sourceBranch: 'feature/quic', targetBranch: 'develop' }
  const snapshot = await freezeIntegrationGitSnapshot(input)
  const control = path.join(repo, '.harmony-integration')
  mkdirSync(control, { mode: 0o700 })
  const outputPath = path.join(control, 'frozen.diff')
  const result = await materializeIntegrationFrozenDiff({
    repoRoot: repo, baseSha: snapshot.baseSha, headSha: snapshot.headSha,
    outputPath, expectedDiffHash: snapshot.diffHash,
  })
  const diff = readFileSync(outputPath, 'utf8')
  assert.ok(result.byteLength < 4096, 'binary payload must not inflate the review input')
  assert.match(diff, /Binary files a\/player.har and b\/player.har differ/)
  assert.doesNotMatch(diff, /GIT binary patch/)
  assert.ok(diff.includes(git('rev-parse', 'develop:player.har').trim()))
  assert.ok(diff.includes(git('rev-parse', 'HEAD:player.har').trim()))
  assert.match(diff, /\+export const quic = true/)
  assert.equal(createHash('sha256').update(diff).digest('hex'), snapshot.diffHash)

  // A binary-only follow-up must invalidate report reuse even when its path is unchanged.
  replacement[replacement.length - 1] ^= 1
  writeFileSync(path.join(repo, 'player.har'), replacement)
  git('add', 'player.har')
  git('commit', '-qm', 'binary-only follow-up')
  git('push', 'origin', 'feature/quic')
  const followup = await freezeIntegrationGitSnapshot(input)
  assert.notEqual(followup.diffHash, snapshot.diffHash)
  assert.equal((await freezeIntegrationGitSnapshot(input)).diffHash, followup.diffHash)

  // Binary-only additions and deletions must remain visible in the frozen change set.
  git('rm', 'player.har')
  writeFileSync(path.join(repo, 'replacement.har'), replacement)
  git('add', 'replacement.har')
  git('commit', '-qm', 'replace archive path')
  git('push', 'origin', 'feature/quic')
  const moved = await freezeIntegrationGitSnapshot(input)
  const movedDiff = git('diff', '--full-index', `${moved.baseSha}...${moved.headSha}`)
  assert.match(movedDiff, /player.har/)
  assert.match(movedDiff, /replacement.har/)
  assert.equal(createHash('sha256').update(movedDiff).digest('hex'), moved.diffHash)

  // Large source patches still require a bounded review, rather than silent truncation.
  writeFileSync(path.join(repo, 'large.ets'), 'const value = 123;\n'.repeat(130000))
  git('add', 'large.ets')
  git('commit', '-qm', 'oversized source patch')
  git('push', 'origin', 'feature/quic')
  await assert.rejects(freezeIntegrationGitSnapshot(input), { code: 'GIT_DIFF_TOO_LARGE' })
  console.log('PASS: large binary admitted; code preserved; binary identity tracked; source limit enforced')
} finally {
  if (previousLimit === undefined) delete process.env.HARMONY_INTEGRATION_MAX_DIFF_BYTES
  else process.env.HARMONY_INTEGRATION_MAX_DIFF_BYTES = previousLimit
  rmSync(root, { recursive: true, force: true })
}
