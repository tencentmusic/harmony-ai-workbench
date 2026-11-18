import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { CloudHarness, CloudReview } from '@/contracts/cloud-agent'
import { CloudError, CloudRecoveryError, record } from './domain'
import { scopeReviewBlockers } from './harness-domain'
import { scopedPath, sha256 } from './scoped-files'
import { harnessCommand, harnessReviewFacts, harnessUiOperationFacts, harnessUiSourceIssues, verifyHarness, type HarnessWorkspace } from './harness'
import { assertUiReviewReconciliation } from './review-recovery-domain'
import { UiCandidateError, uiCandidateIssues, uiScopeComponentIssues } from './ui-candidate'
import { reviewExecutionPlan, approveExecutionPlan } from './execution-plan-review'

interface ReviewFile { id: string; label: string; mime: string; path: string; sha256: string }
export interface NativeReview extends CloudReview {
  executionPlan?: { plan: Record<string, unknown>; requested: Record<string, unknown>[] }
  packageDigest: string
  packageId: string
  inputsDigest: string
  files: ReviewFile[]
  uiArgs: string[]
}
export function publicReview(value?: NativeReview | null): CloudReview | null {
  return value ? { kind: value.kind, digest: value.digest, materialVersion: value.materialVersion, content: value.content, decision: value.decision,
    files: value.files.map(({ id, label, mime }) => ({ id, label, mime })) } : null
}

