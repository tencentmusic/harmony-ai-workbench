import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { bundleKnowledgeDocuments } from './knowledge-bundle'
import { sha256 } from './scoped-files'

test('knowledge publication bundles hash-bound media, rewrites links and refuses escaped paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-publication-'))
  try {
    const artifacts = path.join(root, 'artifacts'), output = path.join(root, 'published')
    await mkdir(artifacts)
    await writeFile(path.join(artifacts, 'capture.png'), 'synthetic-image-bytes')
    const docs = []
    for (const role of ['scope', 'requirements', 'technical-plan', 'acceptance-report']) {
      const file = path.join(artifacts, `${role}.md`), content = `# ${role}\n![capture](capture.png)\n[Scope](scope.md)`
      await writeFile(file, content)
      docs.push({ role, path: file, sha256: sha256(content) })
    }
    const result = await bundleKnowledgeDocuments(artifacts, docs, output, {})
    assert.equal(result.assets.length, 1)
    assert.match(await readFile(path.join(output, 'scope.md'), 'utf8'), /assets\/[a-f0-9]{64}\.png/)
    await bundleKnowledgeDocuments(artifacts, docs, output, {})
    const capture = path.join(artifacts, 'capture.png')
    await assert.rejects(bundleKnowledgeDocuments(artifacts, docs, path.join(root, 'mismatch'), [{ path: capture, sha256: sha256('synthetic-image-bytes') }, { path: capture, sha256: 'a'.repeat(64) }]), /不一致/)
    await assert.rejects(bundleKnowledgeDocuments(artifacts, [...docs.slice(0, 3), { ...docs[3], role: 'technical_plan' }], path.join(root, 'duplicate-role'), {}), /四份/)
    const escaped = '# scope\n![secret](../outside.png)'
    await writeFile(path.join(root, 'outside.png'), 'private')
    await writeFile(docs[0].path, escaped)
    docs[0].sha256 = sha256(escaped)
    await assert.rejects(bundleKnowledgeDocuments(artifacts, docs, path.join(root, 'escape'), {}), /范围/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
