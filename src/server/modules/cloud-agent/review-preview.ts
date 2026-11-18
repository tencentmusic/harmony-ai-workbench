import path from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { parse, serialize, type DefaultTreeAdapterMap } from 'parse5'
import valueParser from 'postcss-value-parser'
import sharp from 'sharp'
import type { NativeReview } from './harness-review'
import type { HarnessWorkspace } from './harness'
import { CloudError } from './domain'
import { scopedPath, sha256, relativeToRoot } from './scoped-files'

type Element = DefaultTreeAdapterMap['element']
type Parent = DefaultTreeAdapterMap['parentNode']
type ReviewFile = NativeReview['files'][number]
const allowedTags = new Set('html head body title style main section article header footer nav aside div span p a h1 h2 h3 h4 h5 h6 ul ol li dl dt dd img picture figure figcaption strong em b i u s small br hr pre code blockquote table thead tbody tfoot tr th td caption colgroup col button input textarea label select option optgroup fieldset legend details summary progress meter time sup sub'.split(' '))
const allowedAttrs = new Set('id class style lang dir title alt width height colspan rowspan scope span type value placeholder disabled checked selected readonly multiple min max step open role tabindex'.split(' '))
const policy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'"

export async function readReviewBytes(workspace: HarnessWorkspace, file: ReviewFile) {
  const source = file.label.startsWith('androidSources/')
  const root = source ? workspace.androidRoot : workspace.artifactRoot
  const target = await scopedPath(root, await relativeToRoot(root, file.path), source ? workspace.androidPrefixes : [''])
  if ((await stat(target)).size > 12 * 1024 * 1024) throw new CloudError('审核文件过大', 413)
  const bytes = await readFile(target)
  if (sha256(bytes) !== file.sha256) throw new CloudError('审核文件已变化', 409)
  return bytes
}

