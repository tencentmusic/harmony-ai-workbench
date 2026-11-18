import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { sha256 } from './scoped-files'
import type { NativeReview } from './harness-review'
import type { HarnessWorkspace } from './harness'
import { buildReviewPreview } from './review-preview'

test('HTML preview embeds scoped hash-bound images and removes active content without changing original HTML', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-preview-'))
  try {
    await mkdir(path.join(root, 'candidates/assets'), { recursive: true })
    const bytes = await sharp({ create: { width: 24, height: 40, channels: 3, background: '#12aa88' } }).png().toBuffer()
    const reference = `assets/${sha256(bytes)}.png`
    await writeFile(path.join(root, 'candidates', reference), bytes)
    const html = `<html><head><title>完整原型</title><style>.screen{width:582px;height:1280px;background:url('${reference}')}</style><meta http-equiv="refresh" content="0;url=https://evil.invalid"></head><body onload="alert(1)"><main class="screen"><img src="${reference}"><p>底部内容</p><a href="https://evil.invalid">离开</a><script>fetch('/secret')</script><iframe src="https://evil.invalid"></iframe></main></body></html>`
    const file = { id: 'html', label: 'prototypes/example', mime: 'text/plain', path: path.join(root, 'candidates/example.html'), sha256: sha256(html) }
    const render = { id: 'render', label: 'prototypeRenders/example', mime: 'image/png', path: path.join(root, 'candidates/render.png'), sha256: sha256(bytes) }
    await writeFile(render.path, bytes)
    const review = { files: [file, render] } as NativeReview
    const workspace = { artifactRoot: root } as HarnessWorkspace
    const result = await buildReviewPreview(workspace, review, file, Buffer.from(html))
    assert.match(result.html, /data:image\/png;base64,/)
    assert.match(result.html, /height:1280px/)
    assert.match(result.html, /底部内容/)
    assert.match(result.html, /default-src 'none'/)
    assert.doesNotMatch(result.html, /<script|<iframe|onload=|href=|http-equiv="refresh"/)
    assert.equal(result.width, 24)
    assert.equal(result.height, 40)
    assert.equal(result.title, '完整原型')
    await writeFile(path.join(root, 'candidates', reference), 'changed')
    await assert.rejects(buildReviewPreview(workspace, review, file, Buffer.from(html)), /已变化/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('preview blocks outside files, network, embedded frames and missing resources explicitly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-preview-'))
  try {
    const file = { id: 'html', label: 'prototypes/example', mime: 'text/plain', path: path.join(root, 'example.html'), sha256: '' }
    const html = '<style>body{background:url(https://evil.invalid/pixel)}</style><img src="../../secret.png"><img src="https://evil.invalid/pixel"><img src="file:///secret.png"><object data="/secret"></object><svg><image href="https://evil.invalid"/></svg>'
    const result = await buildReviewPreview({ artifactRoot: root } as HarnessWorkspace, { files: [file] } as NativeReview, file, Buffer.from(html))
    assert.doesNotMatch(result.html, /secret|evil.invalid|<object|<svg/)
    assert.ok(result.warnings.length)
    assert.equal(result.width, 390)
    assert.equal(result.height, 844)
  } finally { await rm(root, { recursive: true, force: true }) }
})
