import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { mergeEventMatches, mrFromPush, verifyMergeCommit, verifyAcceptedFiles, verifyHandoffSource } from './delivery-ssh'
import { git } from './git'

test('merged webhook binds repository, branch, source project, source SHA and merge SHA', () => {
  const expected = { origin: 'https://git.example', repository: 'team/wiki', branch: 'feature/x', target: 'master', sha: 'a'.repeat(40) }
  const event = { origin: expected.origin, repository: expected.repository, branch: expected.target, sourceBranch: expected.branch, sourceSha: expected.sha, mergedSha: 'b'.repeat(40), iid: 1, projectId: 2, sourceProjectId: 2 }
  assert.equal(mergeEventMatches(event, expected), true)
  for (const patch of [{ sourceBranch: 'other' }, { branch: 'release' }, { repository: 'other/wiki' }, { origin: 'https://evil.example' }, { sourceSha: 'b'.repeat(40) }, { sourceProjectId: 3 }, { mergedSha: undefined }]) assert.equal(mergeEventMatches({ ...event, ...patch }, expected), false)
  assert.equal(mergeEventMatches(event, expected, 2), false)
  assert.equal(mergeEventMatches({ ...event, sourceSha: 'c'.repeat(40) }, expected, undefined, true), true, 'handoff event is a candidate, not merge proof')
  assert.equal(mergeEventMatches({ ...event, sourceBranch: 'other', sourceSha: 'c'.repeat(40) }, expected, undefined, true), false)
  assert.equal(mrFromPush('remote: https://git.example/team/wiki/-/merge_requests/12', expected)?.iid, 12)
  assert.equal(mrFromPush('https://evil.example/team/wiki/-/merge_requests/12', expected), null)
  assert.equal(mrFromPush('https://git.example/team/wiki/-/merge_requests/new', expected), null)
  assert.equal(mrFromPush('Everything up-to-date', expected), null)
})

test('Git verification accepts real merge and squash but rejects a changed accepted file or unreachable merge', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-merge-proof-')), signal = AbortSignal.timeout(90000)
  try {
    await git(root, ['init', '-b', 'release']); await git(root, ['config', 'user.name', 'fixture']); await git(root, ['config', 'user.email', 'test@localhost'])
    await writeFile(path.join(root, 'page.txt'), 'old'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'base'])
    const base = await git(root, ['rev-parse', 'HEAD'])
    await git(root, ['switch', '-c', 'feature/x']); await writeFile(path.join(root, 'page.txt'), 'accepted'); await git(root, ['commit', '-am', 'feature'])
    const source = await git(root, ['rev-parse', 'HEAD'])
    await verifyHandoffSource(root, base, source, signal)
    await assert.rejects(verifyHandoffSource(root, source, base, signal), /不包含/)
    await git(root, ['switch', 'release']); await git(root, ['merge', '--no-ff', 'feature/x', '-m', 'merge'])
    const merged = await git(root, ['rev-parse', 'HEAD'])
    await verifyMergeCommit(root, merged, merged, source, signal)
    await git(root, ['switch', '-c', 'squashed', base]); await git(root, ['merge', '--squash', 'feature/x']); await git(root, ['commit', '-m', 'squash'])
    const squash = await git(root, ['rev-parse', 'HEAD'])
    await verifyMergeCommit(root, squash, squash, source, signal)
    await writeFile(path.join(root, 'page.txt'), 'changed after review'); await git(root, ['commit', '-am', 'conflict resolution'])
    const changed = await git(root, ['rev-parse', 'HEAD'])
    await assert.rejects(verifyMergeCommit(root, changed, changed, source, signal), /不同/)
    const largePathSet = Array.from({ length: 1999 }, (_, i) => `module/${'long-directory/'.repeat(8)}${i}.ets`)
    await verifyAcceptedFiles(root, source, changed, largePathSet, signal)
    await assert.rejects(verifyAcceptedFiles(root, source, changed, [...largePathSet, 'page.txt'], signal), /不同/)
    await assert.rejects(verifyMergeCommit(root, base, merged, source, signal))
  } finally { await rm(root, { recursive: true, force: true }) }
})
