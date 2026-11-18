import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, rename, copyFile, stat } from 'node:fs/promises'
import { CloudError, CloudRecoveryError, CloudEnvironmentError, record } from './domain'
import { executionConfig } from './execution-config'
import { harnessCommand, harnessBuildFacts, harnessCodeFacts, verifyHarness, type HarnessWorkspace } from './harness'
import { scopedPath, sha256 } from './scoped-files'
import { taskTool, textResult } from './task-tools'
import { acquireResource } from './resource-lock'
import type { CloudHarness } from '@/contracts/cloud-agent'
import { requireCodeReview } from './code-review'
import { checkCloudCapacity } from './capacity'
import { invokeRuntime, runtimeEvidence } from './native-runtime'
import { completeRuntimeCloseout } from './runtime-closeout'
import { saveVisualReport } from './visual-report'
import { meetsNativePhase } from './harness-domain'
import { checkBuildEnvironment, buildPreflightGuard, checkHarmonySdkEnvironment } from './build-preflight'
import { prepareBuildDependencies } from './build-dependencies'
import { readBuildEnvironmentDiagnostic } from './build-diagnostics'
import { buildOutputRoot } from './build-output'
import { buildExecutionId, readExecutionLog, buildFailureMessage, previousBuildFailure, needsFreshPackageBuild } from './build-retry'
import { requireHarnessJournalSettled } from './process-recovery'
import { deviceExecutorIssue, requireDeviceExecutor } from './device-executor'
import { nativeDeviceContext, runNativeDeviceTest } from './native-device-executor'
import { reviewDeviceExecution } from './device-review'
import { prepareAcceptanceCapture, executeAcceptanceCapture, captureAfterDeviceTest } from './acceptance-capture'
import { checkedEvidence } from './device-evidence'

