import assert from 'node:assert/strict'
import test from 'node:test'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { RuntimeConversation } from './runtime'
import { ReadCoverage } from './code-review-domain'
import { refreshReviewCoverage } from './review-cycle'

test('review checkpoint restores only a confirmed stopped local isolated session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harmony-cloud-'))
  try {
    const pid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', windowsHide: true }))
    const receipt = { root, pid, host: os.hostname(), sessionId: 'ses_fixture', stoppedAt: new Date().toISOString(), startedAt: new Date().toISOString(), port: 1234, configDigest: 'fixture' }
    await writeFile(path.join(root, 'stopped.json'), JSON.stringify(receipt))
    const context = new RuntimeConversation(), checkpoint = { receipt, binding: 'role-bound' }
    await context.restore(checkpoint)
    assert.equal(context.reusable, true)
    assert.deepEqual(context.checkpoint(), checkpoint)
    context.reset()
    assert.equal(context.reusable, false)
    await assert.rejects(context.restore({ ...checkpoint, receipt: { ...receipt, host: 'another-host' } }))
    await assert.rejects(context.restore({ ...checkpoint, receipt: { ...receipt, sessionId: 'ses_other' } }), /停止收据/)
    await writeFile(path.join(root, 'stopped.json'), JSON.stringify({ ...receipt, pid: process.pid }))
    await assert.rejects(context.restore({ ...checkpoint, receipt: { ...receipt, pid: process.pid } }), /旧进程仍存在/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('restored coverage resumes exact gaps and changed source invalidates its cached reads', async () => {
  const before = new ReadCoverage()
  before.add('harmony:done', 0, { text: 'done', nextOffset: null })
  before.add('harmony:partial', 0, { text: 'part', nextOffset: 4 })
  const restored = new ReadCoverage()
  restored.restore(JSON.parse(JSON.stringify(before.snapshot())))
  assert.deepEqual(restored.pending(['harmony:done', 'harmony:partial']), [{ key: 'harmony:partial', offset: 4 }])
  const refreshed = await refreshReviewCoverage(restored, new Map([['harmony:done', 'old'], ['harmony:partial', 'same']]), async key => key.endsWith('done') ? 'new' : 'same', true)
  assert.deepEqual(refreshed.coverage.pending(['harmony:done', 'harmony:partial']), [{ key: 'harmony:done', offset: 0 }, { key: 'harmony:partial', offset: 4 }])
  assert.throws(() => restored.restore({ offsets: [['a', -1]], complete: [] }))
  assert.throws(() => restored.restore({ offsets: [], complete: ['a'] }))
})
