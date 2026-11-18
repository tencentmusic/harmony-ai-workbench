import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { DeviceReviewSession } from './device-review-session'

test('device review reuses stopped role context and invalidates changed evidence coverage', async () => {
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'device-review-test-'))
  const root = await mkdtemp(path.join(os.tmpdir(), 'harmony-cloud-'))
  try {
    const workspace = { artifactRoot, identity: 'synthetic-review' }
    const first = await DeviceReviewSession.open(workspace, 'model', { hash: 'same' })
    first.coverage.add('layout', 0, { text: 'page', nextOffset: 4 })
    first.coverage.add('image', 0, { text: 'digest', nextOffset: null })
    const pid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', windowsHide: true }))
    const receipt = { root, pid, host: os.hostname(), sessionId: 'ses_fixture', stoppedAt: new Date().toISOString() }
    await writeFile(path.join(root, 'stopped.json'), JSON.stringify(receipt))
    await first.conversation.restore({ receipt, binding: 'role-model-gateway' })
    first.elapsedMs = 1200000
    await first.save()
    const restored = await DeviceReviewSession.open(workspace, 'model', { hash: 'same' })
    assert.equal(restored.id, first.id)
    assert.equal(restored.conversation.reusable, true)
    assert.equal(restored.elapsedMs, first.elapsedMs)
    assert.deepEqual(restored.coverage.pending(['layout', 'image']), [{ key: 'layout', offset: 4 }])
    const changed = await DeviceReviewSession.open(workspace, 'model', { hash: 'changed' })
    assert.equal(changed.conversation.reusable, true)
    assert.deepEqual(changed.coverage.pending(['layout', 'image']), [{ key: 'layout', offset: 0 }, { key: 'image', offset: 0 }])
    assert.equal(changed.elapsedMs, 0)
    assert.equal((await DeviceReviewSession.open(workspace, 'other-model', { hash: 'same' })).conversation.reusable, false)
    assert.equal((await DeviceReviewSession.open({ ...workspace, identity: 'other-task' }, 'model', { hash: 'same' })).conversation.reusable, false)
    assert.equal(restored.remainingMs(), 2400000)
    restored.elapsedMs = 3600000
    assert.throws(() => restored.remainingMs(), /累计/)
    await writeFile(path.join(root, 'stopped.json'), JSON.stringify({ ...receipt, pid: process.pid }))
    await assert.rejects(DeviceReviewSession.open(workspace, 'model', { hash: 'same' }), /停止收据/)
  } finally {
    await rm(artifactRoot, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('changed evidence preserves unchanged file pages but a different native run starts a new session', async () => {
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'device-review-test-'))
  const root = await mkdtemp(path.join(os.tmpdir(), 'harmony-cloud-'))
  try {
    const workspace = { artifactRoot, identity: 'synthetic-review' }
    const evidence = { run: 'native-one', files: [['unchanged', { sha256: 'a' }], ['changed', { sha256: 'b' }], ['removed', { sha256: 'c' }]] }
    const first = await DeviceReviewSession.open(workspace, 'model', evidence)
    first.coverage.add('unchanged', 0, { text: 'page', nextOffset: 4 })
    first.coverage.add('changed', 0, { text: 'old', nextOffset: null })
    first.coverage.add('removed', 0, { text: 'old', nextOffset: null })
    const pid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', windowsHide: true }))
    const receipt = { root, pid, host: os.hostname(), sessionId: 'ses_fixturedelta', stoppedAt: new Date().toISOString() }
    await writeFile(path.join(root, 'stopped.json'), JSON.stringify(receipt))
    await first.conversation.restore({ receipt, binding: 'role-model-gateway' })
    await first.save()
    const updated = { run: evidence.run, files: [['unchanged', { sha256: 'a' }], ['changed', { sha256: 'd' }], ['added', { sha256: 'e' }]] }
    const restored = await DeviceReviewSession.open(workspace, 'model', updated)
    assert.equal(restored.id, first.id)
    assert.deepEqual(restored.coverage.pending(['unchanged', 'changed', 'added', 'removed']), [
      { key: 'unchanged', offset: 4 }, { key: 'changed', offset: 0 }, { key: 'added', offset: 0 }, { key: 'removed', offset: 0 },
    ])
    assert.equal((await DeviceReviewSession.open(workspace, 'model', { ...updated, run: 'native-two' })).conversation.reusable, false)
  } finally {
    await rm(artifactRoot, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})
