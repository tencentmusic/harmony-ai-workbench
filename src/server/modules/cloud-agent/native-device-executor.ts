import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { CloudError, CloudRecoveryError, record } from './domain'
import { harnessCommand, harnessEnvironment, harnessRoot, type HarnessWorkspace } from './harness'
import { parseDevicePlan, scenarioRows } from './device-plan'
import { immutableJson, checkedEvidence, validateDeviceEvidence } from './device-evidence'
import { scopedPath, sha256 } from './scoped-files'
import type { ExecutionConfig } from './execution-config'
import type { DeviceRunnerRequest } from './device-runner'
import { deviceChildFailure } from './device-executor'

const execute = promisify(execFile)
export async function deviceExecutorFingerprint() {
  const files = ['device-plan.ts', 'device-runner.ts', 'device-motion.ts', 'device-evidence.ts', 'native-runtime.ts']
  const hashes = []
  for (const file of files) hashes.push([file, sha256(await readFile(fileURLToPath(new URL(file, import.meta.url))))])
  return sha256(JSON.stringify(hashes))
}
class StaleDeviceEvidenceError extends CloudError {}
// The prior executor's node-only observations retain their original semantics and are revalidated.
const compatibleExecutors = new Set([
  '0039c4a70a59fd5949ed76f98c03c2fddd5a3778839f9e11a634d4b945a0dc4a',
  '88609c81a250d0990d63ac65de079e94915b48e005d17b52512dddb9728bbcf4',
])
async function json(file: string) { return record(JSON.parse(await readFile(file, 'utf8'))) }
export async function nativeDeviceContext(workspace: HarnessWorkspace) {
  const parity = await json(path.join(workspace.runDir, 'parity-matrix.json'))
  return { executor: 'native', scenarios: parity.scenarios, planDirectory: 'candidates',
    instructions: '先 observe 读取实际控件，准备真实 fixture 并用原生 record-parity 仅更新 fixture。为单个场景写 candidates 下声明式计划，再调用 harness_test(planPath,operationId)。不能填写观察值；bindings 从本动作最后一次真实控件树中按 where 精确唯一匹配并提取 field。仅观察/导航，不执行网络、开关、登录、权限或付费操作。失败保留结果，不改预期；所有设备场景完成后用 harness_device_review 独立复核。',
    example: { version: 1, scenarioId: '<canonical scenario id>', accountOrRoom: '<本次实际观察的账号/房间，未知明确写未知>', actions: [{ id: '<canonical action id>', steps: [{ kind: 'text_tap', text: '<截图中实际文字>' }, { kind: 'wait_for_text', text: '<目标页面实际文字>' }], bindings: [{ assertionId: '<canonical assertion id>', where: { id: '<实际控件id>' }, field: 'bounds' }] }] },
    supportedSteps: ['observe', 'text_tap', 'wait_for_text', 'swipe(points:[x1,y1,x2,y2])', 'back', 'home', 'launch'],
    limitations: '存在控件只能证明存在。frame_motion 绑定需 where.type=Video或XComponent、至少三个纯observe步骤，检验同一位置视频表面的连续画面；不能证明音频、失败回退或生命周期，仍需独立复核。',
  }
}

