import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import JSZip from 'jszip'
import { listArtifacts, readSourceArchive } from './evidence-discovery'

test('artifact directory discovery returns scoped relative paths and does not follow links', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-list-'))
  try {
    await mkdir(path.join(root, 'harness')); await mkdir(path.join(root, 'outside'))
    await writeFile(path.join(root, 'harness', 'manifest.json'), '{}')
    await symlink(path.join(root, 'outside'), path.join(root, 'harness', 'linked'), 'junction')
    assert.deepEqual((await listArtifacts(root, 'harness', 0)).entries.map(e => e.path), ['harness/manifest.json'])
    await assert.rejects(listArtifacts(root, '../', 0))
    await assert.rejects(listArtifacts(root, 'harness/linked', 0))
    await assert.rejects(listArtifacts(root, '', -1))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('HAR discovery reads bounded text without extraction or binary/link access', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archive-read-'))
  const signal = new AbortController().signal
  try {
    const zip = new JSZip()
    zip.file('package/Index.d.ets', 'export declare class Player {}\n'.repeat(1000))
    zip.file('package/player.so', Buffer.from([0, 255, 1]))
    zip.file('package/link.d.ets', '/outside', { unixPermissions: 0o120777 })
    await writeFile(path.join(root, 'player.har'), await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }))
    const listing = await readSourceArchive(root, 'player.har', undefined, 0, signal)
    assert.ok(listing.entries?.includes('package/Index.d.ets'))
    assert.ok(!listing.entries?.includes('package/link.d.ets'))
    const first = await readSourceArchive(root, 'player.har', 'package/Index.d.ets', 0, signal)
    assert.equal(first.nextOffset, 24000)
    const last = await readSourceArchive(root, 'player.har', 'package/Index.d.ets', 24000, signal)
    assert.equal(last.nextOffset, null)
    assert.match(first.archiveSha256, /^[a-f0-9]{64}$/)
    for (const entry of ['../Index.d.ets', 'package/link.d.ets', 'package/player.so', '/abs.d.ets']) await assert.rejects(readSourceArchive(root, 'player.har', entry, 0, signal))
    await assert.rejects(readSourceArchive(root, '../player.har', undefined, 0, signal))
  } finally { await rm(root, { recursive: true, force: true }) }
})
