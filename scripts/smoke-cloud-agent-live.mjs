import assert from 'node:assert/strict'
import { loadWorkbenchEnv } from './render-opencode-config.mjs'

loadWorkbenchEnv()
const { runAnalysisInstance } = await import('../src/server/modules/cloud-agent/runtime.ts')
const { cloudProjects } = await import('../src/server/modules/cloud-agent/config.ts')
const model = cloudProjects()[0]?.model
assert.ok(model, 'No enabled Cloud Agent project configured')
let receipt
const start = Date.now()
const result = await runAnalysisInstance({ model, signal: AbortSignal.timeout(55000),
  prompt: 'This is a connectivity smoke test, not a development task. Use no tools. Reply with exactly the JSON object {"ok":true}.',
  onInstance: async value => { receipt = value }, onProgress: async () => {},
})
assert.deepEqual(JSON.parse(result.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')), { ok: true })
assert.ok(receipt.stoppedAt)
console.log(JSON.stringify({ passed: true, model, elapsedMs: Date.now() - start, version: receipt.version, stopped: true }))
