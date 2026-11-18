import path from 'node:path'
import { loadWorkbenchEnv } from '../../scripts/render-opencode-config.mjs'
import { acquireWorkerLock } from './lock.mjs'

loadWorkbenchEnv()
const root = path.resolve(process.env.CLOUD_AGENT_RUNTIME_ROOT || '.runtime/cloud-agent')
let release
try { release = await acquireWorkerLock(root) } catch (error) {
  console.error(`[cloud-agent] ${error.message}`)
  process.exit(1)
}
const controller = new AbortController()
process.on('SIGINT', () => controller.abort())
process.on('SIGTERM', () => controller.abort())
try {
  const { runCloudWorker } = await import('../../src/server/modules/cloud-agent/public.ts')
  console.log('[cloud-agent] worker ready; independent analysis instances start only for queued tasks')
  await runCloudWorker(controller.signal)
} finally {
  await release()
}