export async function buildReviewPreview(workspace: HarnessWorkspace, review: NativeReview, file: ReviewFile, bytes: Buffer) {
  if ((!file.label.startsWith('prototypes/') && file.label !== 'visual-report') || !/\.html?$/i.test(file.path)) throw new CloudError('此附件不是 HTML 预览', 400)
  const warnings = new Set<string>(), cache = new Map<string, string>()
  let resourceBytes = 0, embeddedBytes = 0
  function reserve(value: string) {
    embeddedBytes += value.length
    if (embeddedBytes > 32 * 1024 * 1024) throw new CloudError('原型预览内容超过大小限制', 413)
    return value
  }
  async function image(reference: string): Promise<string> {
    if (cache.has(reference)) return reserve(cache.get(reference)!)
    if (cache.size >= 64) throw new CloudError('原型图片数量超过预览限制', 413)
    let content: Buffer
    const embedded = /^data:image\/(?:png|jpeg|webp|gif);base64,([a-z0-9+/=]+)$/i.exec(reference)
    if (embedded) content = Buffer.from(embedded[1], 'base64')
    else {
      // No URL decoding: encoded traversal, absolute paths and remote URLs never become local reads.
      if (!reference || /[\\:%?#\x00-\x20]/.test(reference) || path.posix.isAbsolute(reference)) {
        warnings.add('部分图片引用不在审核范围内，未加载。'); return ''
      }
      const target = path.resolve(path.dirname(file.path), reference)
      const registered = review.files.find(item => path.resolve(item.path) === target && item.mime.startsWith('image/'))
      if (registered) content = await readReviewBytes(workspace, registered)
      else {
        const relative = path.relative(workspace.artifactRoot, target).replaceAll('\\', '/')
        const match = /^candidates\/assets\/([a-f0-9]{64})\.(png|jpe?g|webp|gif)$/.exec(relative)
        if (!match) { warnings.add('部分图片未登记为审核材料，未加载。'); return '' }
        const safe = await scopedPath(workspace.artifactRoot, relative, ['candidates/assets'])
        if ((await stat(safe)).size > 12 * 1024 * 1024) throw new CloudError('原型图片过大', 413)
        content = await readFile(safe)
        if (sha256(content) !== match[1]) throw new CloudError('原型图片已变化，请重新生成审核材料', 409)
      }
    }
    resourceBytes += content.length
    if (resourceBytes > 24 * 1024 * 1024) throw new CloudError('原型图片总量超过预览限制', 413)
    const metadata = await sharp(content, { limitInputPixels: 24_000_000 }).metadata()
    if (!['png', 'jpeg', 'webp', 'gif'].includes(metadata.format || '')) throw new CloudError('原型图片格式不支持', 400)
    const result = `data:image/${metadata.format};base64,${content.toString('base64')}`
    cache.set(reference, result)
    return reserve(result)
  }
  async function css(text: string) {
    const parsed = valueParser(text), urls: valueParser.FunctionNode[] = []
    parsed.walk(node => { if (node.type === 'function' && node.value.toLowerCase() === 'url') { urls.push(node); return false } })
    for (const node of urls) {
      const ref = node.nodes.length === 1 && ['word', 'string'].includes(node.nodes[0].type) ? node.nodes[0].value : ''
      const embedded = await image(ref)
      node.nodes = [{ type: 'string', quote: '"', value: embedded, sourceIndex: 0, sourceEndIndex: 0 }]
    }
    return parsed.toString()
  }
  const tree = parse(bytes.toString('utf8'))
  let title = ''
  async function clean(parent: Parent): Promise<void> {
    const children = [...parent.childNodes]
    for (const node of children) {
      if (!('tagName' in node)) continue
      if (!allowedTags.has(node.tagName) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
        if (['script', 'iframe', 'object', 'embed', 'link', 'svg'].includes(node.tagName)) warnings.add('原型中的脚本或外部嵌入已禁用。')
        parent.childNodes.splice(parent.childNodes.indexOf(node), 1)
        continue
      }
      if (node.tagName === 'title') title = node.childNodes.filter(child => child.nodeName === '#text').map(child => 'value' in child ? child.value : '').join('')
      const attributes = []
      for (const attr of node.attrs) {
        if (attr.namespace || attr.prefix) continue
        if (node.tagName === 'img' && attr.name === 'src') {
          const src = await image(attr.value)
          if (src) attributes.push({ name: 'src', value: src })
        } else if (attr.name === 'style') attributes.push({ name: 'style', value: await css(attr.value) })
        else if (allowedAttrs.has(attr.name) || /^(?:aria|data)-[a-z0-9-]+$/.test(attr.name)) attributes.push(attr)
      }
      node.attrs = attributes
      if (node.tagName === 'style') {
        for (const child of node.childNodes) if ('value' in child) child.value = await css(child.value)
      } else await clean(node)
    }
  }
  await clean(tree)
  const html = tree.childNodes.find((node): node is Element => 'tagName' in node && node.tagName === 'html')!
  const head = html.childNodes.find((node): node is Element => 'tagName' in node && node.tagName === 'head')!
  const secure = parse(`<html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head></html>`)
  const secureHtml = secure.childNodes.find((node): node is Element => 'tagName' in node && node.tagName === 'html')!
  const secureHead = secureHtml.childNodes.find((node): node is Element => 'tagName' in node && node.tagName === 'head')!
  head.childNodes.unshift(...secureHead.childNodes)
  let width = 390, height = 844
  const render = file.label.startsWith('prototypes/') ? review.files.find(item => item.label === file.label.replace('prototypes/', 'prototypeRenders/')) : undefined
  if (render) {
    const meta = await sharp(await readReviewBytes(workspace, render), { limitInputPixels: 24_000_000 }).metadata()
    width = meta.width || width; height = meta.height || height
  } else warnings.add('缺少渲染尺寸，使用默认视口；可在原型内滚动查看。')
  return { html: serialize(tree), title, width, height, warnings: [...warnings] }
}
