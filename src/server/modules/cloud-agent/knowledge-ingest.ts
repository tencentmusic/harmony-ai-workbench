import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, lstat, realpath, rename, symlink, unlink, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CloudError, CloudRecoveryError, record } from './domain'
import { git, inScope } from './git'
import { readScoped, scopedPath, sha256, relativeToRoot } from './scoped-files'
import { executionTools, harnessEnvironment, type HarnessWorkspace } from './harness'
import { startTaskTools, taskTool, textResult } from './task-tools'
import { runAnalysisInstance, type InstanceReceipt } from './runtime'
import type { DeliveryMR } from './delivery-git'
import { ReadCoverage } from './code-review-domain'

const execute = promisify(execFile)
const readPrefixes = ['AGENTS.md', 'knowledge-config.json', '.agents/skills', 'android_wiki', '.wiki-tmp']
export const wikiPublishPrefixes = ['android_wiki/wiki/features', 'android_wiki/wiki/sources', 'android_wiki/wiki/indexes/manifest', 'android_wiki/index.md', 'android_wiki/code.md', 'log.md']

export async function validateKnowledgePlan(root: string) {
  const planPath = await scopedPath(root, '.wiki-tmp/apply-plan.json', ['.wiki-tmp'], false, true)
  const bytes = await readFile(planPath)
  if (bytes.length > 256000) throw new CloudError('知识计划过大', 413)
  const plan = record(JSON.parse(bytes.toString()))
  if (plan.operation !== 'ingest' || !Array.isArray(plan.pages) || !plan.pages.length || plan.pages.length > 30) throw new CloudError('知识回流必须提供有限的 ingest 事实源计划', 409)
  if (Object.keys(plan).some(key => !['operation', 'summary', 'date', 'pages', 'log'].includes(key)) || typeof plan.summary !== 'string' || !plan.summary.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(String(plan.date)) || record(plan.log).kind !== 'ingest' || typeof record(plan.log).title !== 'string') throw new CloudError('知识计划缺少摘要、日期或日志，或包含已废弃的索引 entry arrays', 409)
  const seen = new Set<string>()
  for (const item of plan.pages) {
    const page = record(item)
    if (Object.keys(page).some(key => !['action', 'path', 'content_file'].includes(key))) throw new CloudError('知识计划包含未授权的页面字段', 409)
    if (!['create', 'update'].includes(String(page.action)) || typeof page.path !== 'string' || !inScope(page.path, ['wiki/features', 'wiki/sources']) || !page.path.endsWith('.md') || seen.has(page.path)) throw new CloudError('知识计划只允许更新功能包或 source Markdown，不能写索引、脚本或 Harness JSON', 409)
    seen.add(page.path)
    await scopedPath(root, `android_wiki/${page.path}`, wikiPublishPrefixes, true)
    if (typeof page.content_file !== 'string') throw new CloudError('知识草稿路径缺失', 409)
    const relative = path.relative(root, path.resolve(root, page.content_file)).replaceAll('\\', '/')
    await scopedPath(root, relative, ['.wiki-tmp'], false, true)
    if (!relative.endsWith('.md') || (await lstat(path.join(root, relative))).size > 256000) throw new CloudError('知识正文草稿无效', 409)
  }
  return { planPath, pages: [...seen] }
}

