import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { git } from './git'
import { snapshotCommit, pushSnapshot, validateMR, findDeliveryMR } from './delivery-git'
import { acquireResource } from './resource-lock'

test('delivery snapshot and retry preserve verified HEAD, index and other branches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-delivery-test-'))
  const repo = path.join(root, 'repo'), remote = path.join(root, 'remote.git'), artifacts = path.join(root, 'artifacts')
  const signal = AbortSignal.timeout(180000)
  try {
    for (const dir of [repo, remote, artifacts]) await mkdir(dir)
    await git(repo, ['init', '-b', 'release'])
    await git(repo, ['config', 'user.name', 'Synthetic test'])
    await git(repo, ['config', 'user.email', 'test@localhost'])
    await mkdir(path.join(repo, 'app'))
    await writeFile(path.join(repo, 'app/page.ts'), 'old')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-m', 'fixture'])
    const base = await git(repo, ['rev-parse', 'HEAD'])
    await git(remote, ['init', '--bare'])
    await writeFile(path.join(repo, 'app/page.ts'), 'new')
    const indexBefore = await git(repo, ['write-tree'])
    const snapshot = await snapshotCommit(repo, base, ['app'], artifacts, 'feat: synthetic', signal)
    assert.notEqual(snapshot.sha, base)
    assert.equal(await git(repo, ['rev-parse', 'HEAD']), base)
    assert.equal(await git(repo, ['write-tree']), indexBefore)
    assert.equal(await git(repo, ['show', `${snapshot.sha}:app/page.ts`]), 'new')
    assert.equal((await snapshotCommit(repo, base, ['app'], artifacts, 'retry', signal)).tree, snapshot.tree)
    await writeFile(path.join(repo, 'app/page.ts'), 'changed after acceptance')
    assert.notEqual((await snapshotCommit(repo, base, ['app'], artifacts, 'changed', signal)).tree, snapshot.tree)
    await writeFile(path.join(repo, 'app/page.ts'), 'new')
    await pushSnapshot(repo, remote, 'feature/synthetic', snapshot.sha, signal)
    await pushSnapshot(repo, remote, 'feature/synthetic', snapshot.sha, signal)
    await assert.rejects(pushSnapshot(repo, remote, 'feature/synthetic', base, signal), /未覆盖/)
    await writeFile(path.join(repo, 'app/page.ts'), 'reworked')
    const revision = await snapshotCommit(repo, base, ['app'], artifacts, 'fix: revision', signal, snapshot.sha)
    assert.equal(await git(repo, ['rev-parse', `${revision.sha}^`]), snapshot.sha)
    await pushSnapshot(repo, remote, 'feature/synthetic', revision.sha, signal, snapshot.sha)
    await pushSnapshot(repo, remote, 'feature/synthetic', revision.sha, signal, snapshot.sha)
    await assert.rejects(pushSnapshot(repo, remote, 'feature/synthetic', base, signal, snapshot.sha), /未覆盖/)
    await writeFile(path.join(repo, 'outside.ts'), 'not allowed')
    await assert.rejects(snapshotCommit(repo, base, ['app'], artifacts, 'bad', signal), /范围/)
    for (let i = 0; i < 81; i++) await writeFile(path.join(repo, `shared-${i}.ets`), '// fixture')
    await writeFile(path.join(repo, '.gitignore'), 'build/\n')
    await writeFile(path.join(repo, 'build-profile.json5'), '{}')
    const fullProject = await snapshotCommit(repo, base, [''], artifacts, 'whole project', signal)
    assert.equal(await git(repo, ['show', `${fullProject.sha}:.gitignore`]), 'build/')
    assert.equal(await git(repo, ['show', `${fullProject.sha}:shared-80.ets`]), '// fixture')
    assert.equal(await git(repo, ['rev-parse', 'HEAD']), base)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('delivery accepts only the registered descendant HEAD and includes its committed changes', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cloud-delivery-head-'))
  const repo = path.join(temp, 'repo'), artifacts = path.join(temp, 'artifacts')
  const signal = AbortSignal.timeout(120000)
  try {
    await mkdir(repo); await mkdir(artifacts)
    await git(repo, ['init', '-b', 'feature/test'])
    await git(repo, ['config', 'user.name', 'fixture']); await git(repo, ['config', 'user.email', 'fixture@localhost'])
    await mkdir(path.join(repo, 'app')); await writeFile(path.join(repo, 'app/page.ts'), 'before')
    await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'base'])
    const base = await git(repo, ['rev-parse', 'HEAD'])
    await writeFile(path.join(repo, 'app/debug-profile.json'), '{"updated":true}')
    await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'registered signing update'])
    const head = await git(repo, ['rev-parse', 'HEAD']), index = await git(repo, ['write-tree'])
    await assert.rejects(snapshotCommit(repo, base, ['app'], artifacts, 'unregistered', signal), /HEAD/)
    const committed = await snapshotCommit(repo, base, ['app'], artifacts, 'committed only', signal, base, undefined, head)
    assert.equal(await git(repo, ['show', `${committed.sha}:app/debug-profile.json`]), '{"updated":true}')
    await writeFile(path.join(repo, 'app/page.ts'), 'accepted implementation')
    const snapshot = await snapshotCommit(repo, base, ['app'], artifacts, 'accepted', signal, base, undefined, head)
    assert.equal(snapshot.base, base)
    assert.equal(await git(repo, ['rev-parse', `${snapshot.sha}^`]), base)
    assert.equal(await git(repo, ['show', `${snapshot.sha}:app/page.ts`]), 'accepted implementation')
    assert.equal(await git(repo, ['show', `${snapshot.sha}:app/debug-profile.json`]), '{"updated":true}')
    assert.equal(await git(repo, ['rev-parse', 'HEAD']), head)
    assert.equal(await git(repo, ['write-tree']), index)
    await writeFile(path.join(repo, 'outside.txt'), 'committed outside scope')
    await git(repo, ['add', 'outside.txt']); await git(repo, ['commit', '-m', 'outside'])
    const changedHead = await git(repo, ['rev-parse', 'HEAD'])
    await assert.rejects(snapshotCommit(repo, base, ['app'], artifacts, 'changed', signal, base, undefined, head), /HEAD/)
    await assert.rejects(snapshotCommit(repo, base, ['app'], artifacts, 'scope', signal, base, undefined, changedHead), /范围/)
    await git(repo, ['checkout', '--orphan', 'unrelated'])
    await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'unrelated history'])
    const unrelated = await git(repo, ['rev-parse', 'HEAD'])
    await assert.rejects(snapshotCommit(repo, base, [''], artifacts, 'unrelated', signal, base, undefined, unrelated), /后继|继承/)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('MR identity binds exact validated SHA, target and repository', () => {
  const expected = { origin: 'https://git.example', repository: 'team/repo', branch: 'feature/x', target: 'release', sha: 'a'.repeat(40) }
  const row = { iid: 1, source_branch: expected.branch, target_branch: expected.target, sha: expected.sha, source_project_id: 1, target_project_id: 1, web_url: 'https://git.example/team/repo/-/merge_requests/1' }
  assert.equal(validateMR(row, expected).iid, 1)
  for (const patch of [{ sha: 'b'.repeat(40) }, { target_branch: 'master' }, { source_project_id: 2 }, { web_url: 'https://evil.example/mr' }]) assert.throws(() => validateMR({ ...row, ...patch }, expected))
})