async function executeChild(request: DeviceRunnerRequest, requestFile: string, signal: AbortSignal) {
  const receiptFile = path.join(request.workspace.artifactRoot, 'processes', `${randomUUID()}.json`)
  await mkdir(path.dirname(receiptFile), { recursive: true })
  const receipt = { kind: 'harness', command: 'native-device-executor', host: os.hostname(), pid: 0, startedAt: new Date().toISOString(), status: 'starting' }
  await immutableJson(receiptFile, receipt)
  const running = execute(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', pathToFileURL(path.resolve('scripts/register-ts.mjs')).href, '--experimental-strip-types', path.resolve('workers/cloud-agent/device-executor.mjs'), requestFile], {
    cwd: request.outputRoot, env: { ...harnessEnvironment(), CLOUD_AGENT_HARNESS_ROOT: harnessRoot(), ...(process.env.CLOUD_AGENT_HARNESS_PYTHON ? { CLOUD_AGENT_HARNESS_PYTHON: process.env.CLOUD_AGENT_HARNESS_PYTHON } : {}) },
    signal, timeout: 21 * 60 * 1000, windowsHide: true, shell: false, maxBuffer: 2 * 1024 * 1024,
  })
  void running.catch(() => {})
  receipt.pid = running.child.pid || 0; receipt.status = 'running'
  await writeFile(receiptFile, JSON.stringify(receipt))
  try {
    const result = await running
    receipt.status = 'stopped'
    await writeFile(receiptFile, JSON.stringify(receipt))
    await writeFile(path.join(request.outputRoot, 'executor.log'), result.stdout + '\n' + result.stderr)
  } catch (error) {
    const failure = error as { killed?: boolean; signal?: string; stdout?: string; stderr?: string }
    const classified = deviceChildFailure(error, running.child, signal.aborted)
    receipt.status = classified instanceof CloudRecoveryError ? 'uncertain' : 'stopped'
    await writeFile(receiptFile, JSON.stringify(receipt))
    await writeFile(path.join(request.outputRoot, 'executor.log'), (failure.stdout || '') + '\n' + (failure.stderr || String(error)))
    throw classified
  }
}
async function validateSaved(workspace: HarnessWorkspace, result: Record<string, unknown>, signal: AbortSignal) {
  const execution = await checkedEvidence(workspace, result.execution)
  const raw = record(JSON.parse(execution.bytes.toString()))
  for (const action of scenarioRows(raw.actions)) for (const item of scenarioRows(action.evidence)) {
    const observation = await checkedEvidence(workspace, item)
    const provenance = record(record(JSON.parse(observation.bytes.toString())).provenance)
    for (const ref of Object.values(provenance)) await checkedEvidence(workspace, ref)
  }
  const candidateFile = path.join(path.dirname(execution.path), 'case-candidate.json')
  if (JSON.stringify(await json(candidateFile)) !== JSON.stringify(result.candidate)) throw new CloudError('设备执行结果与候选收据不一致', 409)
  const validation = await validateDeviceEvidence(workspace, candidateFile, signal)
  if (validation.issues.length) throw new StaleDeviceEvidenceError(`历史设备结果已失效：${JSON.stringify(validation.issues)}`, 409)
}
export async function runNativeDeviceTest(workspace: HarnessWorkspace, device: NonNullable<ExecutionConfig['device']>, target: string, planPath: string, operationId: string, signal: AbortSignal, notice: (text: string) => Promise<void>) {
  const planFile = await scopedPath(workspace.artifactRoot, planPath, ['candidates'])
  const parity = await json(path.join(workspace.runDir, 'parity-matrix.json'))
  const planValue = await json(planFile)
  const scenario = scenarioRows(parity.scenarios).find(row => row.id === planValue.scenarioId)
  if (!scenario) throw new CloudError('计划引用未知业务场景', 409)
  const plan = parseDevicePlan(planValue, scenario)
  const manifest = await json(path.join(workspace.runDir, 'manifest.json'))
  const verification = await json(path.join(workspace.runDir, 'verification-report.json'))
  const build = record(verification.build)
  const session = scenarioRows(verification.install_sessions).filter(row => row.target === target).at(-1)
  if (!session || session.status !== 'passed') throw new CloudError('先建立当前包的原生安装会话', 409)
  const executor = await deviceExecutorFingerprint()
  const fingerprint = sha256(JSON.stringify({ executor, plan, scenario, build: build.artifact_sha256, source: build.source_snapshot, installation: session.id, target }))
  const folder = path.join(workspace.artifactRoot, 'execution', `native-device-${fingerprint.slice(0, 32)}`)
  await mkdir(folder, { recursive: true })
  const operationFile = path.join(folder, 'operation.json')
  const old = await readFile(operationFile, 'utf8').then(text => record(JSON.parse(text)), error => { if (error.code === 'ENOENT') return null; throw error })
  const effectiveId = old ? String(old.operationId) : operationId
  await immutableJson(operationFile, { fingerprint, operationId: effectiveId })
  const resultPath = path.join(folder, 'result.json')
  let result = await readFile(resultPath, 'utf8').then(text => record(JSON.parse(text)), error => { if (error.code === 'ENOENT') return null; throw error })
  const completion = await readFile(path.join(folder, 'completed.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (!result || !completion) {
    const failed = await readFile(path.join(folder, 'failure.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (failed) throw new CloudError(`相同设备方案已失败，先诊断并修订真实定位/步骤，不重复执行：${failed.slice(0, 1500)}`, 409)
    const request: DeviceRunnerRequest = { workspace, plan, operationId: effectiveId, device: { hdc: device.hdc, target, bundle: String(record(manifest.application).bundle_name), ability: device.ability || 'EntryAbility' }, installationSessionId: String(session.id), outputRoot: folder }
    const requestRef = await immutableJson(path.join(folder, 'request.json'), request)
    await notice(`设备验收：执行 ${plan.scenarioId}；${plan.actions.reduce((count, action) => count + action.steps.length, 0)} 个原生步骤，复用当前安装`)
    await executeChild(request, requestRef.path, signal)
    result = await json(resultPath)
  } else await notice(`设备验收：复用 ${plan.scenarioId} 已持久化结果，重新校验证据，不重放动作`)
  const finished = await json(path.join(folder, 'completed.json'))
  if (finished.operationId !== effectiveId || (await checkedEvidence(workspace, finished.result)).bytes.toString() !== await readFile(resultPath, 'utf8')) throw new CloudRecoveryError('设备执行收尾收据不一致，不能登记通过', 409)
  if (result.status !== 'passed') return { ...result, candidate: undefined, outputRoot: folder }
  await validateSaved(workspace, result, signal)
  const index = path.join(workspace.artifactRoot, 'device-tests')
  await mkdir(index, { recursive: true })
  await writeFile(path.join(index, `${sha256(plan.scenarioId)}.json`), JSON.stringify({ result: { path: resultPath, sha256: sha256(await readFile(resultPath)) }, fingerprint, executor }))
  return { status: 'passed', scenarioId: plan.scenarioId, outputRoot: folder, ...await registerDeviceResults(workspace, signal) }
}

export async function registerDeviceResults(workspace: HarnessWorkspace, signal: AbortSignal) {
  const parity = await json(path.join(workspace.runDir, 'parity-matrix.json'))
  const verification = await json(path.join(workspace.runDir, 'verification-report.json'))
  const scenarios = scenarioRows(parity.scenarios)
  const cases: Record<string, unknown>[] = [], rawExecutions: Record<string, unknown>[] = [], environments: Record<string, unknown>[] = []
  const missing: string[] = []
  const executor = await deviceExecutorFingerprint()
  for (const scenario of scenarios) {
    const index = await readFile(path.join(workspace.artifactRoot, 'device-tests', `${sha256(String(scenario.id))}.json`), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (!index) { missing.push(String(scenario.id)); continue }
    const indexed = record(JSON.parse(index))
    if (indexed.executor !== executor && !compatibleExecutors.has(String(indexed.executor))) { missing.push(String(scenario.id)); continue }
    const saved = await checkedEvidence(workspace, indexed.result)
    const result = record(JSON.parse(saved.bytes.toString()))
    try { await validateSaved(workspace, result, signal) } catch (error) { if (signal.aborted || !(error instanceof StaleDeviceEvidenceError)) throw error; missing.push(String(scenario.id)); continue }
    cases.push(record(result.candidate))
    environments.push(record(JSON.parse((await checkedEvidence(workspace, result.environment)).bytes.toString())))
    rawExecutions.push(record(JSON.parse((await checkedEvidence(workspace, result.execution)).bytes.toString())))
  }
  if (!cases.length) return { missing }
  const build = record(verification.build)
  const targets = new Set(rawExecutions.map(raw => record(raw.device).target))
  if (targets.size !== 1) throw new CloudError('设备场景不属于同一目标设备', 409)
  if (new Set(environments.map(env => JSON.stringify([env.device_model, env.os_version]))).size !== 1) throw new CloudError('设备型号或系统版本已变化，需要重验受影响场景', 409)
  const device = { status: missing.length ? 'not_run' : 'passed', source_snapshot: build.source_snapshot, environment: { device_model: environments[0].device_model, os_version: environments[0].os_version, hap_sha256: build.artifact_sha256, account: 'Existing on-device session; not changed by executor', room: cases.map(row => row.account_or_room).join('; '), tested_at: record(rawExecutions.at(-1)!.session).finished_at }, cases }
  const functional = { status: missing.length ? 'not_run' : 'passed', source_snapshot: build.source_snapshot, hap_sha256: build.artifact_sha256, cases: cases.map(row => ({ ...row, id: `F-${row.scenario_id}`, device_case_id: row.id })) }
  const out = path.join(workspace.artifactRoot, 'execution', `device-results-${sha256(JSON.stringify({ device, functional })).slice(0, 32)}`)
  await mkdir(out, { recursive: true })
  const input = await immutableJson(path.join(out, 'sections.json'), { device, functional })
  const checked = await validateDeviceEvidence(workspace, input.path, signal, 'sections')
  if (!missing.length && checked.issues.length) throw new CloudError(`设备结果汇总未通过原生校验：${JSON.stringify(checked.issues)}`, 409)
  for (const [command, data, name] of [['record-device', device, 'device'], ['record-functional', checked.functional, 'functional']] as const) {
    const file = await immutableJson(path.join(out, `${name}.json`), data)
    await harnessCommand([command, '--run-dir', workspace.runDir, '--input', file.path, '--operation-id', `device-${name}-${file.sha256.slice(0, 32)}`], signal)
  }
  return { missing, deviceStatus: device.status, independentReviewRequired: true }
}