export async function inspectNativeReview(workspace: HarnessWorkspace, status: CloudHarness, signal: AbortSignal) {
  try {
    const review = await prepareNativeReview(workspace, status, signal)
    return { review, issues: review || status.phase !== 'scope_approved' ? [] : ['缺少 candidates/ui-review.json，请完成UI候选及引用材料'], signature: review?.digest || '' }
  } catch (error) {
    // Only candidate defects are repairable by the agent; runtime and native failures propagate.
    if (!(error instanceof UiCandidateError)) throw error
    const candidate = await readFile(await scopedPath(workspace.artifactRoot, 'candidates/ui-review.json', ['candidates'], true), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
    return { review: null, issues: [error.message], signature: sha256(candidate + error.message) }
  }
}
async function artifacts(workspace: HarnessWorkspace) {
  const names = ['manifest.json', 'evidence-ledger.json', 'parity-matrix.json']
  const text: string[] = []
  for (const name of names) text.push(await readFile(await scopedPath(workspace.artifactRoot, path.relative(workspace.artifactRoot, path.join(workspace.runDir, name)).replaceAll('\\', '/'), ['']), 'utf8'))
  return { manifest: record(JSON.parse(text[0])), evidence: record(JSON.parse(text[1])), parity: record(JSON.parse(text[2])), inputsDigest: sha256(text.join('\n')) }
}
export async function prepareNativeReview(workspace: HarnessWorkspace, status: CloudHarness, signal: AbortSignal): Promise<NativeReview | null> {
  // Current-build visual decisions are independent of functional device cases.
  if (status.nodes.some(node => node.id === 'build_passed' && node.status === 'passed')) {
    const visual = await prepareVisualReview(workspace)
    if (visual) return visual
  }
  if (!['evidence_ready', 'scope_approved'].includes(status.phase)) return null
  if (scopeReviewBlockers(status.blockers).length) return null
  const facts = await artifacts(workspace)
  const generated = await harnessReviewFacts(workspace, signal)
  const kind = status.phase === 'evidence_ready' ? 'scope' as const : 'ui' as const
  const files: ReviewFile[] = []
  const uiArgs: string[] = []
  const executionPlan = kind === 'scope' ? await reviewExecutionPlan(workspace) : undefined
  let content = generated.content + '\n## 验收范围与状态清单\n\n```json\n' + JSON.stringify({ items: facts.parity.items, ui_scope: facts.parity.ui_scope, scenarios: facts.parity.scenarios }, null, 2) + '\n```\n'
  let decision: 'approved' | 'not_applicable' = 'approved'
  if (executionPlan) content += '\n## 执行依赖与授权\n\n设备、账号和数据依赖只影响关联场景。确认本方案同时批准以下列明的账号、目标、操作及累计额度；未列明操作不授权。消费金额单位为最小货币单位。\n\n```json\n' + JSON.stringify(executionPlan, null, 2) + '\n```\n'
  const add = async (root: string, relative: unknown, prefixes: string[], label: string) => {
    const file = await scopedPath(root, relative, prefixes)
    const bytes = await readFile(file)
    if (!bytes.length || bytes.length > 12 * 1024 * 1024) throw new CloudError('审核材料为空或过大', 413)
    const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf' } as Record<string, string>)[path.extname(file).toLowerCase()] || 'text/plain'
    files.push({ id: String(files.length), label, mime, path: file, sha256: sha256(bytes) })
    return file
  }
  if (kind === 'scope') {
    const issues = uiScopeComponentIssues(record(facts.parity.ui_scope))
    if (issues.length) throw new UiCandidateError(issues.join('；'))
    const effects = record(facts.evidence.review_package || {}).effects
    for (const effect of Array.isArray(effects) ? effects : []) {
      const row = record(effect), artifact = record(row.artifact || {})
      if (typeof artifact.path === 'string') await add(workspace.artifactRoot, path.relative(workspace.artifactRoot, artifact.path).replaceAll('\\', '/'), [''], String(row.description || row.id))
    }
  } else {
    try {
    let candidate: Record<string, unknown>
    try { candidate = record(JSON.parse(await readFile(await scopedPath(workspace.artifactRoot, 'candidates/ui-review.json', ['candidates']), 'utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    const issues = uiCandidateIssues(candidate, record(facts.parity.ui_scope))
    if (issues.length) throw new UiCandidateError(issues.join('；'))
    decision = candidate.decision as 'approved' | 'not_applicable'
    if (typeof candidate.summary !== 'string' || !candidate.summary.trim()) throw new CloudError('UI 审核候选缺少说明')
    content = `# UI 基线审核\n\n${candidate.summary}\n\n待人工确认：${decision === 'not_applicable' ? '无用户可见 UI' : '当前 UI 基线'}\n\n` + content
    if (decision === 'not_applicable') {
      if (record(facts.parity.ui_scope).status !== 'not_applicable') throw new CloudError('UI 范围不是不适用，不能免审')
    } else {
      for (const [key, flag] of [['layoutSpec', '--layout-spec'], ['visualRegions', '--visual-regions']]) uiArgs.push(flag, await add(workspace.artifactRoot, candidate[key], ['candidates'], key))
      for (const [key, flag] of [['baselines', '--baseline'], ['prototypes', '--prototype'], ['prototypeRenders', '--prototype-render'], ['androidSources', '--android-source']]) {
        const entries = Object.entries(record(candidate[key]))
        if (!entries.length || entries.length > 40) throw new CloudError('UI 审核文件清单缺失或过大')
        for (const [state, relative] of entries) {
          if (!/^[\w-]{1,100}$/.test(state)) throw new CloudError('UI 状态或角色名称非法')
          uiArgs.push(flag, `${state}=${await add(key === 'androidSources' ? workspace.androidRoot : workspace.artifactRoot, relative, key === 'androidSources' ? workspace.androidPrefixes : ['candidates', 'materials'], `${key}/${state}`)}`)
        }
      }
      for (const [role, evidence] of Object.entries(record(candidate.androidEvidence))) {
        if (!/^[\w-]{1,100}$/.test(role) || typeof evidence !== 'string' || !/^[\w-]{1,100}$/.test(evidence)) throw new CloudError('UI 源码证据非法')
        uiArgs.push('--android-source-evidence', `${role}=${evidence}`)
      }
      const sourceIssues = await harnessUiSourceIssues(workspace, uiArgs, signal)
      if (sourceIssues.length) throw new UiCandidateError(`UI源码或布局预检未通过：${sourceIssues.join('；')}`)
      record(JSON.parse(await readFile(files.find(file => file.label === 'visualRegions')!.path, 'utf8')))
      const preflightArgs = uiArgs.flatMap((flag, index) => ['--visual-regions', '--baseline', '--prototype-render'].includes(flag) ? [flag, uiArgs[index + 1]] : [])
      const preflight = record(JSON.parse(await harnessCommand(['visual-preflight', '--run-dir', workspace.runDir, ...preflightArgs], signal)))
      if (preflight.status !== 'ready' || !Array.isArray(preflight.issues) || preflight.issues.length) {
        const messages = Array.isArray(preflight.issues) ? preflight.issues.map(item => { const issue = record(item); return `${issue.state_id || ''} ${issue.code || ''}: ${issue.message || ''}` }) : ['预检未返回可审核结果']
        throw new UiCandidateError(`UI原生视觉预检未通过：${messages.join('；')}`)
      }
    }
    } catch (error) {
      if (error instanceof UiCandidateError) throw error
      if (error instanceof SyntaxError) throw new UiCandidateError('UI候选或视觉区域文件不是完整有效的JSON，请修复草稿')
      if (error instanceof CloudError && !(error instanceof CloudRecoveryError) && error.status < 500) throw new UiCandidateError(`UI候选材料需修正：${error.message}`)
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new UiCandidateError('UI候选引用文件不存在，请逐项核对路径并生成缺失材料')
      throw error
    }
  }
  const value = { kind, ...(executionPlan ? { executionPlan } : {}), materialVersion: workspace.materialVersion || 1, content, decision, files, uiArgs, inputsDigest: facts.inputsDigest, packageDigest: generated.digest, packageId: String(record(facts.evidence.review_package).id) }
  return { ...value, digest: sha256(JSON.stringify(value)) }
}
export async function applyNativeReview(workspace: HarnessWorkspace, approved: NativeReview, human: { id: string; actorId: string; reason: string; createdAt: Date; operationId?: string; reconcile?: boolean }, signal: AbortSignal) {
  const reference = `cloud-agent:${workspace.identity}:approval:${human.id}`
  let current: NativeReview | null
  if (human.reconcile) {
    if (approved.kind !== 'ui' || !human.operationId) throw new CloudError('只能核对已登记的UI审批', 409)
    const { digest, ...payload } = approved
    if (sha256(JSON.stringify(payload)) !== digest) throw new CloudError('原始审核材料摘要不匹配', 409)
    assertUiReviewReconciliation(await harnessUiOperationFacts(workspace, human.operationId, signal), human.operationId,
      { reference, actorId: human.actorId, reason: human.reason, decision: approved.decision })
    for (const file of approved.files) {
      const root = file.label.startsWith('androidSources/') ? workspace.androidRoot : workspace.artifactRoot
      const allowed = await scopedPath(root, path.relative(root, file.path).replaceAll('\\', '/'), [''])
      if (sha256(await readFile(allowed)) !== file.sha256) throw new CloudError('已批准文件发生变化，不能恢复原收据', 409)
    }
    // Native replay validates the original request hash and receipt, without reapproving.
    current = approved
  } else {
    const before = await verifyHarness(workspace, signal)
    current = await prepareNativeReview(workspace, before.status, signal)
  }
  if (!current || current.digest !== approved.digest || current.materialVersion !== workspace.materialVersion) throw new CloudError('审核材料已变化，必须重新展示并批准', 409)
  const root = path.join(workspace.artifactRoot, 'approvals', human.id)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const persist = async (name: string, text: string) => {
    const file = path.join(root, name)
    await writeFile(file, text, { flag: 'wx', mode: 0o600 }).catch(async error => { if (error.code !== 'EEXIST' || await readFile(file, 'utf8') !== text) throw error })
    return { path: file, sha256: sha256(text) }
  }
  const evidence = await persist('human.txt', JSON.stringify({ reference, actorId: human.actorId, decidedAt: human.createdAt.toISOString(), decision: current.decision, kind: current.kind, digest: current.digest, reason: human.reason }, null, 2))
  const presentation = await persist('presented.md', current.content)
  try {
    if (current.kind === 'scope') {
      const facts = await artifacts(workspace)
      record(facts.evidence.review_package).presentation = { thread_reference: reference, presented_at: human.createdAt.toISOString(), package_sha256: current.packageDigest, artifact: presentation }
      const input = await persist('evidence.json', JSON.stringify(facts.evidence))
      await harnessCommand(['record-evidence', '--run-dir', workspace.runDir, '--operation-id', `${human.id}-present`, '--input', input.path], signal)
      facts.parity.scope_approval = { status: 'approved', basis: human.reason, approved_at: human.createdAt.toISOString(), decision_scope: 'scope', reviewer_kind: 'human', reviewer: human.actorId,
        approval_reference: reference, approval_evidence: evidence, review_package_id: current.packageId, review_package_sha256: current.packageDigest, presented_artifact: presentation }
      const parity = await persist('parity.json', JSON.stringify(facts.parity))
      await harnessCommand(['record-parity', '--run-dir', workspace.runDir, '--operation-id', `${human.id}-scope`, '--input', parity.path], signal)
      if (current.executionPlan) await approveExecutionPlan(workspace, current.executionPlan, evidence, `${human.id}-plan`, signal)
    } else if (current.kind === 'visual') {
      await harnessCommand(['review-visual', '--run-dir', workspace.runDir, '--operation-id', `${human.id}-visual`, '--decision', current.decision,
        ...(current.decision === 'accepted_with_differences' ? ['--difference-reason', human.reason] : []), '--reviewer', human.actorId,
        '--basis', human.reason, '--approval-reference', reference, '--approval-evidence', evidence.path, ...current.uiArgs], signal)
    } else {
      await harnessCommand(['review-ui', '--run-dir', workspace.runDir, '--operation-id', human.operationId || `${human.id}-ui`, '--decision', current.decision, '--reviewer', human.actorId, '--basis', human.reason, '--approval-reference', reference, '--approval-evidence', evidence.path, ...current.uiArgs], signal)
    }
    return await verifyHarness(workspace, signal, current.kind === 'scope' ? 'scope_approved' : current.kind === 'ui' ? 'ui_prototype_approved' : 'build_passed')
  } catch (error) {
    // A write may have committed before a later write or verification failed.
    throw new CloudRecoveryError(`原生审批操作未完整确认，需核验收据：${error instanceof Error ? error.message : '未知错误'}`, 409)
  }
}

async function prepareVisualReview(workspace: HarnessWorkspace): Promise<NativeReview | null> {
  const text = await readFile(path.join(workspace.runDir, 'verification-report.json'), 'utf8')
  const verification = record(JSON.parse(text)), visual = record(verification.visual || {})
  const states = Array.isArray(visual.states) ? visual.states.map(record) : []
  const state = states.find(s => ['passed', 'failed'].includes(String(record(s.automatic_check || {}).status)) && !s.human_review)
  if (!state) return null
  const files: ReviewFile[] = []
  for (const [label, value] of Object.entries({ baseline: state.android_baseline || state.reference_baseline, prototype: state.prototype_render, harmony: state.harmony_device_capture, comparison: record(state.automatic_check).evidence })) {
    if (!value) continue
    const item = record(value), file = await scopedPath(workspace.artifactRoot, path.relative(workspace.artifactRoot, String(item.path)).replaceAll('\\', '/'), [''])
    const bytes = await readFile(file)
    if (sha256(bytes) !== item.sha256) throw new CloudError('视觉审核材料已变化', 409)
    files.push({ id: String(files.length), label, path: file, sha256: sha256(bytes), mime: /\.png$/i.test(file) ? 'image/png' : /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'text/plain' })
  }
  const comparison = files.find(f => f.label === 'comparison')
  if (!comparison) return null
  const facts = await artifacts(workspace)
  const decision = record(state.automatic_check).status === 'passed' ? 'approved' : 'accepted_with_differences'
  const value: Omit<NativeReview, 'digest'> = { kind: 'visual', materialVersion: workspace.materialVersion || 1, decision, files,
    content: `# 实现后视觉验收\n\n状态：${String(state.id)}\n\n请对照基线、原型、当前设备截图和自动报告。${decision === 'accepted_with_differences' ? '自动比较未通过；接受差异时须写明当前状态的具体差异及接受理由，原始分数保留。' : ''}此批准仅覆盖当前状态，不替代业务功能验收。\n\n\x60\x60\x60json\n${JSON.stringify(state.automatic_check, null, 2)}\n\x60\x60\x60`,
    inputsDigest: sha256(facts.inputsDigest + text), packageDigest: '', packageId: '', uiArgs: ['--state-id', String(state.id), '--comparison-report', comparison.path] }
  return { ...value, digest: sha256(JSON.stringify(value)) }
}
