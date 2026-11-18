import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, link } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { executionTools, type HarnessWorkspace } from './harness'
import { sha256 } from './scoped-files'
import { CloudError } from './domain'

test('artifact reader previews archived images without altering originals or text pagination', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-preview-'))
  try {
    const workspace: HarnessWorkspace = { identity: 'synthetic', artifactRoot: root, runDir: path.join(root, 'harness'),
      harmonyRoot: root, androidRoot: root, branch: 'feature/test', baseSha: 'test', androidPrefixes: [''],
      harmonyPrefixes: [''], appId: 'test', title: 'test', profile: path.join(root, 'profile.md') }
    const tools = await executionTools(workspace, new AbortController().signal, async () => {}, false)
    const reader = tools.find(tool => tool.definition.name === 'artifact_read')!
    for (const [folder, format] of [['execution', 'png'], ['materials', 'jpeg'], ['candidates', 'webp']] as const) {
      await mkdir(path.join(root, folder))
      const relative = `${folder}/sample.${format}`
      const bytes = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#346782' } }).toFormat(format).toBuffer()
      await writeFile(path.join(root, relative), bytes)
      const result = await reader.call({ path: relative })
      const metadata = result.content.find(item => item.type === 'text')!
      assert.equal(metadata.type, 'text')
      if (metadata.type !== 'text') throw new Error('Missing metadata')
      const info = JSON.parse(metadata.text)
      assert.equal(info.sha256, sha256(bytes))
      assert.equal(info.relativePath, relative)
      assert.equal(info.originalWidth, 2000)
      assert.equal(info.originalHeight, 1000)
      assert.equal(info.previewOnly, true)
      const image = result.content.find(item => item.type === 'image')!
      assert.equal(image.type, 'image')
      if (image.type !== 'image') throw new Error('Missing preview')
      const preview = await sharp(Buffer.from(image.data, 'base64')).metadata()
      assert.equal(preview.width, 1600)
      assert.equal(preview.height, 800)
      assert.deepEqual(await readFile(path.join(root, relative)), bytes)
      await assert.rejects(reader.call({ path: relative, offset: 1 }), /图片.*偏移/)
    }
    const text = 'a'.repeat(25000)
    await writeFile(path.join(root, 'notes.md'), text)
    const first = (await reader.call({ path: 'notes.md' })).content[0]
    assert.equal(first.type, 'text')
    if (first.type !== 'text') throw new Error('Missing text')
    assert.equal(JSON.parse(first.text).nextOffset, 24000)
    const next = (await reader.call({ path: 'notes.md', offset: 24000 })).content[0]
    if (next.type !== 'text') throw new Error('Missing text')
    assert.equal(JSON.parse(next.text).text, text.slice(24000))
    assert.equal(JSON.parse(next.text).nextOffset, null)
    await assert.rejects(reader.call({ path: '../outside.png' }), /范围/)
    await link(path.join(root, 'execution/sample.png'), path.join(root, 'linked.png'))
    await assert.rejects(reader.call({ path: 'linked.png' }), /链接/)
    await writeFile(path.join(root, 'broken.png'), 'not an image')
    await assert.rejects(reader.call({ path: 'broken.png' }), error => error instanceof CloudError && /图片/.test(error.message))
    await writeFile(path.join(root, 'large.png'), Buffer.alloc(12 * 1024 * 1024 + 1))
    await assert.rejects(reader.call({ path: 'large.png' }), /12 MiB/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
