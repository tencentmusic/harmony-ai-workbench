import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { CloudError } from './domain'
import { scopedPath, sha256 } from './scoped-files'
import { taskTool, textResult } from './task-tools'
import type { HarnessWorkspace } from './harness'

export async function renderPrototype(root: string, relative: string, width: number, height: number, operationId: string, signal: AbortSignal) {
  if (!/^[\w-]{1,80}$/.test(operationId) || !relative.endsWith('.html') || !Number.isInteger(width) || !Number.isInteger(height) || width < 240 || width > 1600 || height < 240 || height > 3200) throw new CloudError('原型路径、操作ID或视口非法')
  const file = await scopedPath(root, relative, ['candidates'])
  const html = await readFile(file)
  if (html.length > 512000) throw new CloudError('原型超过 512KB', 413)
  signal.throwIfAborted()
  const output = await scopedPath(root, `candidates/renders/${operationId}`, ['candidates'], true)
  await mkdir(output, { recursive: false }).catch(async e => {
    if (e.code === 'ENOENT') { await mkdir(path.dirname(output), { recursive: true }); await mkdir(output) }
    else throw new CloudError('原型操作ID已使用，请使用新ID保留旧版本', 409)
  })
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, timeout: 30000,
    ...(process.env.CLOUD_AGENT_CHROMIUM_BIN ? { executablePath: process.env.CLOUD_AGENT_CHROMIUM_BIN } : { channel: 'chrome' }) })
  const abort = () => { void browser.close() }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false })
    const page = await context.newPage()
    const origin = 'https://prototype.invalid'
    const url = `${origin}/${relative.split('/').map(encodeURIComponent).join('/')}`
    const denied: string[] = [], assets: { path: string; sha256: string }[] = []
    let bytes = html.length
    await context.route('**/*', async route => {
      const request = route.request(), address = new URL(request.url())
      try {
        if (request.method() !== 'GET' || address.origin !== origin) throw new Error('network')
        if (request.url() === url && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          return await route.fulfill({ body: html, contentType: 'text/html; charset=utf-8', headers: { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline' https://prototype.invalid; img-src data: https://prototype.invalid; font-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'" } })
        }
        const rel = decodeURIComponent(address.pathname.slice(1))
        const mime = ({ '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' } as Record<string, string>)[path.extname(rel).toLowerCase()]
        if (!mime || !['image', 'stylesheet'].includes(request.resourceType())) throw new Error('resource')
        const source = await scopedPath(root, rel, ['candidates', 'materials'])
        const content = await readFile(source)
        bytes += content.length
        if (bytes > 20 * 1024 * 1024) throw new Error('budget')
        assets.push({ path: rel, sha256: sha256(content) })
        await route.fulfill({ body: content, contentType: mime })
      } catch { denied.push(request.resourceType()); await route.abort() }
    })
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
    const broken = await page.locator('img').evaluateAll(images => images.some(image => !(image as HTMLImageElement).complete || !(image as HTMLImageElement).naturalWidth))
    if (denied.length || broken) throw new CloudError('原型存在外部、越界或缺失资源，请将资源放入任务材料后重试', 409)
    signal.throwIfAborted()
    const screenshot = await page.screenshot({ animations: 'disabled', type: 'png', timeout: 15000 })
    const image = { path: `candidates/renders/${operationId}/prototype.png`, sha256: sha256(screenshot) }
    await writeFile(await scopedPath(root, image.path, ['candidates'], true), screenshot, { flag: 'wx' })
    const receipt = { source: { path: relative, sha256: sha256(html) }, viewport: { width, height }, image, assets, browser: browser.version() }
    await writeFile(await scopedPath(root, `candidates/renders/${operationId}/receipt.json`, ['candidates'], true), JSON.stringify(receipt, null, 2), { flag: 'wx' })
    return receipt
  } finally { signal.removeEventListener('abort', abort); await browser.close() }
}

export function prototypeTool(workspace: HarnessWorkspace, signal: AbortSignal) {
  return taskTool('prototype_render', '将 candidates 中静态 HTML 渲染成原型图，绑定源码与资源哈希；不执行脚本、不联网、不批准 UI。使用与 Android 基线相同的视口。',
    { path: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' }, operationId: { type: 'string' } }, ['path', 'width', 'height', 'operationId'], async args =>
      textResult(await renderPrototype(workspace.artifactRoot, String(args.path), Number(args.width), Number(args.height), String(args.operationId), signal)))
}
