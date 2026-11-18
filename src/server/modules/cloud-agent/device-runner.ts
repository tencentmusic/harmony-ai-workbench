import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CloudError, CloudRecoveryError, record } from './domain'
import { type HarnessWorkspace } from './harness'
import { invokeRuntime } from './native-runtime'
import { immutableJson, checkedEvidence, validateDeviceEvidence } from './device-evidence'
import { parseDevicePlan, scenarioRows, extractNodeValue, bindObservation } from './device-plan'
import { sha256 } from './scoped-files'
import { observeSurfaceMotion, type MotionSample } from './device-motion'

export interface DeviceRunnerRequest {
  workspace: HarnessWorkspace; plan: unknown; operationId: string
  device: { hdc: string; target: string; bundle: string; ability: string }
  installationSessionId: string; outputRoot: string
}

type DeviceRunnerIO = {
  invoke?: typeof invokeRuntime
  environment?: (parameter: string) => Promise<{ stdout: string; stderr: string }>
  cwd?: string
}
export async function runDeviceScenario(request: DeviceRunnerRequest, signal: AbortSignal, io: DeviceRunnerIO = {}) {
  const { workspace, operationId, device, outputRoot } = request
  const invoke = io.invoke || invokeRuntime
  const manifest = record(JSON.parse(await readFile(path.join(workspace.runDir, 'manifest.json'), 'utf8')))
  const parity = record(JSON.parse(await readFile(path.join(workspace.runDir, 'parity-matrix.json'), 'utf8')))
  const verification = record(JSON.parse(await readFile(path.join(workspace.runDir, 'verification-report.json'), 'utf8')))
  const build = record(verification.build)
  const scenario = scenarioRows(parity.scenarios).find(row => row.id === record(request.plan).scenarioId)
  if (!scenario) throw new CloudError('业务场景不存在', 409)
  const plan = parseDevicePlan(request.plan, scenario)
  const attempt = `test-${sha256(operationId).slice(0, 32)}`
  const complete = async (result: Record<string, unknown>) => {
    const resultRef = await immutableJson(path.join(outputRoot, 'result.json'), result)
    await invoke(workspace, 'acceptance', { kind: 'finish', issue_id: scenario.id, attempt_id: attempt, outcome: result.status === 'passed' ? 'improved' : 'unchanged', progress: result.status === 'passed', finding: result.status === 'passed' ? 'Native execution and canonical assertions validated; independent review remains required' : JSON.stringify(result.issues), spent: 0, evidence: [resultRef] }, `${attempt}-finish`, signal)
    await immutableJson(path.join(outputRoot, 'completed.json'), { operationId, result: resultRef })
  }
  const priorResult = await readFile(path.join(outputRoot, 'result.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (priorResult) {
    const result = record(JSON.parse(priorResult))
    const raw = record(JSON.parse((await checkedEvidence(workspace, result.execution)).bytes.toString()))
    if (record(raw.session).id !== operationId || raw.scenario_id !== plan.scenarioId) throw new CloudRecoveryError('设备结果不属于当前操作', 409)
    await complete(result)
    return result
  }
  const fixtureCheck = await immutableJson(path.join(outputRoot, 'scenario.json'), scenario)
  const readiness = await validateDeviceEvidence(workspace, fixtureCheck.path, signal, 'fixture')
  if (readiness.issues.length) throw new CloudError(`当前场景 fixture 未就绪：${JSON.stringify(readiness.issues)}`, 409)
  const fixture = record(scenario.fixture)
  await checkedEvidence(workspace, fixture.artifact)
  const environmentFile = path.join(outputRoot, 'device-environment.json')
  const previousEnvironment = await readFile(environmentFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
  const environment: Record<string, unknown> = previousEnvironment ? record(JSON.parse(previousEnvironment)) : {}
  if (!previousEnvironment) for (const [key, parameter] of [['device_model', 'const.product.model'], ['os_version', 'const.ohos.fullname']]) {
    const argv = ['-t', device.target, 'shell', 'param', 'get', parameter]
    const response = io.environment ? await io.environment(parameter) : await promisify(execFile)(device.hdc, argv, { signal, shell: false, windowsHide: true, timeout: 15000, maxBuffer: 100000 })
    if (!response.stdout.trim() || /error|fail|not found/i.test(response.stdout)) throw new CloudError(`设备 ${parameter} 读取失败`, 409)
    environment[key] = response.stdout.trim()
    environment[`${key}_command`] = { argv: [device.hdc, ...argv], stdout: response.stdout, stderr: response.stderr, exit_code: 0 }
  }
  const environmentRef = await immutableJson(environmentFile, environment)
  const sessionFile = path.join(outputRoot, 'session.json')
  const prior = await readFile(sessionFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
  const session = prior ? record(JSON.parse(prior)) : { id: operationId, executor: { path: process.execPath, sha256: sha256(await readFile(process.execPath)) }, argv: [process.execPath, ...process.execArgv, ...process.argv.slice(1)], cwd: io.cwd || process.cwd(), started_at: new Date().toISOString() }
  await immutableJson(sessionFile, session)
  await invoke(workspace, 'acceptance', { kind: 'start', issue_id: scenario.id, failure_kind: 'evidence_missing', hypothesis: 'Execute the approved scenario with current installation and real UI observations', strategy: 'Native bounded device actions and canonical assertion validation', next_action: String(scenarioRows(scenario.actions)[0].target), phase: 'execute', reserved_spend: 0 }, attempt, signal)
  const actions: Record<string, unknown>[] = [], assertions: Record<string, unknown>[] = []
  const allEvidence: { path: string; sha256: string }[] = []
  let result: Record<string, unknown>
  try {
    for (const [actionIndex, action] of plan.actions.entries()) {
      const evidence: { path: string; sha256: string }[] = []
      const motionSamples: MotionSample[] = []
      for (const [stepIndex, step] of action.steps.entries()) {
        signal.throwIfAborted()
        const stepId = `${attempt}-${actionIndex}-${stepIndex}`
        const result = await invoke(workspace, 'device-step', { issue_id: scenario.id, attempt_id: attempt, installation_session_id: request.installationSessionId, device, action: step, effect: ['observe', 'wait_for_text'].includes(step.kind) ? 'read_only' : 'navigation', screen_timeout_policy: 'preserve', timeout_seconds: 45, reserved_spend: 0 }, stepId, signal)
        const receipt = record(result.receipt)
        if (receipt.status !== 'completed') throw new CloudError(`设备步骤未完成：${String(receipt.error || receipt.status)}`, 409)
        const rawRef = await immutableJson(path.join(outputRoot, `raw-${actionIndex}-${stepIndex}.json`), receipt)
        const snapshots = scenarioRows(receipt.observations), snapshot = snapshots.at(-1)
        if (!snapshot) throw new CloudError('原生设备步骤没有观察', 409)
        const layout = await checkedEvidence(workspace, snapshot.layout)
        const screenshot = await checkedEvidence(workspace, snapshot.screenshot)
        const nodes = scenarioRows(snapshot.nodes)
        if (action.bindings.some(binding => binding.field === 'frame_motion')) motionSamples.push({ at: Number(snapshot.at), nodes, image: screenshot.bytes })
        // Native home/back may observe another bundle. Only the final app observation is assertable.
        const visible = nodes.some(node => node.bundleName === device.bundle)
        if (!visible && stepIndex === action.steps.length - 1) throw new CloudError('动作结束时目标 App 不在前台', 409)
        const data: Record<string, unknown> = { nodes, native_operation_id: stepId }
        if (stepIndex === action.steps.length - 1) for (const binding of action.bindings) {
          const assertion = scenarioRows(scenario.assertions).find(row => row.id === binding.assertionId)!
          if (binding.field === 'frame_motion') {
            const motion = await observeSurfaceMotion(motionSamples, binding, device.bundle)
            bindObservation(data, assertion.selector, motion.value)
            data.surface_motion = motion.evidence
          } else bindObservation(data, assertion.selector, extractNodeValue(nodes, binding, device.bundle))
        }
        const observation = await immutableJson(path.join(outputRoot, `observation-${actionIndex}-${stepIndex}.json`), { schema_version: 1, record_type: 'harness_action_observation', session_id: operationId, scenario_id: scenario.id, action_id: action.id, observed_at: new Date(Number(snapshot.at) * 1000).toISOString(), kind: 'ui_snapshot', target: device.target, foreground_bundle: visible ? device.bundle : String(nodes.find(node => node.bundleName)?.bundleName || ''), data, provenance: { receipt: rawRef, layout: { path: layout.path, sha256: layout.sha256 }, screenshot: { path: screenshot.path, sha256: screenshot.sha256 } } })
        allEvidence.push(observation)
        // Keep non-app intermediate navigation raw; the action's final app observation proves its completion.
        if (visible) evidence.push(observation)
        if (stepIndex === action.steps.length - 1) for (const binding of action.bindings) assertions.push({ id: binding.assertionId, observation })
      }
      actions.push({ id: action.id, target: scenarioRows(scenario.actions)[actionIndex].target, status: 'completed', evidence })
    }
    const deviceId = `D-${scenario.id}`, functionalId = `F-${scenario.id}`
    const execution = await immutableJson(path.join(outputRoot, 'execution.json'), { schema_version: 1, record_type: 'harness_execution', run_id: manifest.run_id, scenario_id: scenario.id, case_ids: [deviceId, functionalId], acceptance_ids: scenario.acceptance_ids, execution_kind: 'device_observed', status: 'passed', source_snapshot: build.source_snapshot, hap_sha256: build.artifact_sha256, fixture: { id: fixture.id, sha256: record(fixture.artifact).sha256 }, session: { ...session, exit_code: 0, finished_at: new Date().toISOString() }, device: { target: device.target, bundle_name: device.bundle, foreground_bundle: device.bundle }, actions, assertions, plan: request.plan, intermediate_observations: allEvidence })
    const candidate = { id: deviceId, scenario_id: scenario.id, acceptance_ids: scenario.acceptance_ids, execution_kind: 'device_observed', status: 'passed', account_or_room: plan.accountOrRoom, execution, evidence: [execution] }
    const candidateRef = await immutableJson(path.join(outputRoot, 'case-candidate.json'), candidate)
    const validation = await validateDeviceEvidence(workspace, candidateRef.path, signal)
    result = { status: validation.issues.length ? 'failed' : 'passed', scenarioId: scenario.id, issues: validation.issues, candidate, execution, environment: environmentRef }
    await immutableJson(path.join(outputRoot, 'result.json'), result)
  } catch (error) {
    if (error instanceof CloudRecoveryError || signal.aborted) throw error
    const failure = await immutableJson(path.join(outputRoot, 'failure.json'), { error: error instanceof Error ? error.message : String(error), evidence: allEvidence })
    await invoke(workspace, 'acceptance', { kind: 'finish', issue_id: scenario.id, attempt_id: attempt, outcome: 'tool_failed', progress: false, finding: error instanceof Error ? error.message : 'Device execution failed', spent: 0, evidence: [failure] }, `${attempt}-failed`, signal)
    throw error
  }
  // Settlement can be retried without replaying any device action or changing its outcome.
  await complete(result)
  return result
}
