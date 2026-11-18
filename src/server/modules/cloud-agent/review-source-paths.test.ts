import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { reviewSourcePaths, readSigningMetadata } from './review-source-paths'

test('review recognizes a verified historical root alias without following child links', async () => {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'review-paths-')))
  try {
    const root = path.join(temp, 'physical'), alias = path.join(temp, 'old'), outside = path.join(temp, 'other')
    await mkdir(root); await mkdir(outside)
    await writeFile(path.join(root, 'entry.ets'), 'class Entry {}')
    await symlink(root, alias, 'junction')
    const trace = (file: string) => ({ changes: [{ files: [{ path: file }] }] })
    assert.deepEqual(await reviewSourcePaths(root, alias, trace(path.join(alias, 'entry.ets'))), ['entry.ets'])
    assert.deepEqual(await reviewSourcePaths(alias, root, trace(path.join(root, 'entry.ets'))), ['entry.ets'])
    assert.deepEqual(await reviewSourcePaths(root, root, trace('entry.ets')), ['entry.ets'])
    await assert.rejects(reviewSourcePaths(root, outside, trace(path.join(outside, 'entry.ets'))))
    await symlink(outside, path.join(root, 'linked'), 'junction')
    for (const file of ['../other/file.ets', '.git/config', 'linked/file.ets']) await assert.rejects(reviewSourcePaths(root, alias, trace(file)))
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('binary signing material is inspectable but does not claim signing passed', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'review-sign-'))
  try {
    await writeFile(path.join(temp, 'debug.p7b'), Buffer.from([0, 255, 12, 18]))
    const result = await readSigningMetadata(temp, 'debug.p7b')
    assert.match(result.sha256, /^[a-f0-9]{64}$/)
    assert.equal(result.nextOffset, null)
    assert.equal(JSON.parse(result.text).signatureVerified, false)
    await assert.rejects(readSigningMetadata(temp, 'code.ets'))
  } finally { await rm(temp, { recursive: true, force: true }) }
})
