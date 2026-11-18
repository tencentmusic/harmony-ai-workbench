import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { assetTools } from './asset-tools'
import { minimumFreeBytes } from './capacity'
import type { HarnessWorkspace } from './harness'

test('analysis image tools preserve bytes and reject cross-App paths and disguised images', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-assets-'))
  try {
    await mkdir(path.join(root, 'android/app'), { recursive: true })
    await mkdir(path.join(root, 'artifacts'))
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#38ad71' } }).png().toBuffer()
    await writeFile(path.join(root, 'android/app/cover.png'), bytes)
    await writeFile(path.join(root, 'android/app/fake.jpg'), bytes)
    const tools = assetTools({ androidRoot: path.join(root, 'android'), androidPrefixes: ['app'], artifactRoot: path.join(root, 'artifacts') } as HarnessWorkspace, new AbortController().signal, false)
    assert.deepEqual(tools.map(tool => tool.definition.name), ['source_image'])
    const result = await tools[0].call({ path: 'app/cover.png' })
    const content = result.content[0]
    assert.equal(content.type, 'text')
    const output = JSON.parse(content.type === 'text' ? content.text : '')
    assert.deepEqual(await readFile(path.join(root, 'artifacts', output.path)), bytes)
    await tools[0].call({ path: 'app/cover.png' })
    await assert.rejects(tools[0].call({ path: 'other/cover.png' }), /范围/)
    await assert.rejects(tools[0].call({ path: 'app/fake.jpg' }), /格式不一致/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('disk budget has bounded configuration', () => {
  assert.equal(minimumFreeBytes('5'), 5 * 1024 ** 3)
  for (const invalid of ['', 'NaN', '-1', '0', '2048']) assert.throws(() => minimumFreeBytes(invalid), /1-1024/)
})
