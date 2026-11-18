import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { renderPrototype } from './prototype'

test('prototype renders nonblank pixels and binds source without granting script or network access', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-prototype-'))
  try {
    await mkdir(path.join(root, 'candidates'))
    await writeFile(path.join(root, 'candidates/page.html'), '<html><body style="margin:0;background:#008080"><h1>Profile</h1><script>document.body.innerHTML="executed"</script></body></html>')
    const receipt = await renderPrototype(root, 'candidates/page.html', 390, 844, 'first', AbortSignal.timeout(45000))
    const image = sharp(await readFile(path.join(root, receipt.image.path)))
    assert.equal((await image.metadata()).width, 390)
    assert.ok((await image.stats()).channels.some(channel => channel.stdev > 1))
    assert.equal(receipt.source.sha256.length, 64)
    await assert.rejects(renderPrototype(root, '../outside.html', 390, 844, 'bad', AbortSignal.timeout(1000)))
    await writeFile(path.join(root, 'candidates/unsafe.html'), '<img src="http://127.0.0.1:3100/api/health">')
    await assert.rejects(renderPrototype(root, 'candidates/unsafe.html', 390, 844, 'unsafe', AbortSignal.timeout(45000)), /缺失资源/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
