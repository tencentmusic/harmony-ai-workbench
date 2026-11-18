import path from 'node:path'
import { readFile, writeFile, mkdir, stat, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import { visit } from 'unist-util-visit'
import type { Link, Image, Definition } from 'mdast'
import { CloudError, record } from './domain'
import { scopedPath, sha256 } from './scoped-files'

export async function bundleKnowledgeDocuments(artifactRoot: string, documents: Record<string, unknown>[], outputRoot: string, evidence: unknown) {
  artifactRoot = await realpath(artifactRoot)
  const names = new Map<string, string>()
  for (const doc of documents) {
    const role = String(doc.role).replaceAll('_', '-')
    if (!['scope', 'requirements', 'technical-plan', 'acceptance-report'].includes(role)) throw new CloudError('交付角色非法')
    names.set(await realpath(String(doc.path)), `${role}.md`)
  }
  if (names.size !== 4 || new Set(names.values()).size !== 4) throw new CloudError('需要四份交付文档')
  await mkdir(outputRoot, { recursive: true })
  outputRoot = await realpath(outputRoot)
  await mkdir(await scopedPath(outputRoot, 'assets', ['assets'], true), { recursive: true })
  let total = 0
  const assets = new Map<string, { relative: string; sha256: string }>()
  const store = async (file: string, content: Buffer | string) => {
    await scopedPath(outputRoot, path.relative(outputRoot, file).replaceAll('\\', '/'), [''], true)
    await writeFile(file, content, { flag: 'wx' }).catch(async error => {
      if (error.code !== 'EEXIST' || sha256(await readFile(file)) !== sha256(content)) throw error
    })
  }
  const copy = async (absolute: string, expected?: string) => {
    absolute = await realpath(absolute)
    const relative = path.relative(artifactRoot, absolute).replaceAll('\\', '/')
    const file = await scopedPath(artifactRoot, relative, [''])
    const ext = path.extname(file).toLowerCase()
    if (!['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.webm', '.pdf'].includes(ext)) throw new CloudError('知识回流只发布图片、视频和 PDF；日志或源码链接需另行受控归档', 409)
    if (assets.has(file)) {
      const existing = assets.get(file)!
      if (expected && existing.sha256 !== expected) throw new CloudError('回流资源与验收证据不一致', 409)
      return existing
    }
    const info = await stat(file)
    total += info.size
    if (!info.isFile() || total > 50 * 1024 * 1024) throw new CloudError('知识附件总量超过 50MiB，需要独立受控归档', 413)
    const bytes = await readFile(file), hash = sha256(bytes)
    if (expected && expected !== hash) throw new CloudError('回流资源与验收证据不一致', 409)
    const value = { relative: `assets/${hash}${ext}`, sha256: hash }
    await store(path.join(outputRoot, value.relative), bytes)
    assets.set(file, value)
    return value
  }
  const records: Record<string, unknown>[] = []
  const collect = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(collect); return }
    if (!value || typeof value !== 'object') return
    const row = record(value)
    if (typeof row.path === 'string' && typeof row.sha256 === 'string' && /\.(png|jpe?g|webp|mp4|webm|pdf)$/i.test(row.path)) records.push(row)
    Object.values(row).forEach(collect)
  }
  collect(evidence)
  for (const item of records) await copy(String(item.path), String(item.sha256))
  const manifest: { file: string; originalSha256: string; publishedSha256: string }[] = []
  for (const doc of documents) {
    const original = await realpath(String(doc.path))
    const source = await scopedPath(artifactRoot, path.relative(artifactRoot, original).replaceAll('\\', '/'), [''])
    const bytes = await readFile(source)
    if (bytes.length > 2 * 1024 * 1024 || sha256(bytes) !== doc.sha256) throw new CloudError('交付文档发生变化或过大', 409)
    const processor = unified().use(remarkParse).use(remarkStringify)
    const tree = processor.parse(bytes.toString('utf8'))
    const links: (Link | Image | Definition)[] = []
    visit(tree, node => { if (node.type === 'link' || node.type === 'image' || node.type === 'definition') links.push(node) })
    for (const link of links) {
      if (/^(https?:|mailto:|#)/i.test(link.url)) continue
      const decoded = decodeURIComponent(link.url)
      if (/^[a-z][\w+.-]*:/i.test(decoded) && !/^file:|^[A-Za-z]:[/\\]/.test(decoded)) throw new CloudError('知识链接协议不允许', 409)
      const parts = decoded.split('#'), locator = parts[0]
      const absolute = locator.startsWith('file:') ? fileURLToPath(locator) : path.resolve(path.dirname(source), locator)
      link.url = (names.get(await realpath(absolute)) || (await copy(absolute)).relative) + (parts[1] ? `#${parts[1]}` : '')
    }
    let published = processor.stringify(tree)
    if (String(doc.role).replaceAll('_', '-') === 'acceptance-report' && assets.size) published += '\n## 验收资源归档\n\n' + [...new Set([...assets.values()].map(value => value.relative))].map(relative => `- [${path.basename(relative)}](${relative})`).join('\n') + '\n'
    const file = names.get(original)!
    await store(path.join(outputRoot, file), published)
    manifest.push({ file, originalSha256: String(doc.sha256), publishedSha256: sha256(published) })
  }
  await store(path.join(outputRoot, 'publication.json'), JSON.stringify({ documents: manifest, assets: [...assets.values()] }, null, 2))
  return { documents: manifest, assets: [...assets.values()] }
}
