import { readFile } from 'node:fs/promises'
import { runDeviceScenario, deviceExecutorExitCode } from '../../src/server/modules/cloud-agent/public.ts'

const request = JSON.parse(await readFile(process.argv[2], 'utf8'))
const signal = AbortSignal.timeout(20 * 60 * 1000)
try {
  const result = await runDeviceScenario(request, signal)
  console.log(JSON.stringify({ status: result.status, scenarioId: result.scenarioId, issues: result.issues }))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = deviceExecutorExitCode(error, signal.aborted)
}
