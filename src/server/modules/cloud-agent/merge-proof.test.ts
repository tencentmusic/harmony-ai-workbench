import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { git } from './git'
import { withMergeProof } from './merge-proof'

test('merge proof fetches its own shallow cache without origin, expands history and covers every FF commit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-proof-')), original = process.env.CLOUD_AGENT_RUNTIME_ROOT
  process.env.CLOUD_AGENT_RUNTIME_ROOT = path.join(root, 'runtime')
  const repo = path.join(root, 'repo'), remote = path.join(root, 'remote.git'), signal = AbortSignal.timeout(120000)
  try {
    await mkdir(repo); await mkdir(remote)
    await git(repo, ['init', '-b', 'release']); await git(repo, ['config', 'user.name', 'fixture']); await git(repo, ['config', 'user.email', 'fixture@localhost'])
    await writeFile(path.join(repo, 'first.txt'), 'base'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'base'])
    const base = await git(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['switch', '-c', 'feature/x'])
    await writeFile(path.join(repo, 'first.txt'), 'accepted'); await git(repo, ['commit', '-am', 'first'])
    await writeFile(path.join(repo, 'last.txt'), 'second'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'second'])
    const sourceSha = await git(repo, ['rev-parse', 'HEAD'])
    await git(remote, ['init', '--bare'])
    await git(repo, ['push', remote, `${sourceSha}:refs/heads/release`, `${sourceSha}:refs/merge-requests/1/head`])
    const input = { remote: pathToFileURL(remote).href, target: 'release', iid: 1, sourceSha, mergedSha: sourceSha, baseSha: base }
    const paths = await withMergeProof(input, signal, async proof => {
      assert.equal(await git(proof.cache, ['remote']), '')
      return proof.paths
    })
    assert.deepEqual(paths, ['first.txt', 'last.txt'])
    await assert.rejects(withMergeProof({ ...input, baseSha: undefined }, signal, async () => {}), /快进合入/)
    await assert.rejects(withMergeProof({ ...input, sourceSha: base }, signal, async () => {}), /源提交/)
    // Move the target 70 commits forward so its initial depth-64 fetch cannot reach the MR.
    const tree = await git(repo, ['rev-parse', `${sourceSha}^{tree}`])
    let target = sourceSha
    for (let index = 0; index < 70; index++) target = await git(repo, ['commit-tree', tree, '-p', target, '-m', `target ${index}`])
    await git(repo, ['push', remote, `${target}:refs/heads/release`])
    await withMergeProof(input, signal, async proof => { assert.equal(proof.targetSha, target); assert.deepEqual(proof.paths, paths) })
    const unrelated = await git(repo, ['commit-tree', tree, '-p', base, '-m', 'unmerged'])
    await assert.rejects(withMergeProof({ ...input, mergedSha: unrelated }, signal, async () => {}), /无法证明/)
  } finally {
    if (original === undefined) delete process.env.CLOUD_AGENT_RUNTIME_ROOT; else process.env.CLOUD_AGENT_RUNTIME_ROOT = original
    await rm(root, { recursive: true, force: true })
  }
})