export async function runWikiValidation(root: string, artifactRoot: string, command: string[], signal: AbortSignal) {
  const id = randomUUID(), folder = path.join(artifactRoot, 'processes')
  await mkdir(folder, { recursive: true })
  const file = path.join(folder, `${id}.json`)
  const receipt = { kind: 'harness', command: 'wiki-validation', host: os.hostname(), pid: 0, status: 'starting', startedAt: new Date().toISOString() }
  await writeFile(file, JSON.stringify(receipt))
  const running = execute(process.env.CLOUD_AGENT_HARNESS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), command, { cwd: root, env: harnessEnvironment(), signal, windowsHide: true, timeout: 180000, maxBuffer: 2_000_000 })
  void running.catch(() => {})
  receipt.pid = running.child.pid || 0; receipt.status = 'running'
  await writeFile(file, JSON.stringify(receipt))
  try {
    const result = await running
    await writeFile(`${file}.log`, result.stdout + result.stderr)
  } catch (error) {
    const value = error as { killed?: boolean; code?: unknown; stdout?: string; stderr?: string }
    const log = `${value.stdout || ''}\n${value.stderr || ''}`
    await writeFile(`${file}.log`, log)
    if (signal.aborted || value.killed) { receipt.status = 'uncertain'; throw new CloudRecoveryError('知识校验进程未确认全部停止，需核验进程收据后恢复', 503) }
    throw new CloudError(`知识库原生校验未通过：${log.slice(-6000)}`, 409)
  } finally { if (receipt.status !== 'uncertain') receipt.status = 'stopped'; await writeFile(file, JSON.stringify(receipt)) }
}

// Git on Windows can materialize the registered skill symlink as a plain file.
export async function withWikiSkillAlias<T>(root: string, action: () => Promise<T>) {
  if (await lstat(path.join(root, '.wiki-tmp/skills-link-backup')).catch(() => null)) throw new CloudRecoveryError('知识规则链接有未完成恢复，请核验旧进程并还原链接备份', 503)
  const alias = path.join(root, '.claude/skills'), target = await realpath(path.join(root, '.agents/skills'))
  const info = await lstat(alias)
  if (info.isSymbolicLink() || info.isDirectory()) {
    if (await realpath(alias) !== target) throw new CloudError('知识库规则链接指向仓外，拒绝执行', 409)
    return action()
  }
  if ((await readFile(alias, 'utf8')).trim() !== '../.agents/skills') throw new CloudError('知识库规则入口不是受管链接', 409)
  const backup = path.join(root, '.wiki-tmp/skills-link-backup')
  await rename(alias, backup)
  let linked = false, uncertain = false
  try { await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir'); linked = true; return await action() }
  catch (error) { uncertain = error instanceof CloudRecoveryError; throw error }
  finally { if (!uncertain) { if (linked) await unlink(alias); await rename(backup, alias) } }
}

export async function knowledgeFingerprint(root: string, signal: AbortSignal) {
  const tracked = await git(root, ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD'], signal)
  const names = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...wikiPublishPrefixes], signal)).split('\0').filter(Boolean).sort()
  const added = []
  for (const file of names) added.push([file, sha256(await readFile(await scopedPath(root, file, wikiPublishPrefixes)))])
  return sha256(JSON.stringify([await git(root, ['rev-parse', 'HEAD'], signal), tracked, added]))
}

const requiredRules = ['AGENTS.md', '.agents/skills/knowledge-ingest/SKILL.md',
  ...['page-schema', 'write-boundary', 'index-route-boundary', 'knowledge-slots', 'readme-routing', 'code-map-schema', 'role-isolation'].map(name => `.agents/skills/knowledge-base/references/common/${name}.md`),
  ...['01-overview', '02-single-item-flow', '03-classification-and-rules', '04-content-generation-standards', '06-merge-ingest-flow'].map(name => `.agents/skills/knowledge-ingest/references/ingest/${name}.md`)]

interface KnowledgeInput {
  root: string; base: string; workspace: HarnessWorkspace; code: DeliveryMR; appId: string; targets: string[]; model: string; title: string
  documents: Record<string, unknown>[]; signal: AbortSignal; guard: () => Promise<void>
  progress: (text: string) => Promise<void>; instance: (receipt: InstanceReceipt) => Promise<void>
}

