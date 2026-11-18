import path from 'node:path'
import { mkdir, writeFile, readFile, unlink, rmdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { cloudRoot } from './git'
import { sha256 } from './scoped-files'
import { CloudError } from './domain'

export async function acquireResource(kind: string, identity: string, owner: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const root = path.join(cloudRoot(), 'resource-locks')
  await mkdir(root, { recursive: true })
  const lock = path.join(root, `${kind}-${sha256(identity)}`)
  try { await mkdir(lock) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CloudError(`${kind} 资源被占用；等待当前任务结束，异常退出的锁须人工核验后恢复`, 409)
    throw error
  }
  const receipt = JSON.stringify({ owner, pid: process.pid, host: hostname(), time: new Date().toISOString(), token: randomUUID() })
  await writeFile(path.join(lock, 'owner.json'), receipt, { flag: 'wx' })
  let released = false
  return async (confirmedStopped = false) => {
    // An aborted process tree may still own the device/build; never silently reuse it.
    if (released || (signal.aborted && !confirmedStopped)) return
    if (await readFile(path.join(lock, 'owner.json'), 'utf8') !== receipt) throw new CloudError('资源锁归属已变化，未释放', 409)
    await unlink(path.join(lock, 'owner.json'))
    await rmdir(lock)
    released = true
  }
}
