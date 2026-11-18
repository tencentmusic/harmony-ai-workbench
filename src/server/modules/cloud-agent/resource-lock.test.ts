import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { acquireResource } from './resource-lock'

test('cancelled device owner retains uncertain lock but can release after confirmed tool settlement', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'resource-lock-')), previous = process.env.CLOUD_AGENT_RUNTIME_ROOT
  process.env.CLOUD_AGENT_RUNTIME_ROOT = root
  try {
  const identity = randomUUID(), controller = new AbortController()
  const release = await acquireResource('test', identity, 'owner', controller.signal)
  controller.abort()
  await release()
  await assert.rejects(acquireResource('test', identity, 'other', new AbortController().signal), /占用/)
  await release(true)
  const second = await acquireResource('test', identity, 'other', new AbortController().signal)
  await second()
  await second()
  await assert.rejects(acquireResource('test', identity, 'aborted', controller.signal))
  const third = await acquireResource('test', identity, 'third', new AbortController().signal)
  const [lock] = await readdir(path.join(root, 'resource-locks'))
  const receiptPath = path.join(root, 'resource-locks', lock, 'owner.json')
  const receipt = await readFile(receiptPath, 'utf8')
  await writeFile(receiptPath, JSON.stringify({ owner: 'replacement' }))
  await assert.rejects(third(true), /归属已变化/)
  assert.equal(await readFile(receiptPath, 'utf8'), JSON.stringify({ owner: 'replacement' }))
  await writeFile(receiptPath, receipt)
  await third()
  } finally {
    if (previous === undefined) delete process.env.CLOUD_AGENT_RUNTIME_ROOT
    else process.env.CLOUD_AGENT_RUNTIME_ROOT = previous
    await rm(root, { recursive: true, force: true })
  }
})
