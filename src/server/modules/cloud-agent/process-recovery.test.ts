import assert from 'node:assert/strict'
import { test } from 'node:test'
import os from 'node:os'
import { requireStopped, confirmStoppedReceipt, requireChildProcessesStopped, requireHarnessJournalSettled } from './process-recovery'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { sha256 } from './scoped-files'

test('operator recovery requires every journal operation to be settled, including truncated writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-journal-test-'))
  const file = path.join(root, 'harness-events.jsonl')
  const event = (operation_id: string, status: string) => JSON.stringify({ operation_id, status }) + '\n'
  try {
    await requireHarnessJournalSettled(root)
    await writeFile(file, event('review-a', 'started') + event('review-b', 'committed'))
    await assert.rejects(requireHarnessJournalSettled(root), /未完成记录/)
    await writeFile(file, event('review-a', 'started') + event('review-a', 'committed'))
    await requireHarnessJournalSettled(root)
    await writeFile(file, event('review-a', 'started') + '{')
    await assert.rejects(requireHarnessJournalSettled(root), /日志不完整/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('recovery refuses live, foreign and uncertain process trees', () => {
  const receipt = { pid: 123, host: os.hostname() }
  assert.throws(() => requireStopped(receipt, 'test', () => true), /仍存在/)
  assert.throws(() => requireStopped({ ...receipt, host: 'another-host' }, 'test', () => false), /归属/)
  assert.throws(() => requireStopped({ ...receipt, kind: 'harness' }, 'test', () => false), /未确认/)
  assert.throws(() => requireStopped({ ...receipt, status: 'uncertain' }, 'test', () => false), /不确定/)
  requireStopped({ ...receipt, status: 'stopped' }, 'test', () => true)
  requireStopped(receipt, 'test', () => false)
})

test('human recovery preserves the uncertain receipt and binds confirmation to its hash', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-recovery-'))
  const relative = 'processes/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json'
  try {
    await mkdir(path.join(root, 'processes'))
    const original = JSON.stringify({ host: os.hostname(), pid: 0, status: 'starting', kind: 'harness' })
    await writeFile(path.join(root, relative), original)
    await assert.rejects(requireChildProcessesStopped(root), /不确定/)
    await assert.rejects(confirmStoppedReceipt(root, relative, 'wrong', 'Inspected process tree and native journal; no live descendants'), /已变化/)
    await confirmStoppedReceipt(root, relative, sha256(original), 'Inspected process tree and native journal; no live descendants')
    await requireChildProcessesStopped(root)
    assert.equal(await readFile(path.join(root, relative), 'utf8'), original)
    await writeFile(path.join(root, relative), original + ' ')
    await assert.rejects(requireChildProcessesStopped(root), /不确定/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
