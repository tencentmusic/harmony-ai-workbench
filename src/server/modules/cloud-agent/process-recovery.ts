import path from 'node:path'
import os from 'node:os'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { CloudError, record } from './domain'
import { scopedPath, sha256 } from './scoped-files'

function assertLocalDead(receipt: Record<string, unknown>) {
  if (receipt.host !== os.hostname()) throw new CloudError('只能核验本机进程树', 409)
  if (receipt.pid === 0 && receipt.status === 'starting') return
  if (!Number.isSafeInteger(receipt.pid) || Number(receipt.pid) <= 0) throw new CloudError('进程登记非法', 409)
  try { process.kill(Number(receipt.pid), 0) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error }
  throw new CloudError('登记 PID 仍存在，不能确认停止', 409)
}

export async function confirmStoppedReceipt(root: string, relative: string, expectedHash: string, reason: string) {
  if (!/^(processes\/[a-f0-9-]{36}\.json|code-review\/[a-f0-9-]{36}\/instance\.json)$/.test(relative) || reason.trim().length < 10 || reason.length > 2000) throw new CloudError('请指定子进程收据及完整人工核验依据')
  const file = await scopedPath(root, relative, ['processes', 'code-review'])
  const bytes = await readFile(file), receipt = record(JSON.parse(bytes.toString()))
  if (sha256(bytes) !== expectedHash) throw new CloudError('收据已变化，需重新核验', 409)
  assertLocalDead(receipt)
  const confirmation = { receiptHash: expectedHash, host: os.hostname(), operator: os.userInfo().username, confirmedAt: new Date().toISOString(), reason }
  await writeFile(await scopedPath(root, `${relative}.confirmed.json`, ['processes', 'code-review'], true), JSON.stringify(confirmation, null, 2), { flag: 'wx' })
  return confirmation
}

export function requireStopped(receipt: Record<string, unknown>, label: string, alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
}) {
  if (receipt.status === 'uncertain' || receipt.status === 'starting') throw new CloudError(`${label} 子进程状态不确定，必须核验进程树与原生日志，不能自动恢复`, 409)
  if (receipt.stoppedAt || receipt.status === 'stopped') return
  if (receipt.host !== os.hostname() || !Number.isSafeInteger(receipt.pid) || Number(receipt.pid) <= 0) throw new CloudError(`${label} 实例归属无法确认`, 409)
  if (alive(Number(receipt.pid))) throw new CloudError(`${label} 实例 PID 仍存在，不能恢复`, 409)
  if (receipt.kind === 'harness') throw new CloudError(`${label} 主进程已退出，但子进程停止未确认`, 409)
}

export async function requireChildProcessesStopped(artifactRoot: string) {
  for (const kind of ['processes', 'code-review']) {
    const entries = await readdir(path.join(artifactRoot, kind)).catch(e => { if (e.code === 'ENOENT') return []; throw e })
    for (const name of entries) {
      if (!/^[a-f0-9-]{36}(?:\.json)?$/.test(name)) continue
      const relative = kind === 'processes' ? `${kind}/${name}` : `${kind}/${name}/instance.json`
      try {
        const file = await scopedPath(artifactRoot, relative, [kind])
        const bytes = await readFile(file), receipt = record(JSON.parse(bytes.toString()))
        try { requireStopped(receipt, kind) } catch (error) {
          const confirmation = await readFile(await scopedPath(artifactRoot, `${relative}.confirmed.json`, [kind], true), 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e })
          if (!confirmation) throw error
          const checked = record(JSON.parse(confirmation))
          if (checked.receiptHash !== sha256(bytes) || checked.host !== os.hostname() || typeof checked.reason !== 'string' || checked.reason.trim().length < 10) throw error
          assertLocalDead(receipt)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        throw new CloudError('子实例登记不完整，必须核验后恢复', 409)
      }
    }
  }
}

export async function requireHarnessJournalSettled(runDir: string) {
  const journal = await readFile(path.join(runDir, 'harness-events.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  const latest = new Map<string, string>()
  for (const line of journal.split(/\r?\n/).filter(line => line.trim())) {
    let event: Record<string, unknown>
    try { event = record(JSON.parse(line)) } catch { throw new CloudError('Harness 日志不完整，不能解除恢复锁', 409) }
    if (typeof event.operation_id !== 'string' || typeof event.status !== 'string') throw new CloudError('Harness 日志缺少操作状态，不能解除恢复锁', 409)
    latest.set(event.operation_id, event.status)
  }
  if ([...latest.values()].some(status => !['committed', 'failed', 'rolled_back'].includes(status))) throw new CloudError('Harness 仍有未完成记录，需先核对原操作收据，不能只确认进程退出就解锁', 409)
}
