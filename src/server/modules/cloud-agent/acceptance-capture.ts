import path from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import type { HarnessWorkspace } from './harness'
import { CloudError, CloudRecoveryError, record } from './domain'
import { scopedPath, relativeToRoot, sha256 } from './scoped-files'
import { checkedEvidence, immutableJson } from './device-evidence'
import { prepareCaptureTransform } from './capture-transform'

interface PreparedCapture {
  operationId: string; stateId: string; directory: string
  imagePath: string; comparisonPath: string; transformArgs: string[]
}
interface CaptureResult {
  status: 'captured'; operationId: string; stateId: string; humanReviewRequired: true
  automaticStatus: string; comparisonEnvironmentSha256: string
  comparisonRefreshRequired?: boolean; nextAction?: string
  image: { path: string; sha256: string }; comparison: { path: string; sha256: string }
}
interface CaptureIssue {
  status: 'failed' | 'recovery_required' | 'skipped'; operationId: string; stateId: string
  reason?: string; error?: string; nextAction: string; persistenceError?: string
}
type CaptureOutcome = CaptureResult | CaptureIssue
type CaptureIO = {
  gate: () => Promise<void>
  claimDevice: () => Promise<{ hdc: string; target: string }>
  command: (argv: string[]) => Promise<string>
  saveReport: (state: string, comparison: unknown) => Promise<void>
}

async function comparisonEnvironment(workspace: HarnessWorkspace) {
  const verification = record(JSON.parse(await readFile(path.join(workspace.runDir, 'verification-report.json'), 'utf8')))
  return sha256(JSON.stringify(record(verification.device || {}).environment || {}))
}

async function approvedState(workspace: HarnessWorkspace, stateId: unknown) {
  if (typeof stateId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(stateId)) throw new CloudError('Explicit canonical capture state ID required')
  const parity = record(JSON.parse(await readFile(path.join(workspace.runDir, 'parity-matrix.json'), 'utf8')))
  const scope = record(parity.ui_scope || {}), review = record(parity.ui_review || {})
  if (scope.status !== 'required' || review.status !== 'approved' || !Array.isArray(scope.states) ||
    scope.states.filter(value => record(value).id === stateId).length !== 1 ||
    !Array.isArray(review.required_states) || !review.required_states.includes(stateId)) {
    throw new CloudError('Capture state must be in the approved canonical UI scope; read the approved state inventory first', 409)
  }
  return stateId
}

export async function prepareAcceptanceCapture(workspace: HarnessWorkspace, operationId: string, inputState: unknown, transform: unknown) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(operationId)) throw new CloudError('Invalid capture operation ID')
  const stateId = await approvedState(workspace, inputState)
  const directory = await scopedPath(workspace.artifactRoot, `execution/${operationId}`, ['execution'], true)
  await mkdir(directory, { recursive: true })
  const transformArgs = await prepareCaptureTransform(directory, transform)
  await immutableJson(path.join(directory, 'capture-request.json'), { stateId, transform: transform ?? null })
  return { operationId, stateId, directory, transformArgs, imagePath: path.join(directory, `${stateId}.png`), comparisonPath: path.join(directory, 'comparison.json') }
}

export async function executeAcceptanceCapture(workspace: HarnessWorkspace, capture: PreparedCapture, io: CaptureIO): Promise<CaptureResult> {
  const { operationId, stateId, imagePath, transformArgs } = capture
  await approvedState(workspace, stateId)
  await io.gate()
  const device = await io.claimDevice()
  await io.command(['capture-screen', '--run-dir', workspace.runDir, '--state-id', stateId, '--output', imagePath,
    '--hdc', device.hdc, '--target', device.target, '--operation-id', `${operationId}-capture`])
  // Later scenarios change the aggregate environment, not this capture. Recompare without another device visit.
  const environment = await comparisonEnvironment(workspace)
  // Native comparison adds image suffixes/subdirectories; keep Windows paths short.
  const comparisonPath = path.join(capture.directory, `comparison-${environment.slice(0, 16)}.json`)
  const comparison = await io.command(['compare-visual', '--run-dir', workspace.runDir, '--state-id', stateId,
    '--harmony-capture', imagePath, '--comparison-report', comparisonPath, ...transformArgs, '--operation-id', `${operationId}-cmp2-${environment.slice(0, 16)}`])
  const report = await readFile(comparisonPath)
  const automatic = record(JSON.parse(report.toString('utf8')))
  // The preview index is optional; native provenance and comparison receipts remain authoritative.
  await io.saveReport(stateId, JSON.parse(comparison)).catch(() => {})
  return { status: 'captured', operationId, stateId, humanReviewRequired: true,
    comparisonEnvironmentSha256: environment,
    automaticStatus: typeof automatic.status === 'string' ? automatic.status : 'unknown',
    image: { path: imagePath, sha256: sha256(await readFile(imagePath)) }, comparison: { path: comparisonPath, sha256: sha256(report) } }
}

