import path from 'node:path'
import { mkdir, readFile, readdir, stat, writeFile, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import { visit } from 'unist-util-visit'
import type { Link, Image, Definition } from 'mdast'
import type { CloudDeviceConclusion, CloudReview } from '@/contracts/cloud-agent'
import type { HarnessWorkspace } from './harness'
import { CloudError, record } from './domain'
import { scopedPath, sha256, relativeToRoot } from './scoped-files'

export interface DocumentOverlay {
  prefix: string; appId: string; identity: string
  files: { name: string; source: string; sha256: string }[]
}

export function documentPrefix(root: string, appId: string, identity: string) {
  const safe = (part: string) => /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,100}$/.test(part) && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
  if (!root.startsWith('docs/') || root.length > 160 || !root.split('/').every(safe) || !safe(appId) || !safe(identity)) throw new CloudError('分支文档目录必须是 docs 下的安全相对路径，且按 App 和任务隔离', 409)
  return `${root}/${appId}/${identity}`
}

function portableText(text: string, workspace: HarnessWorkspace, aliases: string[][] = []) {
  let result = text
  for (const [root, label] of [[workspace.artifactRoot, 'artifacts'], ...aliases, [workspace.androidRoot, 'android'], [workspace.harmonyRoot, 'harmony']]) {
    for (const spelling of new Set([root, root.replaceAll('\\', '/'), root.replaceAll('/', '\\'), root.replaceAll('\\', '\\\\')])) result = result.split(spelling).join(label)
  }
  return result.replace(/\b[A-Za-z]:[/\\][^\s<>"`\])]+/g, '[本机路径已省略]')
    .replace(/\/(?:Users|home|tmp|var|opt|mnt)\/[^\s<>"`\])]+/g, '[本机路径已省略]')
}

async function immutable(file: string, bytes: string | Buffer) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }).catch(async error => {
    if (error.code !== 'EEXIST' || sha256(await readFile(file)) !== sha256(bytes)) throw new CloudError('分支文档归档已被修改，未覆盖原记录', 409)
  })
}

export async function archiveReviewDraft(workspace: HarnessWorkspace, review: CloudReview) {
  if (!/^[a-f0-9]{64}$/.test(review.digest)) throw new CloudError('审核摘要非法')
  const name = `branch-drafts/v${review.materialVersion}-${review.digest}/requirements.md`
  const file = await scopedPath(workspace.artifactRoot, name, ['branch-drafts'], true)
  await immutable(file, `# 审核草稿 · 材料 v${review.materialVersion}\n\n状态：待人工审批，尚未提交到分支。\n审核摘要：${review.digest}\n\n${portableText(review.content, workspace)}`)
}

export async function prepareDeviceConclusionDocuments(workspace: HarnessWorkspace, conclusion: CloudDeviceConclusion): Promise<DocumentOverlay> {
  const prefix = documentPrefix(workspace.documentsPath || 'docs/migrations', workspace.appId, workspace.identity)
  const result = conclusion.result === 'passed' ? '通过' : '未完成（存在未通过或缺失证据）'
  const lines = [
    '# 设备验收结论', '', `结论：${result}`, `任务：${workspace.identity}`, `材料版本：${conclusion.materialVersion}`,
    `源码 HEAD：${conclusion.sourceHeadSha}`, `HAP SHA256：${conclusion.hapSha256 || '原始报告未登记'}`,
    `原始验证报告 SHA256：${conclusion.verificationSha256}`, `结论时间：${conclusion.concludedAt}`,
    '', '## 设备门禁', '', ...conclusion.nodes.map(node => `- ${node.label}：${node.status}`),
    '', '## 未解决问题', '', ...(conclusion.blockers.length ? conclusion.blockers.map(item => `- [${item.code}] ${item.message.replaceAll('\n', ' ')}`) : ['- 无已登记阻塞']),
    '', '## 本轮停止原因', '', conclusion.reason, '', '原始运行档案、设备收据和视觉报告保留在工作台；本文件不将未完成项判定为通过。',
  ]
  const files = new Map<string, Buffer>([
    ['device-acceptance.md', Buffer.from(portableText(lines.join('\n'), workspace))],
    ['device-conclusion.json', Buffer.from(JSON.stringify(conclusion, null, 2))],
    ['README.md', Buffer.from(`# ${workspace.title}\n\n设备结论：${result}\n\n[设备验收结论](device-acceptance.md)\n\n此分支供开发本地复核；未完成的设备项目须在提测环节处理。\n`)],
  ])
  const digest = sha256(JSON.stringify([...files].map(([name, bytes]) => [name, sha256(bytes)])))
  const output: DocumentOverlay['files'] = []
  for (const [name, bytes] of files) {
    const source = await scopedPath(workspace.artifactRoot, `branch-documents/${digest}/${name}`, ['branch-documents'], true)
    await immutable(source, bytes)
    output.push({ name, source, sha256: sha256(bytes) })
  }
  return { prefix, appId: workspace.appId, identity: workspace.identity, files: output }
}

export async function prepareBranchDocuments(workspace: HarnessWorkspace): Promise<DocumentOverlay> {
  const originalRoot = workspace.artifactRoot
  workspace = { ...workspace, artifactRoot: await realpath(workspace.artifactRoot), runDir: await realpath(workspace.runDir) }
  const portable = (text: string) => portableText(text, workspace, [[originalRoot, 'artifacts']])
  const prefix = documentPrefix(workspace.documentsPath || 'docs/migrations', workspace.appId, workspace.identity)
  const report = record(JSON.parse(await readFile(await scopedPath(workspace.artifactRoot, path.relative(workspace.artifactRoot, path.join(workspace.runDir, 'verification-report.json')).replaceAll('\\', '/'), ['']), 'utf8')))
  const values = record(report.delivery).documents
  if (!Array.isArray(values)) throw new CloudError('分支归档缺少已验收文档', 409)
  const docs = values.map(record)
  for (const doc of docs) doc.path = await scopedPath(originalRoot, path.relative(originalRoot, String(doc.path)).replaceAll('\\', '/'), [''])
  const roles = ['scope', 'requirements', 'technical-plan', 'acceptance-report']
  if (docs.length !== 4 || new Set(docs.map(d => String(d.role).replaceAll('_', '-'))).size !== 4) throw new CloudError('分支归档需要四份交付文档', 409)
  const output = new Map<string, Buffer>()
  const references: string[] = []
  const evidenceIndex = new Map<string, string>()
  const imageReferences = new Map<string, { path: string; sha256: string } | null>()
  const processor = unified().use(remarkParse).use(remarkStringify)
  const appliedReferences = new Set<string>()
  const collect = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(collect); return }
    if (!value || typeof value !== 'object') return
    const row = record(value)
    if (typeof row.approval_reference === 'string') appliedReferences.add(row.approval_reference)
    if (typeof row.path === 'string' && typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.sha256)) evidenceIndex.set(portable(row.path).replaceAll('\\', '/'), row.sha256)
    if (typeof row.path === 'string' && /\.(png|jpe?g|webp)$/i.test(row.path) && typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.sha256)) {
      const reference = { path: row.path, sha256: row.sha256 }
      // Legacy Markdown consumed Windows backslashes before punctuation, e.g. \.runtime.
      // Recover only a unique registered image, never guess or search outside the task.
      visit(processor.parse(`[image](<${row.path}>)`), 'link', node => {
        const key = decodeURIComponent(node.url), prior = imageReferences.get(key)
        imageReferences.set(key, !imageReferences.has(key) || prior?.path === reference.path && prior.sha256 === reference.sha256 ? reference : null)
      })
    }
    Object.values(row).forEach(collect)
  }
  collect(report)
  for (const name of ['evidence-ledger.json', 'parity-matrix.json']) {
    const file = await scopedPath(workspace.artifactRoot, path.relative(workspace.artifactRoot, path.join(workspace.runDir, name)).replaceAll('\\', '/'), [''], true)
    const data = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (data) collect(JSON.parse(data))
  }
  const names = new Map(docs.map(d => [path.resolve(String(d.path)), `${String(d.role).replaceAll('_', '-')}.md`]))
  let assetBytes = 0
  async function publishMarkdown(text: string, source: string) {
    const tree = processor.parse(text)
    const links: (Link | Image | Definition)[] = []
    visit(tree, node => { if (node.type === 'link' || node.type === 'image' || node.type === 'definition') links.push(node) })
    for (const link of links) {
      if (link.url.startsWith('#')) continue
      if (/^https?:/i.test(link.url)) {
        const url = new URL(link.url)
        if (url.username || url.password || url.search) { url.username = ''; url.password = ''; url.search = ''; link.url = url.href }
        continue
      }
      const decoded = decodeURIComponent(link.url), [locator, anchor] = decoded.split('#')
      if (/^[a-z][\w+.-]*:/i.test(locator) && !/^file:|^[A-Za-z]:[/\\]/.test(locator)) { link.url = '#'; continue }
      const absolute = locator.startsWith('file:') ? fileURLToPath(locator) : path.resolve(path.dirname(source), locator)
      const docName = names.get(absolute)
      if (docName) { link.url = docName + (anchor ? `#${anchor}` : ''); continue }
      const relative = path.relative(workspace.artifactRoot, absolute).replaceAll('\\', '/')
      if (/\.(png|jpe?g|webp)$/i.test(absolute)) {
        const reference = imageReferences.get(locator)
        if (reference === null) throw new CloudError('登记图片路径不唯一，不能恢复历史链接', 409)
        const safe = await scopedPath(workspace.artifactRoot, reference ? await relativeToRoot(workspace.artifactRoot, reference.path) : relative, [''])
        const info = await stat(safe)
        if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new CloudError('分支文档图片超过 10MiB，需受控归档', 413)
        const bytes = await readFile(safe), name = `assets/${sha256(bytes)}${path.extname(safe).toLowerCase()}`
        if (reference && sha256(bytes) !== reference.sha256) throw new CloudError('登记图片摘要已变化，未归档', 409)
        if (!output.has(name)) assetBytes += bytes.length
        if (assetBytes > 25 * 1024 * 1024) throw new CloudError('分支文档图片总量超过 25MiB', 413)
        output.set(name, bytes); link.url = name
      } else {
        const id = `reference-${references.length + 1}`
        const locator = portable(absolute).replaceAll('\\', '/')
        references.push(`## ${id}\n\n${locator}\n\nSHA256：${evidenceIndex.get(locator) || '未登记；以原始材料索引核验，不视为已验证证据'}\n\n原始材料保留在受控任务档案，不随源码提交。`)
        link.url = `evidence.md#${id}`
      }
    }
    return portable(processor.stringify(tree))
  }
  const sourceHashes: { role: string; sha256: string }[] = []
  for (const doc of docs) {
    const role = String(doc.role).replaceAll('_', '-')
    if (!roles.includes(role)) throw new CloudError('分支文档角色非法', 409)
    const source = await scopedPath(workspace.artifactRoot, path.relative(workspace.artifactRoot, String(doc.path)).replaceAll('\\', '/'), [''])
    if ((await stat(source)).size > 2 * 1024 * 1024) throw new CloudError('分支文档过大', 413)
    const bytes = await readFile(source)
    if (sha256(bytes) !== doc.sha256) throw new CloudError('分支文档与验收摘要不一致', 409)
    sourceHashes.push({ role, sha256: String(doc.sha256) })
    output.set(`${role}.md`, Buffer.from(await publishMarkdown(bytes.toString('utf8'), source)))
  }
  const approvals = await readdir(path.join(workspace.artifactRoot, 'approvals'), { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  const records: string[] = []
  for (const entry of approvals.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const source = await scopedPath(workspace.artifactRoot, `approvals/${entry.name}/human.txt`, ['approvals'], true)
    const bytes = await readFile(source).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    // Supplemental human evidence is not necessarily a workbench approval record.
    if (bytes === null) continue
    if (bytes.length > 24000) throw new CloudError('审核记录过大', 413)
    const row = record(JSON.parse(bytes.toString('utf8')))
    records.push(`## ${entry.name}\n\n记录状态：${appliedReferences.has(String(row.reference)) ? '已被当前 Harness 账本引用' : '历史或未应用记录，不作为当前门禁批准'}\n\n类型：${row.kind}\n\n决定：${row.decision}\n\n审核人：${row.actorId}\n\n时间：${row.decidedAt}\n\n审核摘要：${row.digest}\n\n依据：${row.reason}\n\n原始记录 SHA256：${sha256(bytes)}`)
    const presented = await scopedPath(workspace.artifactRoot, `approvals/${entry.name}/presented.md`, ['approvals'], true)
    const text = await readFile(presented, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (text) {
      const name = `reviewed-${sha256(text)}.md`
      output.set(name, Buffer.from(await publishMarkdown(text, presented)))
      records.push(`[当时展示的审核正文](${name})\n\n原始正文 SHA256：${sha256(text)}`)
    }
  }
  output.set('review-record.md', Buffer.from(portable('# 人工审核记录\n\n' + (records.join('\n\n') || '无可归档记录；本文不构成人工批准。'))))
  output.set('evidence.md', Buffer.from('# 原始材料索引\n\n' + references.join('\n\n') + '\n\n## 已登记证据摘要\n\n' + [...evidenceIndex].map(([locator, hash]) => `- ${locator}\n  SHA256: ${hash}`).join('\n')))
  output.set('README.md', Buffer.from(`# ${portable(workspace.title)}\n\nApp：${workspace.appId}\n任务：${workspace.identity}\n材料版本：${workspace.materialVersion || 1}\n基线：${workspace.baseSha}\n目标：${workspace.targetBranch || ''}\n\n` +
    ['scope', 'requirements', 'technical-plan', 'acceptance-report', 'review-record', 'evidence'].map(name => `- [${name}](${name}.md)`).join('\n') + '\n\n文档与代码位于同一交付提交；原始证据以运行档案为准。\n'))
  output.set('publication.json', Buffer.from(JSON.stringify({ task: workspace.identity, materialVersion: workspace.materialVersion, sourceDocuments: sourceHashes,
    files: [...output].map(([name, bytes]) => ({ name, sha256: sha256(bytes) })) }, null, 2)))
  const digest = sha256(JSON.stringify([...output].map(([name, bytes]) => [name, sha256(bytes)])))
  const files: DocumentOverlay['files'] = []
  if (output.size > 100) throw new CloudError('分支归档文档与图片超过 100 项', 413)
  for (const [name, bytes] of output) {
    const source = await scopedPath(workspace.artifactRoot, `branch-documents/${digest}/${name}`, ['branch-documents'], true)
    await immutable(source, bytes)
    files.push({ name, source, sha256: sha256(bytes) })
  }
  return { prefix, appId: workspace.appId, identity: workspace.identity, files }
}