export const DELIVERY_DOCS = { scope: '迁移范围.md', requirements: '鸿蒙迁移需求说明.md', 'technical-plan': '鸿蒙技术方案.md', 'acceptance-report': '迁移验收用例.md' }
const execute = promisify(execFile)
async function appendDocumentLocators(workspace: HarnessWorkspace, out: string) {
  const parity = record(JSON.parse(await readFile(path.join(workspace.runDir, 'parity-matrix.json'), 'utf8')))
  const exclusions = Array.isArray(parity.test_exclusions) ? parity.test_exclusions : []
  if (exclusions.length) {
    const rows: string[] = []
    for (const ref of exclusions) {
      const checked = await checkedEvidence(workspace, ref)
      const decision = record(JSON.parse(checked.bytes.toString('utf8')))
      rows.push(`- ${String(decision.scenario_id)}：排除动作 ${JSON.stringify(decision.excluded_action_ids)}，未执行，不计为测试通过。决定人：${String(decision.reviewer)}；依据：${String(decision.basis)}；决定引用：${String(decision.approval_reference)}；原记录 SHA256：${checked.sha256}`)
    }
    for (const document of Object.values(DELIVERY_DOCS)) {
      const file = path.join(out, document), content = await readFile(file, 'utf8')
      const section = '\n\n## 人工确认的测试排除\n\n' + rows.join('\n') + '\n'
      if (!content.includes(section)) await writeFile(file, content + section)
    }
  }
  // Native JSON facts escape Windows separators; the delivery gate also requires literal locators.
  for (const [source, document] of [['traceability-map.json', DELIVERY_DOCS['technical-plan']], ['verification-report.json', DELIVERY_DOCS['acceptance-report']]]) {
    const facts = JSON.parse(await readFile(path.join(workspace.runDir, source), 'utf8')) as unknown
    const locations = new Set<string>()
    const collect = (value: unknown) => {
      if (Array.isArray(value)) { value.forEach(collect); return }
      if (!value || typeof value !== 'object') return
      for (const [key, item] of Object.entries(value)) {
        if (['path', 'locator'].includes(key) && typeof item === 'string') locations.add(item)
        else if (key !== 'delivery') collect(item)
      }
    }
    collect(facts)
    const file = path.join(out, document), content = await readFile(file, 'utf8')
    const missing = [...locations].filter(location => !content.includes(location))
    if (missing.length) await writeFile(file, content + '\n\n## 原始证据定位\n\n' + missing.map(location => `- ${location}`).join('\n') + '\n')
  }
}
export function safeOperation(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new CloudError('操作 ID 非法')
  return value
}
export async function acceptanceTools(workspace: HarnessWorkspace, signal: AbortSignal, publish: (s: CloudHarness) => Promise<void>, execution = true, notice: (message: string) => Promise<void> = async () => {}, model = 'gpt-6-astra') {
  const config = executionConfig(workspace.appId)
  const preflightBuild = buildPreflightGuard(async () => {
    if (!config.build) throw new CloudEnvironmentError('App 未配置 execution.build；请管理员配置后重启 Worker 再继续，无需重新审批', 503)
    await checkBuildEnvironment(workspace.harmonyRoot, config.build.command, signal)
    await checkHarmonySdkEnvironment()
  })
  let releaseDevice: ((confirmedStopped?: boolean) => Promise<void>) | undefined
  let target = ''
  let releaseAndroid: ((confirmedStopped?: boolean) => Promise<void>) | undefined
  let androidTarget = ''
  let uncertainDevice = false
  const deviceRuntime = async (action: 'device-step' | 'device-smoke' | 'device-prepare' | 'android-reference', payload: unknown, operationId: string) => {
    try {
      const result = await invokeRuntime(workspace, action, payload, operationId, signal)
      if (result.reconciled && record(result.receipt || {}).status !== 'in_doubt') uncertainDevice = false
      return { ...textResult({ result, status: await checkpoint() }), ...(record(result.receipt || {}).status === 'failed' ? { isError: true } : {}) }
    } catch (error) { if (error instanceof CloudRecoveryError) uncertainDevice = true; throw error }
  }
  const checkpoint = async () => { const v = await verifyHarness(workspace, signal); await publish(v.status); return v.status }
  const gate = async (minimum: string) => { const v = await verifyHarness(workspace, signal, minimum); await publish(v.status); if (!meetsNativePhase(v.raw, minimum)) throw new CloudError(`Harness ${minimum} 尚未通过`, 409) }
  const folder = async (id: string) => { const dir = path.join(workspace.artifactRoot, 'execution', safeOperation(id)); await mkdir(dir, { recursive: true }); return dir }
  const claimDevice = async () => {
    if (!config.device) throw new CloudError('该 App 未配置执行机 hdc', 503)
    if (releaseDevice) return target
    const result = await execute(config.device.hdc, ['list', 'targets'], { signal, windowsHide: true, timeout: 15000, maxBuffer: 100000 })
    const targets = result.stdout.trim().split(/\r?\n/).map(s => s.trim()).filter(s => s && s !== '[Empty]')
    target = config.device.target || (targets.length === 1 ? targets[0] : '')
    if (!target || !targets.includes(target) || !/^[\w.:-]{1,100}$/.test(target)) throw new CloudError('未连接设备或存在多台设备；请连接设备或在 App 配置中指定 target', 409)
    releaseDevice = await acquireResource('device', target, workspace.identity, signal)
    return target
  }
  const string = { type: 'string' }
  const captureTransform = { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object' } }
  const captureCurrentState = async (capture: Awaited<ReturnType<typeof prepareAcceptanceCapture>>) => {
    try {
      return await executeAcceptanceCapture(workspace, capture, {
        gate: () => gate('build_passed'),
        claimDevice: async () => ({ target: await claimDevice(), hdc: config.device!.hdc }),
        command: argv => harnessCommand(argv, signal),
        saveReport: (state, comparison) => saveVisualReport(workspace, state, comparison),
      })
    } catch (error) { if (error instanceof CloudRecoveryError || signal.aborted) uncertainDevice = true; throw error }
  }
  const tools = [
    taskTool('harness_device_context', '只读核对档案/源码/当前安装包身份、最近安装和独立取证；先诊断，不重装、不改业务代码', {}, [], async () => textResult(JSON.parse(await harnessCommand(['runtime', '--run-dir', workspace.runDir, '--action', 'device-context'], signal)))),
    taskTool('harness_device_smoke', '无需fixture/attempt/正式适配器。observe取当前截图和控件树；可传logTag只读采集指定标签的设备日志，返回日志文件SHA256，供核对真实配置/响应/播放身份，不把日志当作业务PASS。模拟器 HDC 不支持录屏，recordSeconds默认0，模拟器保持0并用截图继续验收。读取原图后dismiss关闭遮挡弹窗，需observationOperationId、hierarchy和reason（说明控件的视觉依据）；不要按“同意/登录”等文案词汇拒绝业务。正式场景交互用harness_device_step。新观察用新operationId，同一动作重试沿用原ID；操作前校验控件，操作后返回新截图。仅候选证据，不代表验收PASS', { action: { enum: ['launch', 'observe', 'dismiss'] }, operationId: string, observationOperationId: string, hierarchy: string, reason: string, recordSeconds: { type: 'integer', minimum: 0, maximum: 30 }, logTag: string }, ['action'], async args => {
      if (!['launch', 'observe', 'dismiss'].includes(String(args.action))) throw new CloudError('冒烟仅支持启动、观察或关闭普通弹窗')
      if (args.action === 'dismiss' && (!args.operationId || !args.observationOperationId || typeof args.hierarchy !== 'string' || !args.hierarchy || typeof args.reason !== 'string' || !args.reason.trim())) throw new CloudError('关闭弹窗须提供操作ID、当前观察ID、唯一控件hierarchy及关闭依据')
      const seconds = args.recordSeconds === undefined ? 0 : args.recordSeconds
      if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 0 || seconds > 30) throw new CloudError('录屏时长须为0到30秒')
      if (args.logTag !== undefined && (args.action !== 'observe' || typeof args.logTag !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(args.logTag))) throw new CloudError('仅观察支持安全设备日志标签')
      await gate('build_passed')
      const device = await claimDevice()
      const manifest = record(JSON.parse(await readFile(path.join(workspace.runDir, 'manifest.json'), 'utf8')))
      const verification = record(JSON.parse(await readFile(path.join(workspace.runDir, 'verification-report.json'), 'utf8')))
      const sessions = Array.isArray(verification.install_sessions) ? verification.install_sessions.map(record).filter(row => row.target === device) : []
      const session = sessions.at(-1)
      if (!session || session.status !== 'passed') throw new CloudError('先用 harness_device_context 核验身份及安装；安装命令成功但包名查询失败时修正 application，再 harness_install mode=verify_existing，无需重装', 409)
      const payload = { action: { kind: args.action, ...(args.action === 'dismiss' ? { observation_operation_id: safeOperation(args.observationOperationId), hierarchy: args.hierarchy, reason: args.reason } : {}) }, effect: args.action === 'observe' ? 'read_only' : 'navigation', timeout_seconds: 120, record_seconds: seconds, ...(args.logTag ? { log_tag: args.logTag } : {}), ...(seconds ? { recording_adapter_version: 2 } : {}), installation_session_id: session.id, device: { hdc: config.device!.hdc, target: device, bundle: record(manifest.application).bundle_name, ability: config.device!.ability || 'EntryAbility' } }
      return deviceRuntime('device-smoke', payload, args.operationId === undefined ? `smoke-${sha256(JSON.stringify(payload)).slice(0, 40)}` : safeOperation(args.operationId))
    }),
    taskTool('harness_build_context', '读取登记的构建目录、缓存和产物根、精确包路径及最新失败原因。存在旧包不代表构建通过；配置更正后更新原生依赖并继续', {}, [], async () => {
      const b = config.build
      if (!b) return textResult({ configured: false })
      const cacheRoot = await buildOutputRoot(workspace, b.cacheRoot)
      const outputRoot = b.outputRoot === 'cache' ? cacheRoot : workspace.harmonyRoot
      const packages = await Promise.all([b.artifact, ...b.dependencies].map(async relative => {
        const file = await scopedPath(outputRoot, relative, [''], true)
        const info = await stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error })
        return { relative, path: file, exists: !!info?.isFile(), size: info?.size || 0 }
      }))
      return textResult({ build: b, harmonyRoot: workspace.harmonyRoot, cacheRoot: b.cacheRoot ? cacheRoot : null, outputRoot, packages, automaticRecovery: { missingIncrementalSignedPackage: 'retry_once_with_no_incremental', preservesSourceAndApproval: true }, previousFailure: await previousBuildFailure(workspace) })
    }),
    taskTool('execution_config', '读取本 App 已登记构建、设备、Android对照和交付能力；未配置依赖仅挂起相关工作', {}, [], async () => textResult({ build: config.build || null, device: config.device ? { configured: true, executor: config.device.executor || 'external', adapter: config.device.executor === 'native' || !!config.device.descriptor && !!config.device.descriptorSha256, formalTestIssue: deviceExecutorIssue(config.device), independentSmoke: true, target: config.device.target || 'single-connected-device', ability: config.device.ability || 'EntryAbility' } : null, androidReference: config.androidReference || null, delivery: !!config.delivery?.enabled })),
    taskTool('harness_test_context', '读取 canonical 场景、fixture 和内置设备验收方案格式；先观察真实控件再准备方案，不接受手写观察或 PASS', {}, [], async () => textResult(await nativeDeviceContext(workspace))),
    taskTool('harness_device_review', '所有设备场景完成后，由独立只读模型复核原始执行、截图与断言；不是实现者自批，也不替代真人视觉审核', {}, [], async () => {
      const result = await reviewDeviceExecution(workspace, model, signal, notice)
      return textResult({ result, status: await checkpoint() })
    }),
    taskTool('harness_android_reference', '对配置的Android设备做受控源码端对照，payload 遵循 android-reference，不接受 device 覆盖。分析阶段只允许观察/导航；写入按已审授权。只产生候选证据，不替代Harmony验收', { payload: { type: 'object' }, operationId: string }, ['payload', 'operationId'], async args => {
      const payload = record(args.payload), d = config.androidReference
      if (payload.device !== undefined) throw new CloudError('设备身份由App配置提供', 403)
      if (payload.reconcile_operation_id !== undefined) throw new CloudError('未决设备操作须由运维核验，Agent不能自行解除', 403)
      if (!execution && !['read_only', 'navigation'].includes(String(payload.effect))) throw new CloudError('分析阶段仅能观察或导航', 403)
      if (!d) throw new CloudError('App 未配置 execution.android_reference；登记相关依赖并继续独立工作', 409)
      if (!releaseAndroid) {
        const response = await execute(d.adb, ['devices'], { signal, windowsHide: true, timeout: 15000, maxBuffer: 100000 })
        const devices = response.stdout.split(/\r?\n/).flatMap(line => { const match = /^([\w.:-]+)\s+device$/.exec(line.trim()); return match ? [match[1]] : [] })
        androidTarget = d.target || (devices.length === 1 ? devices[0] : '')
        if (!androidTarget || !devices.includes(androidTarget)) throw new CloudError('Android设备未授权或不唯一，请连接设备或配置 target', 409)
        releaseAndroid = await acquireResource('device', `android:${androidTarget}`, workspace.identity, signal)
      }
      return deviceRuntime('android-reference', await runtimeEvidence(workspace, { ...payload, device: { ...d, target: androidTarget } }), safeOperation(args.operationId))
    }),
    taskTool('harness_device_prepare', '准备独占鸿蒙调试设备，设置并回读2小时息屏时间；失败仅记录警告，不表示解锁或验收通过', { operationId: string }, ['operationId'], async args => {
      const device = await claimDevice()
      return deviceRuntime('device-prepare', { device: { hdc: config.device!.hdc, target: device } }, safeOperation(args.operationId))
    }),
    taskTool('harness_device_step', '通过原生device-step观察、按文字点击、滑动和导航。先安装当前包并start验收attempt；payload不含device或installation_session_id，由平台绑定。多帧采集预留足够timeout_seconds（建议90秒）；若动作命令成功但后置dumpLayout超时导致in_doubt，只用原operationId及原payload核验收据，不换ID重放动作，结算后另做新观察。屏幕生命周期测试传screen_timeout_policy=preserve。观察不代表业务PASS', { payload: { type: 'object' }, operationId: string }, ['payload', 'operationId'], async args => {
      const payload = record(args.payload)
      if (payload.device !== undefined || payload.installation_session_id !== undefined) throw new CloudError('设备和安装会话由平台绑定', 403)
      if (payload.reconcile_operation_id !== undefined) throw new CloudError('未决设备操作须由运维核验，Agent不能自行解除', 403)
      await gate('build_passed')
      const device = await claimDevice()
      const manifest = record(JSON.parse(await readFile(path.join(workspace.runDir, 'manifest.json'), 'utf8')))
      const verification = record(JSON.parse(await readFile(path.join(workspace.runDir, 'verification-report.json'), 'utf8')))
      const sessions = Array.isArray(verification.install_sessions) ? verification.install_sessions.map(record).filter(row => row.target === device) : []
      if (!sessions.length) throw new CloudError('先调用 harness_install 建立当前包安装会话', 409)
      return deviceRuntime('device-step', await runtimeEvidence(workspace, { ...payload, installation_session_id: sessions.at(-1)!.id, device: { hdc: config.device!.hdc, target: device, bundle: record(manifest.application).bundle_name, ability: config.device!.ability || 'EntryAbility' } }), safeOperation(args.operationId))
    }),
    taskTool('harness_build_log', '只读当前任务 execution/<构建ID>/build.log 或 adapter.log；默认尾部，offset按字节分页。可读取大日志和NUL字符，原证据不修改。失败先读日志，不盲目重建', { path: string, offset: { type: 'integer', minimum: 0 } }, ['path'], async args => textResult(await readExecutionLog(workspace.artifactRoot, args.path, args.offset === undefined ? undefined : Number(args.offset)))),
    taskTool('harness_build', '执行管理员登记的 Hvigor debug 构建。平台绑定源码快照与配置生成执行ID，返回实际日志路径；增量签名错误跳过产物时自动非增量重建一次。其他确定失败先读日志修复，未决操作禁止重放。不接受模型shell', { operationId: string }, ['operationId'], async function runBuild(args, forceRegenerate = false) {
      await preflightBuild()
      await gate('wired')
      await requireCodeReview(workspace, signal)
      await checkCloudCapacity()
      if (!config.build) throw new CloudError('App 未配置 execution.build；需要管理员登记精确构建目录、argv 和产物路径', 503)
      const b = forceRegenerate ? { ...config.build, command: [...config.build.command.filter(value => !['--incremental', '--no-incremental'].includes(value)), '--no-incremental'] } : config.build
      const cwd = b.cwd === '.' ? workspace.harmonyRoot : await scopedPath(workspace.harmonyRoot, b.cwd, [''])
      await requireHarnessJournalSettled(workspace.runDir)
      const facts = await harnessCodeFacts(workspace, signal)
      const operationId = buildExecutionId(args.operationId, facts.snapshot, { build: b, cwd, sdk: process.env.DEVECO_SDK_HOME || '' })
      const out = await folder(operationId)
      await notice(`构建执行 ${operationId}；日志 execution/${operationId}/build.log`)
      const release = await acquireResource('build', workspace.harmonyRoot, workspace.identity, signal)
      let uncertain = false
      let retryFresh = false
      try {
        const cacheRoot = await buildOutputRoot(workspace, b.cacheRoot)
        const outputRoot = b.outputRoot === 'cache' ? cacheRoot : workspace.harmonyRoot
        const artifact = await scopedPath(outputRoot, b.artifact, [''], true)
        await prepareBuildDependencies(workspace, b, signal, notice)
        await requireCodeReview(workspace, signal)
        const dependencies = await Promise.all(b.dependencies.map(p => scopedPath(outputRoot, p, [''], true)))
        // Preserve old dependency outputs; only newly generated files may be registered.
        const prepared = path.join(out, 'dependencies-prepared.json')
        const previous = await readFile(prepared, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e })
        if (previous === null) {
          for (const [i, file] of dependencies.entries()) {
            const backup = path.join(out, `previous-${i}.hsp`)
            const old = await readFile(backup).catch(e => { if (e.code === 'ENOENT') return null; throw e })
            if (old) {
              const current = await readFile(file).catch(e => { if (e.code === 'ENOENT') return null; throw e })
              if (current) throw new CloudError('依赖包准备曾中断，需人工核验，不能复用旧包', 409)
            } else await rename(file, backup).catch(e => { if (e.code !== 'ENOENT') throw e })
          }
          await writeFile(prepared, JSON.stringify(dependencies), { flag: 'wx' })
        } else if (previous !== JSON.stringify(dependencies)) throw new CloudError('同一构建操作的依赖包配置已变化', 409)
        try {
          await harnessCommand(['run-build', '--run-dir', workspace.runDir, '--operation-id', operationId, '--cwd', cwd, '--artifact', artifact,
            '--artifact-copy', path.join(out, path.basename(artifact)), '--log', path.join(out, 'build.log'), '--timeout-seconds', String(b.timeoutSeconds), ...(b.cacheRoot ? ['--build-cache-root', cacheRoot] : []), '--command', ...b.command], signal, (b.timeoutSeconds + 60) * 1000)
        } catch (error) {
          if (error instanceof CloudRecoveryError || signal.aborted) throw error
          const diagnosis = await readBuildEnvironmentDiagnostic(path.join(out, 'build.log')).catch(() => null)
          if (diagnosis) throw new CloudEnvironmentError(`${diagnosis} 日志：execution/${operationId}/build.log`, 503)
          const logPath = `execution/${operationId}/build.log`
          const log = await readExecutionLog(workspace.artifactRoot, logPath).catch(() => null)
          throw new CloudError(buildFailureMessage(error, log?.text || '', logPath), 409)
        }
        if (dependencies.length) {
          const facts = await harnessBuildFacts(workspace, signal)
          const packages = [{ id: 'primary', kind: path.extname(artifact).slice(1), role: 'primary', path: facts.build.artifact_path, sha256: facts.build.artifact_sha256, source_snapshot: facts.build.source_snapshot }]
          for (const [i, file] of dependencies.entries()) {
            await scopedPath(outputRoot, b.dependencies[i], [''])
            const destination = path.join(out, `dependency-${i}.hsp`)
            const bytes = await readFile(file)
            await copyFile(file, destination, 1).catch(async e => { if (e.code !== 'EEXIST' || sha256(await readFile(destination)) !== sha256(bytes)) throw e })
            packages.push({ id: `dependency-${i}`, kind: 'hsp', role: 'dependency', path: destination, sha256: sha256(bytes), source_snapshot: facts.build.source_snapshot })
          }
          const payload = path.join(out, 'package-set.json'), contents = JSON.stringify({ schema_version: 1, run_id: facts.runId, build_receipt_sha256: facts.digest, packages })
          await writeFile(payload, contents, { flag: 'wx' }).catch(async e => { if (e.code !== 'EEXIST' || await readFile(payload, 'utf8') !== contents) throw e })
          await harnessCommand(['record-package-set', '--run-dir', workspace.runDir, '--operation-id', `${operationId}-packages`, '--input', payload], signal)
        }
        return textResult(await checkpoint())
      } catch (error) {
        uncertain = error instanceof CloudRecoveryError
        const log = !uncertain && !signal.aborted && !forceRegenerate && b.command.includes('--incremental')
          ? await readExecutionLog(workspace.artifactRoot, `execution/${operationId}/build.log`).catch(() => null) : null
        if (log && needsFreshPackageBuild(log.text)) retryFresh = true
        else throw error
      } finally { if (!uncertain) await release() }
      if (retryFresh) {
        await notice('增量签名缓存跳过已移出的旧包，自动非增量重建一次；保留首轮失败收据，不修改业务源码')
        return runBuild(args, true)
      }
      throw new CloudError('构建未返回有效结果', 409)
    }),
    taskTool('harness_install', '安装当前build/package-set。已有成功安装但身份查询失败时用mode=verify_existing重新核验，不重装；不导航、不冒充验收', { operationId: string, mode: { enum: ['install', 'verify_existing'] } }, ['operationId'], async args => {
      await gate('build_passed')
      if (args.mode !== undefined && !['install', 'verify_existing'].includes(String(args.mode))) throw new CloudError('安装模式非法')
      const device = await claimDevice(), out = await folder(String(args.operationId))
      await harnessCommand(['capture-screen', '--run-dir', workspace.runDir, args.mode === 'verify_existing' ? '--reconcile-installation' : '--prepare-installation', '--output', path.join(out, 'installation'), '--hdc', config.device!.hdc, '--target', device, '--operation-id', safeOperation(args.operationId)], signal, 300000)
      return textResult(await checkpoint())
    }),
    taskTool('harness_test', '执行真实业务验收。native 模式先 harness_test_context，planPath 指定 candidates 下单场景计划。若最后停留在已批准视觉状态，优先显式传 captureStateId 和 captureTransform，成功后立即原地执行真实截图/对比，避免为视觉重复导航；须读取 canonical 状态和视口，不得猜测。功能结果与 capture 独立，截图失败或复用旧场景时仅补 harness_capture，不重放业务动作。不会自动批准视觉结果。外部适配器不支持附带截图。不能提交 PASS、任意 shell 或修改预期', { operationId: string, planPath: string, captureStateId: string, captureTransform }, ['operationId'], async args => {
      if (args.captureTransform !== undefined && args.captureStateId === undefined) throw new CloudError('captureTransform 必须同时指定 captureStateId')
      if (args.captureStateId !== undefined && config.device?.executor !== 'native') throw new CloudError('附带视觉采集只支持 native 设备执行器')
      if (config.device?.executor === 'native') {
        safeOperation(args.operationId)
        if (typeof args.planPath !== 'string') throw new CloudError('内置执行器需要 planPath；先 harness_test_context 获取格式', 409)
        const capture = args.captureStateId === undefined ? undefined : await prepareAcceptanceCapture(workspace,
          `test-visual-${sha256(String(args.operationId)).slice(0, 40)}`, args.captureStateId, args.captureTransform)
        await gate('build_passed')
        const target = await claimDevice()
        try {
          const invocationStartedAt = Date.now()
          const result = await runNativeDeviceTest(workspace, config.device, target, args.planPath, String(args.operationId), signal, notice)
          if (capture) {
            const visual = await captureAfterDeviceTest(workspace, capture, result, invocationStartedAt, signal, () => captureCurrentState(capture))
            if (visual.status === 'recovery_required') {
              uncertainDevice = true
              throw new CloudRecoveryError(JSON.stringify({ result, capture: visual, partial: true, status: null }), 409)
            }
            // Preserve the already registered functional result even if capture or its status refresh fails.
            let status: CloudHarness | null = null, statusError: string | undefined
            if (uncertainDevice) statusError = '设备采集操作未决；保留功能结果和设备锁，先核验未决操作'
            else try { status = await checkpoint() } catch (error) {
              if (error instanceof CloudRecoveryError) {
                uncertainDevice = true
                throw new CloudRecoveryError(JSON.stringify({ result, capture: visual, partial: true, status: null, statusError: error.message }), 409)
              }
              statusError = error instanceof Error ? error.message : String(error)
            }
            return textResult({ result, capture: visual, partial: visual.status !== 'captured' || !!visual.comparisonRefreshRequired || !!statusError, status, ...(statusError ? { statusError } : {}) })
          }
          return textResult({ result, status: await checkpoint() })
        } catch (error) { if (error instanceof CloudRecoveryError) uncertainDevice = true; throw error }
      }
      const descriptor = await requireDeviceExecutor(config.device)
      await gate('build_passed')
      const device = await claimDevice(), d = config.device!
      const out = await folder(String(args.operationId)), input = path.join(out, 'request.json'), receiptPath = path.join(out, 'adapter-receipt.json')
      const payload = JSON.stringify({ runDir: workspace.runDir, artifactRoot: workspace.artifactRoot, target: device, hdc: d.hdc, outputRoot: out })
      await writeFile(input, payload, { flag: 'wx' }).catch(async error => { if (error.code !== 'EEXIST' || await readFile(input, 'utf8') !== payload) throw error })
      await harnessCommand(['adapter-run', '--run-dir', workspace.runDir, '--descriptor', descriptor, '--operation-id', safeOperation(args.operationId), '--capability', 'device-test', '--input', input, '--output', receiptPath, '--log', path.join(out, 'adapter.log'), '--timeout-seconds', '1800'], signal, 1860000)
      const receipt = record(JSON.parse(await readFile(receiptPath, 'utf8')))
      const outputs = Array.isArray(receipt.outputs) ? receipt.outputs.map(record) : []
      // Only files declared and hash-bound by the trusted executor may become runtime evidence.
      for (const [name, command, section] of [['device.json', 'record-device', ''], ['functional.json', 'record-functional', ''], ['independent-review.json', 'record-functional', 'independent-review']]) {
        const item = outputs.find(o => typeof o.path === 'string' && path.basename(o.path) === name)
        if (!item) throw new CloudError(`设备执行器缺少 ${name}；未宣布验收通过`, 409)
        const file = await scopedPath(workspace.artifactRoot, path.relative(workspace.artifactRoot, String(item.path)).replaceAll('\\', '/'), ['execution'])
        if (sha256(await readFile(file)) !== item.sha256) throw new CloudError('执行器输出哈希不符', 409)
        await harnessCommand([command, '--run-dir', workspace.runDir, '--operation-id', `${safeOperation(args.operationId)}-${name.replaceAll('.', '-')}`, '--input', file, ...(section ? ['--section', section] : [])], signal)
      }
      return textResult(await checkpoint())
    }),
    taskTool('harness_capture', '已确认当前页面是批准状态后采集前台截图并计算差异，不导航、不重跑功能场景、不批准视觉。尺寸与已批准视口不同时可传 captureTransform，例如 [{op:"resize",width:582,height:1280,resample:"lanczos"}]，状态和尺寸须读取已审清单，不能猜测。保留原图及转换来源，不改基线/ROI/mask/阈值，不裁掉待验区域；不能用截图替代业务验收', { operationId: string, stateId: string, captureTransform }, ['operationId', 'stateId'], async args => {
      const prepared = await prepareAcceptanceCapture(workspace, safeOperation(args.operationId), args.stateId, args.captureTransform)
      const capture = await captureCurrentState(prepared)
      return textResult({ ...await checkpoint(), capture })
    }),
    taskTool('harness_finalize', '从真实档案渲染四份交付文档并调用 finalize；所有验收和独立复核通过才产生 delivery_ready，不提交推送', { operationId: string }, ['operationId'], async args => {
      await gate('functional_parity_passed')
      await requireCodeReview(workspace, signal)
      const out = path.join(await folder(String(args.operationId)), 'docs')
      await harnessCommand(['render-docs', '--run-dir', workspace.runDir, '--output-dir', out], signal)
      await appendDocumentLocators(workspace, out)
      await completeRuntimeCloseout(workspace, out, safeOperation(args.operationId), signal)
      await harnessCommand(['finalize', '--run-dir', workspace.runDir, '--prepared-by', 'cloud-agent', '--basis', 'Current verified Harness evidence', '--operation-id', safeOperation(args.operationId), ...Object.entries(DELIVERY_DOCS).flatMap(([role, file]) => [`--${role}`, path.join(out, file)])], signal)
      return textResult(await checkpoint())
    }),
  ]
  return { tools: execution ? tools : tools.filter(tool => ['execution_config', 'harness_android_reference'].includes(tool.definition.name)), close: async (confirmedStopped = !signal.aborted) => { if (uncertainDevice || !confirmedStopped) return; if (releaseDevice) await releaseDevice(confirmedStopped); if (releaseAndroid) await releaseAndroid(confirmedStopped) } }
}
