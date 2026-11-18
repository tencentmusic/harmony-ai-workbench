import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes, access, symlink } from 'node:fs/promises'
import { previewArtifactStorage, archiveArtifactStorage, restoreArtifactStorage, listArtifactArchives } from './artifact-storage'
import { sha256 } from './scoped-files'

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-retention-'))
  const artifactRoot = path.join(root, 'artifacts'), archiveRoot = path.join(root, 'artifact-archive')
  const input = { artifactRoot, archiveRoot, identity: 'synthetic', context: '{}', minimumAgeMs: 86400000 }
  await mkdir(path.join(artifactRoot, 'harness'), { recursive: true })
  const put = async (file: string, bytes: string | Buffer, old = true) => {
    await mkdir(path.dirname(path.join(artifactRoot, file)), { recursive: true })
    await writeFile(path.join(artifactRoot, file), bytes)
    if (old) await utimes(path.join(artifactRoot, file), new Date(0), new Date(0))
  }
  await put('harness/harness-events.jsonl', JSON.stringify({ command: 'run-build', operation_id: 'build-old', status: 'committed' }))
  return { input, root, put, clean: () => rm(root, { recursive: true, force: true }) }
}

test('preview protects all referenced evidence, unsettled builds, recent backups and non-whitelisted files', async () => {
  const f = await fixture()
  try {
    await f.put('execution/build-old/previous-0.hsp', 'old unreferenced')
    await f.put('execution/build-old/previous-1.hsp', 'referenced')
    await f.put('execution/build-old/previous-2.hsp', 'recent', false)
    await f.put('execution/build-unknown/previous-0.hsp', 'unknown')
    await f.put('execution/build-old/dependency-0.hsp', 'keep')
    await f.put('harness/original.json', JSON.stringify({ evidence: { path: path.join(f.input.artifactRoot, 'execution/build-old/previous-1.hsp') } }))
    const plan = await previewArtifactStorage(f.input)
    assert.deepEqual(plan.candidates.map(file => file.path), ['execution/build-old/previous-0.hsp'])
    assert.equal(plan.protectedBackupCount, 3)
    assert.equal(plan.fileCount, 7)
    assert.equal(plan.candidates[0].reason, 'settled_unreferenced_build_backup')
    await assert.rejects(access(f.input.archiveRoot))
    const dbPinned = await previewArtifactStorage({ ...f.input, context: JSON.stringify({ history: 'execution/build-old/previous-0.hsp' }) })
    assert.equal(dbPinned.candidates.length, 0)
  } finally { await f.clean() }
})

test('archive deduplicates against retained packages, compresses unique bytes and restores original paths', async () => {
  const f = await fixture()
  try {
    await f.put('execution/build-old/previous-0.hsp', 'duplicate bytes')
    await f.put('execution/build-old/dependency-0.hsp', 'duplicate bytes')
    await f.put('execution/build-old/previous-1.hsp', 'unique bytes '.repeat(1000))
    const plan = await previewArtifactStorage(f.input)
    assert.equal(plan.duplicateBytes, Buffer.byteLength('duplicate bytes'))
    const archived = await archiveArtifactStorage(f.input, plan.digest, new AbortController().signal)
    assert.equal(archived.files, 2)
    assert.ok(archived.reclaimedBytes > 10000)
    await assert.rejects(access(path.join(f.input.artifactRoot, 'execution/build-old/previous-0.hsp')))
    assert.equal(await readFile(path.join(f.input.artifactRoot, 'execution/build-old/dependency-0.hsp'), 'utf8'), 'duplicate bytes')
    const restored = await restoreArtifactStorage(f.input, archived.archiveId!, new AbortController().signal)
    assert.equal(restored.restored, 2)
    assert.equal(await readFile(path.join(f.input.artifactRoot, 'execution/build-old/previous-1.hsp'), 'utf8'), 'unique bytes '.repeat(1000))
    assert.equal((await restoreArtifactStorage(f.input, archived.archiveId!, new AbortController().signal)).restored, 0)
    await f.put('execution/build-old/previous-0.hsp', 'external edit')
    await assert.rejects(restoreArtifactStorage(f.input, archived.archiveId!, new AbortController().signal), /覆盖/)
  } finally { await f.clean() }
})

test('stale preview, new references, invalid metadata and cancellation never remove a backup', async () => {
  const f = await fixture()
  try {
    await f.put('execution/build-old/previous-0.hsp', 'original')
    const plan = await previewArtifactStorage(f.input)
    await f.put('harness/pin.json', JSON.stringify({ path: 'execution/build-old/previous-0.hsp' }))
    await assert.rejects(archiveArtifactStorage(f.input, plan.digest, new AbortController().signal), /变化/)
    await f.put('harness/pin.json', '{')
    await assert.rejects(previewArtifactStorage(f.input), /解析/)
    await f.put('harness/pin.json', '{}')
    const next = await previewArtifactStorage(f.input)
    await assert.rejects(archiveArtifactStorage(f.input, next.digest, AbortSignal.abort()))
    assert.equal(await readFile(path.join(f.input.artifactRoot, 'execution/build-old/previous-0.hsp'), 'utf8'), 'original')
  } finally { await f.clean() }
})

