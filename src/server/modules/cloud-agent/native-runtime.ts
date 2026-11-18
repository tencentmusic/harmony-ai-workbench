import path from 'node:path'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import sharp from 'sharp'
import type { CloudHarness } from '@/contracts/cloud-agent'
import { CloudError, CloudRecoveryError, record } from './domain'
import { harnessCommand, verifyHarness, type HarnessWorkspace } from './harness'
import { scopedPath, sha256, relativeToRoot, readScoped } from './scoped-files'
import { taskTool, textResult } from './task-tools'
import { preservePlanAuthorizations, validateRuntimeEvent } from './native-runtime-domain'
import { requireDeclaredFixtures } from './fixture-preflight'
import { previewDeviceVideo } from './device-video-preview'

export type RuntimeAction = 'execution-plan' | 'prepare-fixtures' | 'acceptance' | 'device-prepare' | 'device-step' | 'device-smoke' | 'android-reference'
export function runtimeOperation(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new CloudError('操作 ID 非法')
  return value
}
export async function runtimeJson(workspace: HarnessWorkspace, relative: string) {
  const file = await scopedPath(workspace.artifactRoot, relative, [''], true, true)
  try { return record(JSON.parse(await readFile(file, 'utf8'))) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
export async function runtimeEvidence(workspace: HarnessWorkspace, input: unknown): Promise<unknown> {
  if (Array.isArray(input)) return Promise.all(input.map(item => runtimeEvidence(workspace, item)))
  if (!input || typeof input !== 'object') return input
  const value = record(input)
  if (Object.hasOwn(value, 'path') && Object.hasOwn(value, 'sha256')) {
    if (typeof value.path !== 'string' || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new CloudError('证据引用必须包含路径和 SHA256')
    const relative = path.isAbsolute(value.path) ? await relativeToRoot(workspace.artifactRoot, value.path) : value.path
    const file = await scopedPath(workspace.artifactRoot, relative, [''], false, true)
    if (sha256(await readFile(file)) !== value.sha256) throw new CloudError('证据摘要已变化', 409)
    return { ...value, path: file }
  }
  const normalized: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) normalized[key] = await runtimeEvidence(workspace, item)
  return normalized
}
export async function invokeRuntime(workspace: HarnessWorkspace, action: RuntimeAction, payload: unknown, operationId: string, signal: AbortSignal) {
  runtimeOperation(operationId)
  const folder = await scopedPath(workspace.artifactRoot, 'requests/runtime', ['requests'], true)
  await mkdir(folder, { recursive: true })
  const contents = JSON.stringify(payload)
  if (Buffer.byteLength(contents) > 1024 * 1024) throw new CloudError('运行请求过大', 413)
  const file = path.join(folder, `${action}-${operationId}.json`)
  await writeFile(file, contents, { flag: 'wx', mode: 0o600 }).catch(async error => {
    if (error.code !== 'EEXIST') throw error
    if (await readFile(file, 'utf8') !== contents) throw new CloudError('操作 ID 已绑定其他输入，请核对原结果后使用新 ID', 409)
  })
  const result = record(JSON.parse(await harnessCommand(['runtime', '--run-dir', workspace.runDir, '--action', action, '--input', file, '--operation-id', operationId], signal, 180000)))
  const receipt = record(result.receipt || {})
  if (receipt.status === 'in_doubt') {
    const video = record(receipt.video || {})
    const action = record(receipt.action || {})
    const confirmedSwipe = receipt.record_type === 'device_observation' && receipt.action_dispatched === true &&
      action.kind === 'swipe' && receipt.effect === 'navigation' &&
      typeof receipt.error === 'string' && /dumpLayout.*timed out/i.test(receipt.error) &&
      Array.isArray(receipt.transient_captures) && receipt.transient_captures.length > 0 &&
      Array.isArray(receipt.commands) && receipt.commands.some(value => {
        const row = record(value)
        const expected = ['shell', 'uitest', 'uiInput', 'swipe', ...(Array.isArray(action.points) ? action.points.map(String) : [])]
        return row.exit_code === 0 && Array.isArray(row.argv) && row.argv.slice(-expected.length).join(' ') === expected.join(' ')
      })
    throw new CloudRecoveryError(video.status === 'awaiting_authorization'
      ? '等待手机录屏授权，尚未生成视频；请在手机核对授权弹窗并结束本次录屏后，由运维核验收据恢复。禁止重复启动录屏'
      : confirmedSwipe ? `POST_SWIPE_LAYOUT_TIMEOUT operationId=${operationId}：滑动命令已返回成功，后置层级超时；用原操作ID和原payload只读结算，不重放滑动`
      : '设备动作结果未决；已保留收据，核对前不能重放', 409)
  }
  return result
}
export async function savedPlan(workspace: HarnessWorkspace) {
  const relative = path.relative(workspace.artifactRoot, path.join(workspace.runDir, '.harness-runtime/execution-plan.json')).replaceAll('\\', '/')
  const state = await runtimeJson(workspace, relative), events = state?.events
  return Array.isArray(events) && events.length ? record(record(events.at(-1)).plan) : null
}
export async function hostGrants(workspace: HarnessWorkspace): Promise<unknown[]> {
  const saved = await runtimeJson(workspace, 'approvals/execution-grants.json')
  if (!saved) return []
  if (saved.identity !== workspace.identity || !Array.isArray(saved.grants)) throw new CloudError('执行授权所属任务不匹配', 409)
  await runtimeEvidence(workspace, saved.grants)
  return saved.grants
}
export async function acceptanceConfiguration(workspace: HarnessWorkspace) {
  const grants = (await hostGrants(workspace)).map(record)
  const paid = grants.filter(g => Array.isArray(g.effects) && g.effects.includes('paid'))
  const amount = paid.reduce((sum, grant) => sum + Number(grant.max_spend || 0), 0)
  if (!Number.isSafeInteger(amount) || amount < 0 || new Set(paid.map(g => g.currency)).size > 1) throw new CloudError('任务累计授权额度或币种无效', 409)
  return amount ? { kind: 'configure', policy: { max_spend: amount }, spend_authorization: `Human-reviewed plan: cumulative ${amount} ${paid[0].currency} smallest units`, authorization_evidence: paid.map(g => g.evidence) } : { kind: 'configure' }
}
export async function registerPlan(workspace: HarnessWorkspace, payload: unknown, operationId: string, signal: AbortSignal) {
  const plan = preservePlanAuthorizations(payload, await hostGrants(workspace))
  const manifest = await runtimeJson(workspace, path.relative(workspace.artifactRoot, path.join(workspace.runDir, 'manifest.json')).replaceAll('\\', '/'))
  if (!manifest) throw new CloudError('先初始化 Harness 档案')
  return invokeRuntime(workspace, 'execution-plan', await runtimeEvidence(workspace, { ...plan, version: 1, run_id: manifest.run_id }), operationId, signal)
}
export async function readRuntimeObservation(workspace: HarnessWorkspace, args: Record<string, unknown>, signal = AbortSignal.timeout(120000)) {
  const root = await scopedPath(workspace.artifactRoot, await relativeToRoot(workspace.artifactRoot, path.join(workspace.runDir, '.harness-runtime')), [''], false, true)
  const file = await scopedPath(root, args.path, [''], false, true)
  if (/\.mp4$/i.test(file)) return previewDeviceVideo(root, file, args.sha256, args.timestamps, signal)
  if ((await stat(file)).size > 12 * 1024 * 1024 || typeof args.sha256 !== 'string') throw new CloudError('观察文件过大或缺少摘要', 413)
  const bytes = await readFile(file)
  if (sha256(bytes) !== args.sha256) throw new CloudError('观察文件已变化', 409)
  if (!/\.(png|jpe?g|webp)$/i.test(file)) return textResult(await readScoped(root, args.path, [''], Number(args.offset || 0), true))
  const metadata = await sharp(bytes, { limitInputPixels: 24_000_000 }).metadata()
  if (!['png', 'jpeg', 'webp'].includes(metadata.format || '')) throw new CloudError('观察图片格式非法')
  const image = await sharp(bytes).resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()
  return { content: [...textResult({ path: file, sha256: args.sha256, originalWidth: metadata.width, originalHeight: metadata.height, previewOnly: true }).content, { type: 'image' as const, mimeType: 'image/jpeg', data: image.toString('base64') }] }
}
export function nativeRuntimeTools(workspace: HarnessWorkspace, signal: AbortSignal, publish: (status: CloudHarness) => Promise<void>, execution: boolean) {
  const checkpoint = async (result: unknown) => { const { status } = await verifyHarness(workspace, signal); await publish(status); return textResult({ result, status }) }
  const properties = { payload: { type: 'object' }, operationId: { type: 'string' } }
  return [
    taskTool('harness_observation_read', '按设备收据SHA256读取图片、控件树、日志或MP4。path相对runDir/.harness-runtime。MP4先返回时长/尺寸，再用timestamps指定每批1到8个时间点读取真实帧，可继续补帧；预览不自动授予播放或失败回退PASS。文本按offset分页，原件不修改', { path: { type: 'string' }, sha256: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, timestamps: { type: 'array', items: { type: 'number', minimum: 0 }, minItems: 1, maxItems: 8 } }, ['path', 'sha256'], async args => { signal.throwIfAborted(); return readRuntimeObservation(workspace, args, signal) }),
    taskTool('harness_execution_plan', '登记全部 canonical scenarios 的执行计划和依赖状态，保留 attempts。authorizations 省略以复用真人授权。新增授权写 candidates/execution-plan.json 的 requested_authorizations 随范围审核。文件引用为任务产物路径及真实哈希', properties, ['payload', 'operationId'], async args => checkpoint(await registerPlan(workspace, args.payload, runtimeOperation(args.operationId), signal))),
    ...(execution ? [
      taskTool('harness_prepare_fixtures', '仅准备执行计划中已声明 mock_fixture 和 mock_boundary 的隔离场景。payload.scenario_ids 指定场景；真机场景缺数据应登记依赖，不执行 recipe 文字，不改变预期、不登记验收通过', properties, ['payload', 'operationId'], async args => {
        const payload = record(args.payload)
        requireDeclaredFixtures(await savedPlan(workspace), payload)
        return checkpoint(await invokeRuntime(workspace, 'prepare-fixtures', payload, runtimeOperation(args.operationId), signal))
      }),
      taskTool('harness_acceptance', '记录 configure/start/finish/block/reopen/score/closeout。configure 使用平台零消费预算，恢复不重置。normal_start/configuration 需真实证据；knowledge/git_delivery/acceptance_report 仅可登记有证据的 pending，完成仍用 harness_finalize。不可关闭任务、修改时钟或代替人审', properties, ['payload', 'operationId'], async args => {
        const payload = validateRuntimeEvent(args.payload)
        const before = await verifyHarness(workspace, signal)
        if (payload.kind === 'configure' && before.status.acceptance?.configured) return checkpoint({ configured: true, reused: true })
        return checkpoint(await invokeRuntime(workspace, 'acceptance', await runtimeEvidence(workspace, payload.kind === 'configure' ? await acceptanceConfiguration(workspace) : payload), runtimeOperation(args.operationId), signal))
      }),
    ] : []),
  ]
}
