import { mkdir, statfs } from 'node:fs/promises'
import { cloudRoot } from './git'
import { CloudError } from './domain'

export function minimumFreeBytes(value = process.env.CLOUD_AGENT_MIN_FREE_GIB) {
  const gib = value === undefined ? 5 : Number(value)
  if (!Number.isFinite(gib) || gib < 1 || gib > 1024) throw new CloudError('CLOUD_AGENT_MIN_FREE_GIB 必须在 1-1024 之间', 503)
  return gib * 1024 ** 3
}
export async function checkCloudCapacity() {
  await mkdir(cloudRoot(), { recursive: true })
  const usage = await statfs(cloudRoot())
  const free = usage.bavail * usage.bsize, minimum = minimumFreeBytes()
  if (free < minimum) throw new CloudError(`运行盘空间不足：剩余 ${(free / 1024 ** 3).toFixed(1)} GiB，至少需要 ${(minimum / 1024 ** 3).toFixed(1)} GiB；请先归档已完成任务`, 503)
  return { freeBytes: free, minimumBytes: minimum }
}
