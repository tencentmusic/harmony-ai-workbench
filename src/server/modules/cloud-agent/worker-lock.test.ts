import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { acquireWorkerLock } from '../../../../workers/cloud-agent/lock.mjs'

test('worker lock refuses live owner, recovers a confirmed dead local owner', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-lock-test-'))
  try {
    const release = await acquireWorkerLock(root)
    await assert.rejects(acquireWorkerLock(root), /previous worker/)
    assert.equal(JSON.parse(await readFile(path.join(root, 'worker.lock'), 'utf8')).pid, process.pid)
    await release()
    const deadPid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).trim())
    await writeFile(path.join(root, 'worker.lock'), JSON.stringify({ pid: deadPid, host: os.hostname() }))
    const recoveredRelease = await acquireWorkerLock(root)
    await recoveredRelease()
    await writeFile(path.join(root, 'worker.lock'), JSON.stringify({ pid: deadPid, host: 'another-host' }))
    await assert.rejects(acquireWorkerLock(root), /previous worker/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
