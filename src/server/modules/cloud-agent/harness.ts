import { execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { CloudHarness } from '@/contracts/cloud-agent'
import { CloudError, CloudRecoveryError, record } from './domain'
import { validateCapabilities, projectHarnessStatus, assertCandidatePayload, agentRecordPayload, assertSourceApproval } from './harness-domain'
import { inspectCandidate, readScoped, scopedPath, sha256, writeScoped, inProjectScope } from './scoped-files'
import { mutateSource } from './source-files'
import { taskTool, textResult } from './task-tools'
import { git, inScope } from './git'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { harnessRequestName } from './request-file'
import { listAndroidFiles, verifyAndroidSources, type AndroidSourceSnapshot } from './android-sources'
import { resolveChangePaths } from './change-record'
import { assertHarmonyHead } from './harmony-head'
import { evidenceDiscoveryTools } from './evidence-discovery'
import { isSigningFile, readSigningMetadata } from './review-source-paths'
import { readArtifact } from './artifact-read'

const execute = promisify(execFile)
export async function harnessCodeFacts(workspace: HarnessWorkspace, signal: AbortSignal, includeApplicationPredecessors = false): Promise<{ digest: string; snapshot: Record<string, unknown>; applicationPredecessorDigests: string[]; acceptancePredecessorDigests: string[] }> {
  await verifyAndroidSources(workspace, signal)
  const code = `import json,runpy,sys
from pathlib import Path
a=runpy.run_path(sys.argv[1]); root=Path(sys.argv[2])
m=json.loads((root/"manifest.json").read_text(encoding="utf-8"))
s=a["repo_snapshot"](m["harmony"]["root"],m["artifact_root"])
d={"harmony":s,"android":a["repo_snapshot"](m["android"]["root"],m["artifact_root"]),"ledgers":{p:a["file_sha256"](root/p) for p in ["manifest.json","evidence-ledger.json","parity-matrix.json","traceability-map.json"]}}
old=[]; tests=[]
if sys.argv[3]=="true":
 old=a["application_predecessor_hashes"](root,m,s)
 review=runpy.run_path(str(Path(sys.argv[1]).with_name("harness_review.py")))
 tests=review["test_exclusion_predecessor_hashes"](json.loads((root/"parity-matrix.json").read_text(encoding="utf-8")),m)
print(json.dumps({"digest":a["canonical_sha256"](d),"snapshot":s,"applicationPredecessorDigests":[a["canonical_sha256"]({**d,"ledgers":{**d["ledgers"],"manifest.json":h}}) for h in old],"acceptancePredecessorDigests":[a["canonical_sha256"]({**d,"ledgers":{**d["ledgers"],"parity-matrix.json":h,"manifest.json":mh}}) for h in tests for mh in [d["ledgers"]["manifest.json"],*old]]},ensure_ascii=False))`
  const result = await execute(process.env.CLOUD_AGENT_HARNESS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-c', code, path.join(harnessRoot(), 'skills/android-to-harmony-feature-rollout/scripts/migration_harness.py'), workspace.runDir, String(includeApplicationPredecessors)],
    { signal, windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024, env: { NODE_ENV: 'production', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } })
  const facts = JSON.parse(result.stdout)
  const bind = (digest: string) => sha256(JSON.stringify({ digest, androidSources: workspace.androidSources || [] }))
  return { ...facts, digest: bind(facts.digest), applicationPredecessorDigests: (facts.applicationPredecessorDigests as string[]).map(bind), acceptancePredecessorDigests: (facts.acceptancePredecessorDigests as string[]).map(bind) }
}
export async function harnessBuildFacts(workspace: HarnessWorkspace, signal: AbortSignal): Promise<{ digest: string; runId: string; build: Record<string, unknown> }> {
  const code = 'import json,runpy,sys; from pathlib import Path; api=runpy.run_path(sys.argv[1]); root=Path(sys.argv[2]); m=json.loads((root/"manifest.json").read_text(encoding="utf-8")); b=json.loads((root/"verification-report.json").read_text(encoding="utf-8"))["build"]; print(json.dumps({"digest":api["canonical_sha256"](b),"runId":m["run_id"],"build":b},ensure_ascii=False))'
  const result = await execute(process.env.CLOUD_AGENT_HARNESS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-c', code, path.join(harnessRoot(), 'skills/android-to-harmony-feature-rollout/scripts/migration_harness.py'), workspace.runDir],
    { signal, windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: { NODE_ENV: 'production', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } })
  return JSON.parse(result.stdout)
}
export async function harnessReviewFacts(workspace: HarnessWorkspace, signal: AbortSignal): Promise<{ digest: string; content: string }> {
  const code = 'import json,runpy,sys; from pathlib import Path; api=runpy.run_path(sys.argv[1]); root=Path(sys.argv[2]); m=json.loads((root/"manifest.json").read_text(encoding="utf-8")); e=json.loads((root/"evidence-ledger.json").read_text(encoding="utf-8")); p=json.loads((root/"parity-matrix.json").read_text(encoding="utf-8")); print(json.dumps({"digest":api["package_digest"](e,p,m),"content":api["render_review_package"](e,p,m)},ensure_ascii=False))'
  const result = await execute(process.env.CLOUD_AGENT_HARNESS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-c', code, path.join(harnessRoot(), 'skills/android-to-harmony-feature-rollout/scripts/harness_review.py'), workspace.runDir],
    { signal, windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: { NODE_ENV: 'production', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } })
  return JSON.parse(result.stdout)
}
export function harnessRoot() {
  return path.resolve(process.env.CLOUD_AGENT_HARNESS_ROOT || '../androidtoharmonyharness/android-harmony-migration-harness')
}
async function protectReviewedRecord(workspace: HarnessWorkspace, command: string, candidate: string, signal: AbortSignal) {
  if (!['record-evidence', 'record-parity'].includes(command)) return
  const code = `import json,runpy,sys
from pathlib import Path
api=runpy.run_path(sys.argv[1]); root=Path(sys.argv[2])
m=json.loads((root/'manifest.json').read_text(encoding='utf-8'))
e=json.loads((root/'evidence-ledger.json').read_text(encoding='utf-8'))
p=json.loads((root/'parity-matrix.json').read_text(encoding='utf-8'))
candidate=json.loads(Path(sys.argv[4]).read_text(encoding='utf-8'))
ne=candidate if sys.argv[3]=='record-evidence' else e
np=candidate if sys.argv[3]=='record-parity' else p
approval=p.get('scope_approval',{})
try:
 valid=approval.get('status')=='approved' and api['package_digest'](e,p,m)==approval.get('review_package_sha256') and api['package_digest'](ne,np,m)==approval.get('review_package_sha256')
 valid=valid and ne.get('review_package',{}).get('presentation')==e.get('review_package',{}).get('presentation') and ne.get('review_package',{}).get('status')==e.get('review_package',{}).get('status')
except (ValueError,KeyError,TypeError): valid=False
print(json.dumps({'valid':valid}))`
  const result = await execute(process.env.CLOUD_AGENT_HARNESS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-B', '-c', code,
    path.join(harnessRoot(), 'skills/android-to-harmony-feature-rollout/scripts/harness_review.py'), workspace.runDir, command, candidate],
  { signal, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, env: { NODE_ENV: 'production', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PYTHONIOENCODING: 'utf-8' } })
  if (JSON.parse(result.stdout).valid !== true) throw new CloudError('编码阶段不可修改已审事实、范围或展示凭据。保留转译前的证据与哈希；当前实现使用 record-change 或新增未审证据登记。真实需求变更必须通过补充资料重新审核。', 409)
}
export async function harnessUiOperationFacts(workspace: HarnessWorkspace, operationId: string, signal: AbortSignal): Promise<unknown> {
  const code = `import json,runpy,sys
from pathlib import Path
api=runpy.run_path(sys.argv[1]); root=Path(sys.argv[2]); events=api['read_journal'](root)
latest={event['operation_id']:event for event in events}
parity=json.loads((root/'parity-matrix.json').read_text(encoding='utf-8'))
print(json.dumps({'uiStatus':parity.get('ui_review',{}).get('status'),'uiReview':parity.get('ui_review',{}),'operation':latest.get(sys.argv[3]),'pending':[key for key,value in latest.items() if value.get('status')=='started']},ensure_ascii=False))`
  const result = await execute(process.env.CLOUD_AGENT_HARNESS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-B', '-c', code,
    path.join(harnessRoot(), 'skills/android-to-harmony-feature-rollout/scripts/migration_harness.py'), workspace.runDir, operationId],
  { signal, windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: { NODE_ENV: 'production', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } })
  return JSON.parse(result.stdout)
}
export async function harnessUiSourceIssues(workspace: HarnessWorkspace, args: string[], signal: AbortSignal): Promise<string[]> {
  const code = `import json,runpy,sys
from pathlib import Path
api=runpy.run_path(sys.argv[1]); root=Path(sys.argv[2]); args=json.loads(sys.argv[3]); pairs=list(zip(args[::2],args[1::2]))
def values(flag): return [value for key,value in pairs if key==flag]
manifest=json.loads((root/'manifest.json').read_text(encoding='utf-8')); evidence=json.loads((root/'evidence-ledger.json').read_text(encoding='utf-8'))
issues=[]
try:
 for flag in ['--layout-spec','--visual-regions','--prototype','--baseline','--prototype-render']:
  for value in values(flag):
   file=value.split('=',1)[1] if flag in ['--prototype','--baseline','--prototype-render'] else value
   api['resolve_review_artifact'](file,manifest['harmony']['root'],str(root),manifest.get('artifact_root'))
 sources=api['parse_android_sources'](values('--android-source'),values('--android-source-evidence'),manifest['android']['root'],{item['id'] for item in evidence['items']})
 prototypes=api['parse_state_paths'](values('--prototype'),'--prototype')
 api['validate_layout_spec'](Path(values('--layout-spec')[0]),sorted(prototypes),sources)
 for state,file in prototypes.items(): api['validate_prototype_artifact'](Path(file),state)
except (api['HarnessError'],ValueError,KeyError,TypeError,IndexError,FileNotFoundError) as error: issues.append(str(error))
print(json.dumps(issues,ensure_ascii=False))`
  const result = await execute(process.env.CLOUD_AGENT_HARNESS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-c', code,
    path.join(harnessRoot(), 'skills/android-to-harmony-feature-rollout/scripts/migration_harness.py'), workspace.runDir, JSON.stringify(args)],
  { signal, windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: { NODE_ENV: 'production', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } })
  const issues: unknown = JSON.parse(result.stdout)
  if (!Array.isArray(issues) || issues.some(issue => typeof issue !== 'string')) throw new CloudError('UI源码与布局预检返回无效', 503)
  return issues
}
export function harnessEnvironment() {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' }
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT', 'ProgramFiles', 'ProgramFiles(x86)', 'DEVECO_HOME', 'DEVECO_SDK_HOME', 'JAVA_HOME', 'OHOS_SDK_HOME', 'MIGRATION_HARNESS_DEVECO_TOOLS']) if (process.env[key]) env[key] = process.env[key]
  return env
}
export async function harnessCommand(args: string[], signal: AbortSignal, timeout = 120000) {
  const root = harnessRoot()
  const env = harnessEnvironment()
  const runDir = args[args.indexOf('--run-dir') + 1]
  const tracked = args.includes('--run-dir') && !['verify', 'status', 'resume', 'visual-preflight'].includes(args[0])
  const receiptFile = tracked ? path.join(path.dirname(runDir), 'processes', `${randomUUID()}.json`) : null
  const receipt = { kind: 'harness', command: args[0], host: os.hostname(), pid: 0, startedAt: new Date().toISOString(), status: 'starting' }
  if (receiptFile) { await mkdir(path.dirname(receiptFile), { recursive: true }); await writeFile(receiptFile, JSON.stringify(receipt), { flag: 'wx' }) }
  let child: ChildProcess | undefined
  try {
    const running = execute(process.env.CLOUD_AGENT_HARNESS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
      [path.join(root, 'skills/android-to-harmony-feature-rollout/scripts/migration_harness.py'), ...args],
      { cwd: root, env, shell: false, windowsHide: true, signal, timeout, maxBuffer: 2 * 1024 * 1024 })
    void running.catch(() => {})
    child = running.child
    receipt.pid = running.child.pid || 0
    receipt.status = 'running'
    if (receiptFile) await writeFile(receiptFile, JSON.stringify(receipt))
    const result = await running
    receipt.status = 'stopped'
    if (receiptFile) await writeFile(receiptFile, JSON.stringify(receipt))
    return result.stdout
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean; signal?: string }
    const uncertain = signal.aborted || result.killed || result.signal || child && child.exitCode === null && child.signalCode === null
    receipt.status = uncertain ? 'uncertain' : 'stopped'
    if (receiptFile) await writeFile(receiptFile, JSON.stringify(receipt)).catch(() => {
      throw new CloudRecoveryError(`Harness ${args[0]} 进程收据写入失败，须核验子进程后恢复`, 409)
    })
    if (uncertain) throw new CloudRecoveryError(`Harness ${args[0]} 进程被中止，须核验子进程和收据后恢复`, 409)
    if (result.code === 2 && ['verify', 'visual-preflight'].includes(args[0]) && result.stdout) return result.stdout
    if (result.code === 2 && args[0] === 'runtime' && result.stdout) {
      try {
        const payload = record(JSON.parse(result.stdout))
        if (payload.changes_quality_gates === false && ['failed', 'in_doubt'].includes(String(record(payload.receipt || {}).status))) return result.stdout
      } catch { /* Other runtime errors keep their failure status. */ }
    }
    if (result.code === 2 && result.stdout) {
      let payload: Record<string, unknown> = {}
      try { payload = record(JSON.parse(result.stdout)) } catch { /* Non-JSON CLI failure uses the bounded output below. */ }
      const issues = [payload.blockers, payload.delivery_blockers].flatMap(value => Array.isArray(value) ? value.map(item => String(record(item).message || record(item).code)) : [])
      if (issues.length) throw new CloudError(`Harness ${args[0]} 门禁未通过：${issues.join('；').slice(0, 3000)}`, 409)
    }
    throw new CloudError(`Harness ${args[0]} 执行失败：${(result.stderr || result.stdout || '请检查 Python、包路径和参数').slice(-2000)}`, 503)
  }
}
export async function handshakeHarness(signal: AbortSignal) {
  const capability = validateCapabilities(JSON.parse(await harnessCommand(['capabilities'], signal)))
  const files = record(record(capability.quality_contract).engine_files)
  for (const [name, digest] of Object.entries(files)) {
    if (!/^[a-z_]+\.py$/.test(name) || sha256(await readFile(path.join(harnessRoot(), 'skills/android-to-harmony-feature-rollout/scripts', name))) !== digest) throw new CloudError('Harness 引擎文件与公布指纹不一致', 503)
  }
  return capability
}
export function harnessRuleTools() {
  return [taskTool('harness_rule_catalog', '查询实际存在的 Harness 规则路径；query 为文件名片段，空字符串列出前100项。读取失败先查询，不猜路径或创建规则文件', { query: { type: 'string', maxLength: 160 } }, ['query'], async args => {
    if (typeof args.query !== 'string' || args.query.length > 160) throw new CloudError('规则查询参数无效')
    const root = harnessRoot(), matches: string[] = []
    const pending = ['skills']
    const needle = args.query.toLowerCase()
    for (const file of ['START_HERE.md', 'release-capabilities.json']) if (file.toLowerCase().includes(needle)) matches.push(file)
    while (pending.length) {
      const directory = pending.pop()!
      const absolute = await scopedPath(root, directory, ['skills'])
      for (const entry of await readdir(absolute, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue
        const file = `${directory}/${entry.name}`
        if (entry.isDirectory()) pending.push(file)
        else if (entry.isFile() && /\.(md|json)$/.test(file) && file.toLowerCase().includes(needle)) matches.push(file)
      }
    }
    matches.sort()
    return textResult({ files: matches.slice(0, 100), total: matches.length, truncated: matches.length > 100 })
  }), taskTool('harness_rule', '按需读取唯一 Harness 包的 Skills、references 或 schemas。先读 START_HERE.md；路径不确定时调用 harness_rule_catalog，不猜文件名',
    { path: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, ['path'], async args => {
      const relative = args.path
      if (typeof relative !== 'string' || !/\.(md|json)$/.test(relative) || !(relative === 'START_HERE.md' || relative === 'release-capabilities.json' || relative.startsWith('skills/') || relative.startsWith('schemas/'))) throw new CloudError('仅能读取 Harness 规则和 Schema', 403)
      try {
        return textResult(await readScoped(harnessRoot(), relative.startsWith('schemas/') ? `skills/android-to-harmony-feature-rollout/${relative}` : relative, [''], Number(args.offset || 0)))
      } catch (error) {
        if (error instanceof CloudError && error.status === 404) throw new CloudError(`Harness 规则不存在：${relative}。请调用 harness_rule_catalog 按文件名关键词查找实际路径；不要创建或修改规则文件。`, 404)
        throw error
      }
    })]
}
export interface HarnessWorkspace {
  harmonyHeadSha?: string
  runtimeVersion?: 1
  documentsPath?: string
  androidSources?: AndroidSourceSnapshot[]
  continuous?: boolean; materialVersion?: number; targetBranch?: string; androidSha?: string; androidSourceId?: string; sourceConfigDigest?: string
  identity: string; artifactRoot: string; runDir: string; androidRoot: string; harmonyRoot: string; branch: string; baseSha: string
  androidPrefixes: string[]; harmonyPrefixes: string[]; appId: string; title: string; profile: string
  androidSourceSuffix?: string
}
export async function verifyHarness(workspace: HarnessWorkspace, signal: AbortSignal, minimum = 'initialized') {
  await verifyAndroidSources(workspace, signal)
  const raw = record(JSON.parse(await harnessCommand(['verify', '--run-dir', workspace.runDir, '--minimum', minimum, '--json'], signal)))
  const status = { ...projectHarnessStatus(raw), branch: workspace.branch, worktree: workspace.harmonyRoot, runDir: workspace.runDir }
  return { raw, status }
}
export async function executionTools(workspace: HarnessWorkspace, signal: AbortSignal, publish: (status: CloudHarness) => Promise<void>, allowCode = true) {
  const exists = async () => { try { await access(path.join(workspace.runDir, 'manifest.json')); return true } catch { return false } }
  async function checkpoint() {
    if (!await exists()) throw new CloudError('尚未建立 Harness 档案；请先定位真实入口并调用 harness_start', 409)
    const result = await verifyHarness(workspace, signal)
    await publish(result.status)
    return result
  }
  async function authorizeSource() {
    signal.throwIfAborted()
    if (!allowCode) throw new CloudError('当前为只读阶段，不允许写业务源码', 403)
    const checked = await verifyHarness(workspace, signal, 'ui_prototype_approved')
    await publish(checked.status)
    assertSourceApproval(checked.raw)
    await assertHarmonyHead(workspace, signal)
    signal.throwIfAborted()
  }
  const string = { type: 'string' }
  return [
    ...harnessRuleTools(),
    ...evidenceDiscoveryTools(workspace.artifactRoot, workspace.harmonyRoot, signal),
    taskTool('source_catalog', '列出任务固定源码来源与提交；Harmony覆盖整个任务项目，Android保持App取证范围', {}, [], async () => textResult({ android: { id: workspace.androidSourceId, sha: workspace.androidSha, prefixes: workspace.androidPrefixes, nested: workspace.androidSources || [] }, harmony: { sha: workspace.harmonyHeadSha ?? workspace.baseSha, baseSha: workspace.baseSha, branch: workspace.branch, prefixes: [''], suggestedModules: workspace.harmonyPrefixes } })),
    taskTool('source_list', '按文件名片段查找Android App源码或整个Harmony任务项目，含新增文件，最多返回100项；使用对应根目录相对路径，不跟随链接', { platform: { enum: ['android', 'harmony'] }, query: string }, ['platform', 'query'], async args => {
      const android = args.platform === 'android'
      if (!android && args.platform !== 'harmony') throw new CloudError('平台非法')
      if (typeof args.query !== 'string' || args.query.length < 2 || args.query.length > 160) throw new CloudError('请输入至少2字符的文件名片段')
      const root = android ? workspace.androidRoot : workspace.harmonyRoot
      const files = android ? await listAndroidFiles(workspace, signal) : (await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], signal)).split('\0')
      const matches = [...new Set(files)].filter(file => (android ? inScope(file, workspace.androidPrefixes) : inProjectScope(file)) && file.toLowerCase().includes(String(args.query).toLowerCase()))
      return textResult({ files: matches.slice(0, 100), truncated: matches.length > 100 })
    }),
    taskTool('source_read', '读取Android App或整个Harmony项目的源码片段，含工程配置；返回完整文件SHA256与nextOffset', { platform: { enum: ['android', 'harmony'] }, path: string, offset: { type: 'integer', minimum: 0 } }, ['platform', 'path'], async args => {
      if (!['android', 'harmony'].includes(String(args.platform))) throw new CloudError('平台非法')
      if (args.platform === 'harmony' && typeof args.path === 'string' && isSigningFile(args.path)) return textResult(await readSigningMetadata(workspace.harmonyRoot, args.path))
      const prefixes = ['AGENTS.md', 'CLAUDE.md'].includes(String(args.path)) ? [''] : args.platform === 'android' ? workspace.androidPrefixes : ['']
      const content = await readScoped(args.platform === 'android' ? workspace.androidRoot : workspace.harmonyRoot, args.path, prefixes, Number(args.offset || 0), args.platform === 'harmony')
      const source = args.platform === 'android' ? workspace.androidSources?.filter(source => typeof args.path === 'string' && args.path.startsWith(`${source.suffix}/`)).sort((a, b) => b.suffix.length - a.suffix.length)[0] : undefined
      if (source) {
        const root = path.join(workspace.androidRoot, source.suffix), relative = String(args.path).slice(source.suffix.length + 1)
        if (await git(root, ['hash-object', '--', relative], signal) !== await git(root, ['rev-parse', `${source.sha}:${relative}`], signal)) throw new CloudError('嵌套源码文件与固定提交不一致，禁止作为证据', 409)
      }
      return textResult({ ...content, sourceId: source?.id || (args.platform === 'android' ? workspace.androidSourceId : 'harmony'), sourceCommit: source?.sha || (args.platform === 'android' ? workspace.androidSha : workspace.harmonyHeadSha ?? workspace.baseSha) })
    }),
    taskTool('harness_start', '查明真实 Android 入口和 Harmony 目标后初始化唯一档案；已存在时只恢复，不重新创建', { androidEntry: string, harmonyTarget: string }, ['androidEntry', 'harmonyTarget'], async args => {
      if (!await exists()) {
        const androidEntry = await scopedPath(workspace.androidRoot, args.androidEntry, workspace.androidPrefixes)
        const harmonyTarget = await scopedPath(workspace.harmonyRoot, args.harmonyTarget, [''], true, true)
        await mkdir(workspace.artifactRoot, { recursive: true, mode: 0o700 })
        await writeFile(workspace.profile, `# ${workspace.appId}\n\nHarmony root: ${workspace.harmonyRoot}\nAndroid root: ${workspace.androidRoot}\nSuggested Harmony modules: ${workspace.harmonyPrefixes.join(', ')}\n\nUse existing architecture, project AGENTS rules, ArkTS/MVVM and migration Harness gates. After Scope/UI approval, all project files in this task Harmony worktree are editable, including shared modules and build configuration. Do not access other worktrees or change Git metadata. Read the matching packaged project profile when applicable; current source evidence takes precedence over historical paths.\n`, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
        await harnessCommand(['start', '--run-dir', workspace.runDir, '--artifact-root', workspace.artifactRoot, '--feature-id', workspace.identity,
          '--goal', workspace.title, '--mode', workspace.continuous ? 'end-to-end' : 'implementation', '--profile', workspace.profile, '--android-root', workspace.androidRoot,
          '--harmony-root', workspace.harmonyRoot, '--comparison-base', workspace.baseSha, '--android-entry', androidEntry, '--harmony-target', harmonyTarget], signal)
      }
      return textResult((await checkpoint()).status)
    }),
    taskTool('harness_status', '严格重新校验档案并返回12阶段、阻塞与下一步；不得用模型结论晋级', {}, [], async () => textResult((await checkpoint()).status)),
    taskTool('artifact_read', '读取任务材料；path 使用 artifactRoot 下的相对路径，如 harness/parity-matrix.json。文本返回 sha256、relativePath 和分段偏移；PNG/JPEG/WebP 返回原件摘要、尺寸与图片预览，可直接查看 Android 基线、原型渲染和视觉对照图，不授予验收通过。图片不使用 offset', { path: string, offset: { type: 'integer', minimum: 0 } }, ['path'], async args => readArtifact(workspace.artifactRoot, args.path, Number(args.offset || 0))),
    taskTool('candidate_inspect', '查询 candidates/ 相对路径是否存在及写入摘要；不存在返回 expectedSha256=new；存在时修改前必须 artifact_read 阅读原文', { path: string }, ['path'], async args => textResult(await inspectCandidate(workspace.artifactRoot, args.path))),
    taskTool('candidate_write', '保存 candidates/ 下候选说明/原型；新文件 expectedSha256 必须是 new，已有文件使用 artifact_read 返回的 sha256，冲突需重读；不得改人工收据或权威档案', { path: string, content: string, expectedSha256: string }, ['path', 'content', 'expectedSha256'], async args => textResult(await writeScoped(workspace.artifactRoot, args.path, ['candidates'], args.content, args.expectedSha256))),
    taskTool('harness_record', '登记候选事实。record-change 为补录：未提供字段保留，changes 按 id、reachability 按 parity_id 合并条目；条目内显式字段替换，files/proof 应提供完整内容。空数组不删除旧条目；人工 change_scope 决定原样保留，不可修改。reachability.status=passed 和 skeleton_audit 自检仅在实际查证后登记，原生仍核验；不代表独立审查通过。其他 record 命令仍按完整 Schema 登记，禁止自填人工批准或构建设备通过。',
      { command: { enum: ['record-context', 'record-evidence', 'record-parity', 'record-change'] }, section: { enum: ['application'] }, payload: { type: 'object' }, operationId: string }, ['command', 'payload', 'operationId'], async args => {
        if (!await exists()) throw new CloudError('尚未建立 Harness 档案；请先定位真实入口并调用 harness_start', 409)
        const command = String(args.command)
        const targets: Record<string, string> = { 'record-context': 'manifest.json', 'record-evidence': 'evidence-ledger.json', 'record-parity': 'parity-matrix.json', 'record-change': 'traceability-map.json', 'record-static': 'verification-report.json' }
        if (command === 'record-static') throw new CloudError('静态审查由独立审查实例登记，请调用 harness_code_review', 403)
        if (!targets[command] || (!allowCode && ['record-change', 'record-static'].includes(command)) || !/^[a-zA-Z0-9_-]{1,100}$/.test(String(args.operationId))) throw new CloudError('登记命令或操作ID非法')
        if (args.section !== undefined && (command !== 'record-context' || args.section !== 'application')) throw new CloudError('登记 section 非法')
        let payload = record(args.payload)
        if (args.section) {
          assertCandidatePayload(payload)
        } else {
          const existing = record(JSON.parse(await readFile(path.join(workspace.runDir, targets[command]), 'utf8')))
          payload = agentRecordPayload(existing, payload, command)
          if (command === 'record-change') {
            const manifest = record(JSON.parse(await readFile(path.join(workspace.runDir, 'manifest.json'), 'utf8')))
            payload = await resolveChangePaths(workspace.harmonyRoot, payload, String(record(manifest.harmony).root))
          }
        }
        const folder = path.join(workspace.artifactRoot, 'requests')
        await mkdir(folder, { recursive: true, mode: 0o700 })
        const serialized = JSON.stringify(payload)
        const file = path.join(folder, harnessRequestName(command, String(args.operationId), serialized))
        await writeFile(file, serialized, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
        if (allowCode) await protectReviewedRecord(workspace, command, file, signal)
        await harnessCommand([command, '--run-dir', workspace.runDir, '--operation-id', String(args.operationId), '--input', file, ...(args.section ? ['--section', String(args.section)] : [])], signal)
        return textResult((await checkpoint()).status)
      }),
    taskTool('source_write', '在任务Harmony项目任意目录创建或完整覆盖文本文件（含工程配置）；已有大文件优先用source_edit，校验UI批准/分支/哈希',
      { path: string, content: string, expectedSha256: string }, ['path', 'content', 'expectedSha256'], async args => {
        await authorizeSource()
        return textResult(await mutateSource(workspace.harmonyRoot, { operation: 'write', path: args.path, content: args.content, expectedSha256: args.expectedSha256 }))
      }),
    taskTool('source_edit', '局部修改任意Harmony工程文本，无需重写整文件；edits按顺序匹配唯一oldText替换为newText，全部验证成功才写入，保留其余字节/换行；expectedSha256用source_read结果',
      { path: string, expectedSha256: string, edits: { type: 'array', minItems: 1, items: { type: 'object', properties: { oldText: { type: 'string', minLength: 1 }, newText: string }, required: ['oldText', 'newText'], additionalProperties: false } } }, ['path', 'expectedSha256', 'edits'], async args => {
        await authorizeSource()
        return textResult(await mutateSource(workspace.harmonyRoot, { operation: 'edit', path: args.path, expectedSha256: args.expectedSha256, edits: args.edits }))
      }),
    taskTool('source_delete', '删除任务Harmony项目中明确指定的单个文件；先读文件取得sha256，不递归删除目录', { path: string, expectedSha256: string }, ['path', 'expectedSha256'], async args => {
      await authorizeSource()
      return textResult(await mutateSource(workspace.harmonyRoot, { operation: 'delete', path: args.path, expectedSha256: args.expectedSha256 }))
    }),
    taskTool('source_move', '在任务Harmony项目内移动或重命名单文件，目标必须不存在；先读源文件取得sha256', { path: string, targetPath: string, expectedSha256: string }, ['path', 'targetPath', 'expectedSha256'], async args => {
      await authorizeSource()
      return textResult(await mutateSource(workspace.harmonyRoot, { operation: 'move', path: args.path, targetPath: args.targetPath, expectedSha256: args.expectedSha256 }))
    }),
  ].filter(tool => allowCode || !['source_write', 'source_edit', 'source_delete', 'source_move'].includes(tool.definition.name))
}