test('device ownership is exclusive and releases only on confirmed completion', async () => {
  const id = `synthetic-${Date.now()}`
  const signal = new AbortController().signal
  const release = await acquireResource('test', id, 'first', signal)
  try { await assert.rejects(acquireResource('test', id, 'second', signal), /占用/) } finally { await release() }
  const next = await acquireResource('test', id, 'second', signal)
  await next()
})

test('delivery discovers manually created MR without issuing POST, and rejects mismatched snapshots', async () => {
  const expected = { origin: 'https://git.example', repository: 'team/repo', branch: 'feature/x', target: 'release', sha: 'a'.repeat(40) }
  const row = { iid: 7, source_branch: expected.branch, target_branch: expected.target, sha: expected.sha, source_project_id: 1, target_project_id: 1, web_url: 'https://git.example/team/repo/-/merge_requests/7', state: 'merged' }
  const signal = new AbortController().signal
  const request = async (_origin: string, endpoint: string, _signal: AbortSignal, body?: unknown) => {
    assert.equal(body, undefined)
    assert.match(endpoint, /source_branch=feature%2Fx/)
    return [row]
  }
  assert.equal((await findDeliveryMR(expected, signal, request))!.iid, 7)
  assert.equal(await findDeliveryMR(expected, signal, async () => []), null)
  await assert.rejects(findDeliveryMR(expected, signal, async () => [{ ...row, sha: 'b'.repeat(40) }]), /快照/)
  await assert.rejects(findDeliveryMR(expected, signal, async () => [{ ...row, state: 'closed' }]), /关闭/)
  await assert.rejects(findDeliveryMR(expected, signal, async () => [row, row]), /不唯一/)
})