test('restore rejects changed recovery sources, cross-task identity and invalid archive paths', async () => {
  const f = await fixture()
  try {
    await f.put('execution/build-old/previous-0.hsp', 'same')
    await f.put('execution/build-old/dependency-0.hsp', 'same')
    const plan = await previewArtifactStorage(f.input)
    const archived = await archiveArtifactStorage(f.input, plan.digest, new AbortController().signal)
    await f.put('execution/build-old/dependency-0.hsp', 'changed')
    await assert.rejects(restoreArtifactStorage(f.input, archived.archiveId!, new AbortController().signal), /摘要/)
    await assert.rejects(restoreArtifactStorage({ ...f.input, identity: 'other-task' }, archived.archiveId!, new AbortController().signal), /身份/)
    await assert.rejects(restoreArtifactStorage(f.input, '../escape', new AbortController().signal), /编号/)
    const file = path.join(f.input.archiveRoot, `${archived.archiveId}.json`)
    const manifest = JSON.parse(await readFile(file, 'utf8'))
    manifest.entries[0].path = '../escape.hsp'
    await writeFile(file, JSON.stringify(manifest))
    await assert.rejects(restoreArtifactStorage(f.input, archived.archiveId!, new AbortController().signal), /路径/)
  } finally { await f.clean() }
})

test('links are refused and archives restore original bytes', async () => {
  const f = await fixture()
  try {
    await f.put('execution/build-old/previous-0.hsp', 'synthetic')
    await symlink(f.input.artifactRoot, path.join(f.input.artifactRoot, 'external'), 'junction')
    await assert.rejects(previewArtifactStorage(f.input), /链接/)
    await rm(path.join(f.input.artifactRoot, 'external'))
    const plan = await previewArtifactStorage(f.input)
    const result = await archiveArtifactStorage(f.input, plan.digest, new AbortController().signal)
    assert.equal((await restoreArtifactStorage(f.input, result.archiveId!, new AbortController().signal)).restored, 1)
    assert.equal(sha256(await readFile(path.join(f.input.artifactRoot, 'execution/build-old/previous-0.hsp'))), sha256('synthetic'))
  } finally { await f.clean() }
})

test('interrupted removal leaves a complete recovery manifest for the processed subset', async () => {
  const f = await fixture()
  try {
    await f.put('execution/build-old/previous-0.hsp', 'first')
    await f.put('execution/build-old/previous-1.hsp', 'second')
    const plan = await previewArtifactStorage(f.input)
    let guards = 0
    await assert.rejects(archiveArtifactStorage(f.input, plan.digest, new AbortController().signal, async () => {
      if (++guards === 4) throw new Error('simulated interruption')
    }), /simulated interruption/)
    await assert.rejects(access(path.join(f.input.artifactRoot, 'execution/build-old/previous-0.hsp')))
    assert.equal(await readFile(path.join(f.input.artifactRoot, 'execution/build-old/previous-1.hsp'), 'utf8'), 'second')
    const archives = await listArtifactArchives(f.input)
    assert.equal(archives.length, 1)
    assert.equal(archives[0].files, 2)
    assert.equal((await restoreArtifactStorage(f.input, archives[0].id, new AbortController().signal)).restored, 1)
    assert.equal(await readFile(path.join(f.input.artifactRoot, 'execution/build-old/previous-0.hsp'), 'utf8'), 'first')
  } finally { await f.clean() }
})

test('corrupt compressed recovery data is rejected before restoring any files', async () => {
  const f = await fixture()
  try {
    await f.put('execution/build-old/previous-0.hsp', 'first')
    await f.put('execution/build-old/previous-1.hsp', 'second')
    const plan = await previewArtifactStorage(f.input)
    const result = await archiveArtifactStorage(f.input, plan.digest, new AbortController().signal)
    await writeFile(path.join(f.input.archiveRoot, `objects/${sha256('second')}.gz`), 'corrupt')
    await assert.rejects(restoreArtifactStorage(f.input, result.archiveId!, new AbortController().signal))
    await assert.rejects(access(path.join(f.input.artifactRoot, 'execution/build-old/previous-0.hsp')))
    await assert.rejects(access(path.join(f.input.artifactRoot, 'execution/build-old/previous-1.hsp')))
  } finally { await f.clean() }
})

test('basename references in prose protect backups and preview honors cancellation', async () => {
  const f = await fixture()
  try {
    await f.put('execution/build-old/previous-0.hsp', 'original')
    await f.put('harness/readme.md', 'Recover from `previous-0.hsp` in the build directory.')
    assert.equal((await previewArtifactStorage(f.input)).candidates.length, 0)
    await assert.rejects(previewArtifactStorage(f.input, AbortSignal.abort()))
  } finally { await f.clean() }
})
