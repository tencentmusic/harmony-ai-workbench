import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

function running(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}
export async function acquireWorkerLock(root) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const file = path.join(root, 'worker.lock')
  const guardPath = path.join(root, 'worker-recovery.lock')
  const guard = await open(guardPath, 'wx', 0o600).catch(() => { throw new Error('worker lock recovery is already running; verify ownership before retry') })
  const owner = { pid: process.pid, host: hostname(), nonce: randomUUID(), startedAt: new Date().toISOString() }
  try {
    let previous
    try { previous = JSON.parse(await readFile(file, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw new Error('worker lock is unreadable; manual inspection required') }
    if (previous) {
      if ((previous.host && previous.host !== owner.host) || !Number.isSafeInteger(previous.pid) || previous.pid <= 0 || running(previous.pid)) throw new Error('previous worker may still be running; refusing duplicate worker')
      await unlink(file)
    }
    const lock = await open(file, 'wx', 0o600)
    try { await lock.writeFile(JSON.stringify(owner)) } finally { await lock.close() }
  } finally { await guard.close(); await unlink(guardPath) }
  return async () => {
    const current = JSON.parse(await readFile(file, 'utf8'))
    if (current.nonce === owner.nonce) await unlink(file)
  }
}