export async function captureAfterDeviceTest(workspace: HarnessWorkspace, capture: PreparedCapture, result: Record<string, unknown>,
  invocationStartedAt: number, signal: AbortSignal, execute: () => Promise<CaptureResult>): Promise<CaptureOutcome> {
  const identity = { operationId: capture.operationId, stateId: capture.stateId }
  const retry = 'Keep the functional result. Confirm the current approved page, then use harness_capture only; do not replay harness_test actions.'
  const issue = (error: unknown): CaptureIssue => ({ ...identity,
    status: error instanceof CloudRecoveryError || signal.aborted ? 'recovery_required' : 'failed',
    error: error instanceof Error ? error.message : String(error),
    nextAction: error instanceof CloudRecoveryError || signal.aborted
      ? 'Keep the functional result and device lock. Reconcile the unsettled capture operation before any further device action.' : retry })
  if (result.status !== 'passed') return { ...identity, status: 'skipped', reason: 'device_scenario_not_passed', nextAction: 'Inspect the functional result first; no visual capture was attempted.' }
  let execution: { path: string; sha256: string }
  let outcome: CaptureOutcome
  const outcomePath = path.join(capture.directory, 'device-capture-outcome.json')
  try {
    if (typeof result.outputRoot !== 'string') throw new CloudError('Native device result has no evidence directory', 409)
    const root = await scopedPath(workspace.artifactRoot, await relativeToRoot(workspace.artifactRoot, result.outputRoot), ['execution'])
    const completed = record(JSON.parse(await readFile(path.join(root, 'completed.json'), 'utf8')))
    const saved = record(JSON.parse((await checkedEvidence(workspace, completed.result)).bytes.toString('utf8')))
    const checked = await checkedEvidence(workspace, saved.execution)
    const raw = record(JSON.parse(checked.bytes.toString('utf8')))
    if (saved.status !== 'passed' || raw.status !== 'passed' || saved.scenarioId !== result.scenarioId || raw.scenario_id !== result.scenarioId) {
      throw new CloudError('Capture requires a matching passed native execution', 409)
    }
    execution = { path: checked.path, sha256: checked.sha256 }
    const prior = await readFile(outcomePath, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (prior) {
      const stored = record(JSON.parse(prior)), binding = record(stored.execution), previous = record(stored.capture)
      if (binding.path !== execution.path || binding.sha256 !== execution.sha256 || previous.stateId !== capture.stateId || previous.operationId !== capture.operationId) {
        throw new CloudError('Capture operation belongs to a different device execution; preserve it and use a new capture operation ID', 409)
      }
      if (previous.status === 'captured') {
        const image = await checkedEvidence(workspace, previous.image), comparison = await checkedEvidence(workspace, previous.comparison)
        if (image.path !== capture.imagePath || path.dirname(comparison.path) !== capture.directory ||
          !/^comparison(?:-(?:[a-f0-9]{16}|[a-f0-9]{64}))?\.json$/.test(path.basename(comparison.path)) || previous.humanReviewRequired !== true) throw new CloudError('Saved capture evidence does not match the operation', 409)
        if (previous.comparisonEnvironmentSha256 !== await comparisonEnvironment(workspace)) return {
          ...previous as unknown as CaptureResult, comparisonRefreshRequired: true,
          nextAction: `Use harness_capture with operationId=${capture.operationId}, stateId=${capture.stateId} and the identical captureTransform. Native capture replays its existing receipt; only comparison is refreshed. Do not navigate or replay functional actions.`,
        }
      } else if (!['failed', 'recovery_required'].includes(String(previous.status))) throw new CloudError('Invalid saved capture outcome', 409)
      return previous as unknown as CaptureOutcome
    }
    // A cached scenario does not establish where the device is now. Never navigate or recapture it implicitly.
    const startedAt = Date.parse(String(record(raw.session).started_at))
    if (!Number.isFinite(startedAt) || startedAt <= invocationStartedAt) {
      return { ...identity, status: 'skipped', reason: 'reused_device_result_requires_current_state_confirmation', nextAction: retry }
    }
    try { signal.throwIfAborted(); outcome = await execute() } catch (error) { outcome = issue(error) }
  } catch (error) { return issue(error) }
  try { await immutableJson(outcomePath, { execution, capture: outcome }) }
  catch (error) { return { ...issue(error), ...(outcome.status === 'recovery_required' ? outcome : {}), persistenceError: String(error) } }
  return outcome
}
