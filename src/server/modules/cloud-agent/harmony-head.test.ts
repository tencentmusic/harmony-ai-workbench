import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { git } from './git'
import { assertHarmonyHead } from './harmony-head'

test('registered HEAD preserves the base and rejects unregistered or unrelated commits and branches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-head-'))
  const signal = AbortSignal.timeout(60000)
  try {
    await git(root, ['init', '-q', '-b', 'feature/task'])
    await git(root, ['config', 'user.name', 'Test'])
    await git(root, ['config', 'user.email', 'test@example.invalid'])
    await writeFile(path.join(root, 'source.txt'), 'base')
    await git(root, ['add', '.']); await git(root, ['commit', '-qm', 'base'])
    const w = { harmonyRoot: root, branch: 'feature/task', baseSha: await git(root, ['rev-parse', 'HEAD']) }
    await assertHarmonyHead(w, signal)
    await writeFile(path.join(root, 'cert.txt'), 'updated')
    await git(root, ['add', 'cert.txt']); await git(root, ['commit', '-qm', 'certificate'])
    const next = { ...w, harmonyHeadSha: await git(root, ['rev-parse', 'HEAD']) }
    await assert.rejects(assertHarmonyHead(w, signal), /HEAD/)
    await writeFile(path.join(root, 'source.txt'), 'uncommitted business code')
    await assertHarmonyHead(next, signal)
    assert.equal(next.baseSha, w.baseSha)
    await assert.rejects(assertHarmonyHead({ ...next, harmonyHeadSha: 'invalid' }, signal), /提交/)
    await git(root, ['checkout', '-qb', 'feature/other'])
    await assert.rejects(assertHarmonyHead(next, signal), /分支/)
    await git(root, ['checkout', '--orphan', 'feature/unrelated'])
    await git(root, ['add', '.']); await git(root, ['commit', '-qm', 'unrelated'])
    await assert.rejects(assertHarmonyHead({ ...next, branch: 'feature/unrelated', harmonyHeadSha: await git(root, ['rev-parse', 'HEAD']) }, signal), /基线/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