export async function prepareFeatureKnowledge(input: KnowledgeInput) {
  const { root, workspace, signal } = input
  await input.guard()
  const draft = await scopedPath(root, '.wiki-tmp', ['.wiki-tmp'], true, true)
  await mkdir(draft, { recursive: true })
  if (await git(root, ['rev-parse', 'HEAD'], signal) !== input.base) throw new CloudError('知识 Worktree 基线发生变化', 409)
  const registry = record(record(JSON.parse(await readFile(path.join(root, 'knowledge-config.json'), 'utf8'))).apps)
  if (input.targets.length !== 2 || input.targets.some(target => !registry[target])) throw new CloudError('配置的知识 target 不在知识仓登记表中', 409)
  const binding = sha256(JSON.stringify({ code: input.code, base: input.base, documents: input.documents, targets: input.targets }))
  const marker = path.join(draft, 'cloud-knowledge.json')
  const previous = JSON.parse(await readFile(marker, 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error }))
  if (previous.binding && previous.binding !== binding) throw new CloudError('知识草稿绑定的交付快照已变化', 409)
  if (previous.completed) {
    if (await knowledgeFingerprint(root, signal) !== previous.diffHash) throw new CloudError('已校验知识正文发生变化，需重新复核', 409)
    await runWikiValidation(root, workspace.artifactRoot, ['.agents/skills/knowledge-base/scripts/build_wiki_indexes.py', '--root', root, '--check'], signal)
    return wikiPublishPrefixes
  }
  // Reject an invalid library baseline before spending three model sessions on it.
  if (!previous.baselineChecked) await withWikiSkillAlias(root, () => runWikiValidation(root, workspace.artifactRoot, ['.agents/skills/knowledge-lint/scripts/validate_wiki_gate.py', '--root', root, '--all'], signal))
  await writeFile(marker, JSON.stringify({ binding, baselineChecked: true }))
  const documents = []
  for (const doc of input.documents) {
    const relative = await relativeToRoot(workspace.artifactRoot, String(doc.path))
    const file = await scopedPath(workspace.artifactRoot, relative, [''])
    if (sha256(await readFile(file)) !== doc.sha256) throw new CloudError('知识回流输入文档与验收摘要不一致', 409)
    documents.push({ role: doc.role, path: relative, sha256: doc.sha256 })
  }
  const evidence = { appId: input.appId, targets: input.targets, title: input.title, code: input.code, androidSha: workspace.androidSha, androidSources: workspace.androidSources, documents }
  await writeFile(path.join(draft, 'merge-evidence.json'), JSON.stringify(evidence, null, 2))
  const sourceTools = (await executionTools(workspace, signal, async () => {}, false)).filter(tool => ['artifact_read', 'artifact_list', 'harness_rule', 'harness_rule_catalog', 'source_list'].includes(tool.definition.name))
  const roles = ['analyst', 'writer', 'reviewer'] as const
  const actors: Record<string, string> = {}
  for (const role of roles) {
    const coverage = new ReadCoverage()
    await input.progress(`知识回流：${role}，只处理已合入且通过验收的能力`)
    const readable = taskTool('wiki_read', '分页读取规则、manifest 路由、功能包或本轮草稿；禁止泛读全库', { path: { type: 'string' }, offset: { type: 'integer' } }, ['path'], async args => {
      const content = await readScoped(root, args.path, readPrefixes, Number(args.offset || 0), true)
      coverage.add(String(args.path), Number(args.offset || 0), content)
      return textResult(content)
    })
    const tools = [readable, ...sourceTools, taskTool('wiki_list', '列出指定目录的直接子项', { path: { type: 'string' } }, ['path'], async args => {
      const directory = await scopedPath(root, args.path, readPrefixes, false, true)
      return textResult((await readdir(directory, { withFileTypes: true })).filter(entry => !entry.isSymbolicLink()).slice(0, 200).map(entry => ({ name: entry.name, directory: entry.isDirectory() })))
    }), taskTool('accepted_source_read', '读取已核实合入的固定源码提交；交接后开发修复由本地复核负责，原始自动验收文档不代表覆盖后续提交', { platform: { type: 'string', enum: ['android', 'harmony'] }, path: { type: 'string' }, offset: { type: 'integer' } }, ['platform', 'path'], async args => {
      const platform = String(args.platform), relative = String(args.path)
      if (!['android', 'harmony'].includes(platform) || !inScope(relative, platform === 'android' ? workspace.androidPrefixes : [''])) throw new CloudError('源码路径越界', 403)
      if (!/\.(?:java|kt|ets|ts|xml|md|json|json5|txt)$/.test(relative) || /(?:^|\/)(?:build-profile\.json5|credentials[^/]*|secrets[^/]*)$/i.test(relative)) throw new CloudError('知识回流只读业务文本，不读取签名或凭据配置', 403)
      const nested = platform === 'android' ? workspace.androidSources?.filter(source => relative.startsWith(`${source.suffix}/`)).sort((a, b) => b.suffix.length - a.suffix.length)[0] : undefined
      const sha = platform === 'android' ? nested?.sha || workspace.androidSha : input.code.mergedSha || input.code.sha
      if (!sha || !/^[a-f0-9]{40,64}$/.test(sha)) throw new CloudError('缺少固定源码提交', 409)
      const sourceRoot = platform === 'android' ? nested ? path.join(workspace.androidRoot, nested.suffix) : workspace.androidRoot : input.code.sourceRoot || workspace.harmonyRoot
      const text = await git(sourceRoot, ['show', `${sha}:${nested ? relative.slice(nested.suffix.length + 1) : relative}`], signal)
      const offset = Number(args.offset || 0)
      if (!Number.isSafeInteger(offset) || offset < 0) throw new CloudError('读取偏移非法')
      return textResult({ sha, text: text.slice(offset, offset + 24000), nextOffset: offset + 24000 < text.length ? offset + 24000 : null })
    })]
    if (role !== 'reviewer') tools.push(taskTool('wiki_draft', '仅保存当前角色的草稿，不写知识库正文；path 为 .wiki-tmp 下的文件名', { name: { type: 'string' }, content: { type: 'string' } }, ['name', 'content'], async args => {
      if (typeof args.name !== 'string' || !/^[a-z0-9-]+\.(md|json)$/.test(args.name) || typeof args.content !== 'string' || Buffer.byteLength(args.content) > 256000) throw new CloudError('草稿参数非法')
      if (role === 'analyst' ? !['context-packet.md', 'step1-latest.json'].includes(args.name) : ['context-packet.md', 'step1-latest.json', 'cloud-knowledge.json', 'merge-evidence.json', 'role-handoff.json'].includes(args.name)) throw new CloudError('当前角色不能修改该草稿', 403)
      if ((await readdir(draft)).length > 40) throw new CloudError('知识草稿数量超限', 413)
      const file = await scopedPath(root, `.wiki-tmp/${args.name}`, ['.wiki-tmp'], true, true)
      await writeFile(file, args.content)
      return textResult({ saved: args.name })
    }))
    const endpoint = await startTaskTools(tools, signal, input.progress)
    try {
      let corrections = 0
      const output = await runAnalysisInstance({ model: input.model, knowledge: true, signal, taskMcp: endpoint.config, maxDurationMs: 20 * 60000,
        prompt: `当前角色 ${role}。读取 AGENTS.md、.agents/skills/knowledge-ingest/SKILL.md 与 required references，以新版 canonical features/manifest 规则为准，过时 common/apps/route-index 规则不得采用。先读 .wiki-tmp/merge-evidence.json，按 App/源码证据解析 target，不猜跨项目结论。\n${role === 'analyst' ? '读取精确验收四文档和必要源码、catalog/route shard，按 ingest 分析合同输出 context-packet.md 和 step1-latest.json；复用已存在 capability，冲突必须明确列出，不写正文。' : role === 'writer' ? '读取 analyst 的 context-packet.md、step1-latest.json，再定点读取已有页面。输出最终 Markdown 草稿和 apply-plan.json。plan.operation=ingest，page.path 使用 wiki/features 或 wiki/sources 下路径，action只用create/update，content_file使用 .wiki-tmp/文件名，不写删除或生成索引；包括 summary/date/log。新包补全双端 code_map；按 App target 使用合适 variant；四份案卷及 Harness JSON 不复制进 wiki。' : '独立只读复核 analyst 与 writer 的产物、来源源码与文档、target/capability、README路由、双端code_map。只输出JSON {"approved":true或false,"findings":[问题]}。证据不足不能批准，不修改正文。'}\n完成前确保工具写入成功。`,
        onTurnComplete: async () => {
          const pending = coverage.pending(requiredRules)
          if (pending.length && corrections++ < 2) return `请继续当前会话，补齐以下规则的未读部分再结束：${JSON.stringify(pending)}`
          coverage.require(requiredRules)
          return null
        },
        onInstance: async receipt => { if (receipt.sessionId) actors[role] = receipt.sessionId; await input.instance(receipt) }, onProgress: input.progress })
      coverage.require(requiredRules)
      if (role === 'analyst') {
        const analysis = record(JSON.parse(await readFile(path.join(draft, 'step1-latest.json'), 'utf8')))
        if (!Array.isArray(analysis.contradictions) || analysis.contradictions.length || record(analysis.target_resolution).confidence !== 'high' || !input.targets.includes(String(record(analysis.target_resolution).target)) || record(analysis.capability_resolution).confidence !== 'high') throw new CloudError('知识落点或事实存在冲突，保留草稿等待确认', 409)
      }
      if (role === 'writer') await validateKnowledgePlan(root)
      if (role === 'reviewer') {
        const result = record(JSON.parse(output.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')))
        await writeFile(path.join(draft, 'review.json'), JSON.stringify(result))
        if (result.approved !== true || !Array.isArray(result.findings) || result.findings.length) throw new CloudError('知识独立复核未通过，保留草稿与问题，不创建 MR', 409)
      }
    } finally { const settled = await endpoint.drain(5000); await endpoint.close(); if (!settled) throw new CloudRecoveryError('知识工具仍在执行，需先恢复', 503) }
  }
  if (Object.keys(actors).length !== 3 || new Set(Object.values(actors)).size !== 3) throw new CloudError('知识角色未形成独立会话收据', 409)
  const { planPath, pages } = await validateKnowledgePlan(root)
  const handoff = { contract_type: 'wiki_role_handoff_v1', workflow: 'ingest', summary: input.title, date: new Date().toISOString().slice(0, 10), mode: 'multi_agent', fallback_reason: '',
    roles: Object.fromEntries(roles.map(role => [role, { actor: actors[role], responsibility: role, inputs: ['.wiki-tmp/merge-evidence.json'], outputs: role === 'analyst' ? ['.wiki-tmp/context-packet.md', '.wiki-tmp/step1-latest.json'] : role === 'writer' ? ['.wiki-tmp/apply-plan.json'] : ['.wiki-tmp/review.json'] }])),
    artifacts: [{ name: 'context_packet', path: '.wiki-tmp/context-packet.md', producer_role: 'analyst' }, { name: 'decision_file', path: '.wiki-tmp/step1-latest.json', producer_role: 'analyst' }, { name: 'apply_plan', path: '.wiki-tmp/apply-plan.json', producer_role: 'writer' }] }
  await writeFile(path.join(draft, 'role-handoff.json'), JSON.stringify(handoff))
  await input.guard()
  await withWikiSkillAlias(root, async () => {
    await runWikiValidation(root, workspace.artifactRoot, ['.agents/skills/knowledge-base/scripts/validate_role_handoff.py', '.wiki-tmp/role-handoff.json'], signal)
    await runWikiValidation(root, workspace.artifactRoot, ['.agents/skills/knowledge-base/scripts/apply_wiki_plan.py', planPath], signal)
    await runWikiValidation(root, workspace.artifactRoot, ['.agents/skills/knowledge-lint/scripts/validate_wiki_gate.py', '--root', root, 'log.md', 'android_wiki/index.md', 'android_wiki/code.md', ...pages.map(file => `android_wiki/${file}`)], signal)
    await runWikiValidation(root, workspace.artifactRoot, ['.agents/skills/knowledge-base/scripts/build_wiki_indexes.py', '--root', root, '--check'], signal)
  })
  await writeFile(marker, JSON.stringify({ binding, completed: true, diffHash: await knowledgeFingerprint(root, signal) }))
  return wikiPublishPrefixes
}
