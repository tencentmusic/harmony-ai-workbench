import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { git } from './git'
import { snapshotCommit } from './delivery-git'
import { documentPrefix, archiveReviewDraft, prepareBranchDocuments } from './branch-documents'
import { sha256 } from './scoped-files'
import type { HarnessWorkspace } from './harness'

test('branch document paths are task scoped and cannot select source/config directories', () => {
  assert.equal(documentPrefix('docs/migrations', 'Live', 'task-1'), 'docs/migrations/Live/task-1')
  for (const root of ['../app', 'app', 'docs/../app', 'docs/.git', 'docs/a\\b', 'docs/con']) assert.throws(() => documentPrefix(root, 'Live', 'task-1'))
  assert.throws(() => documentPrefix('docs/migrations', '../Live', 'task'))
})

test('portable docs enter the same delivery snapshot without touching verified worktree or index', { timeout: 120000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cloud-branch-docs-'))
  const root = path.join(temp, 'repo'), artifacts = path.join(temp, '.runtime'), runDir = path.join(artifacts, 'harness')
  const signal = AbortSignal.timeout(120000)
  try {
    await mkdir(root); await mkdir(runDir, { recursive: true })
    await git(root, ['init', '-b', 'feature/test'])
    await git(root, ['config', 'user.name', 'test']); await git(root, ['config', 'user.email', 'test@localhost'])
    await mkdir(path.join(root, 'app')); await writeFile(path.join(root, 'app/a.ts'), 'old')
    await git(root, ['add', '.']); await git(root, ['commit', '-m', 'fixture'])
    const base = await git(root, ['rev-parse', 'HEAD']), index = await git(root, ['write-tree'])
    await writeFile(path.join(root, 'app/a.ts'), 'new')
    const workspace: HarnessWorkspace = { identity: 'task-1', artifactRoot: artifacts, runDir, harmonyRoot: root, androidRoot: root,
      branch: 'feature/test', baseSha: base, harmonyPrefixes: ['app'], androidPrefixes: ['app'], title: '测试', appId: 'Live', profile: '', materialVersion: 2 }
    await archiveReviewDraft(workspace, { kind: 'scope', digest: 'a'.repeat(64), materialVersion: 2, content: '## 待审核\n\n测试', decision: 'approved', files: [] })
    const documents = []
    await writeFile(path.join(artifacts, 'cover.png'), Buffer.from([137, 80, 78, 71]))
    for (const role of ['scope', 'requirements', 'technical-plan', 'acceptance-report']) {
      const text = `# ${role}\n\n![封面](cover.png)\n\n[录屏](demo.mp4)\n\n工作区：${root}\n`
      const file = path.join(artifacts, `${role}.md`)
      await writeFile(file, text); documents.push({ role, path: file, sha256: sha256(text) })
    }
    await writeFile(path.join(runDir, 'verification-report.json'), JSON.stringify({ delivery: { documents },
      image: { path: path.join(artifacts, 'cover.png'), sha256: sha256(Buffer.from([137, 80, 78, 71])) },
      evidence: { path: path.join(artifacts, 'demo.mp4'), sha256: 'e'.repeat(64) } }))
    await mkdir(path.join(artifacts, 'approvals/old'), { recursive: true })
    await writeFile(path.join(artifacts, 'approvals/old/human.txt'), JSON.stringify({ reference: 'old-record', kind: 'scope', decision: 'approved', digest: 'f'.repeat(64), reason: '历史记录' }))
    const presentation = `# Historical review\n\n![Original](<${path.join(artifacts, 'cover.png')}>)\n`
    await writeFile(path.join(artifacts, 'approvals/old/presented.md'), presentation)
    await mkdir(path.join(artifacts, 'approvals/acceptance-evidence'), { recursive: true })
    await writeFile(path.join(artifacts, 'approvals/acceptance-evidence/human.json'), JSON.stringify({ quote: 'External human evidence, not a workbench approval record' }))
    const overlay = await prepareBranchDocuments(workspace)
    assert.equal(overlay.prefix, 'docs/migrations/Live/task-1')
    const reviewed = overlay.files.find(file => file.name === `reviewed-${sha256(presentation)}.md`)!
    assert.match(await readFile(reviewed.source, 'utf8'), /assets\/[a-f0-9]{64}\.png/)
    const before = await git(root, ['status', '--porcelain'])
    const snapshot = await snapshotCommit(root, base, ['app'], artifacts, 'test docs', signal, base, overlay)
    assert.notEqual(snapshot.tree, snapshot.codeTree)
    assert.equal(await git(root, ['rev-parse', 'HEAD']), base)
    assert.equal(await git(root, ['write-tree']), index)
    assert.equal(await git(root, ['status', '--porcelain']), before)
    const content = await git(root, ['show', `${snapshot.sha}:${overlay.prefix}/requirements.md`])
    assert.ok(content.includes('assets/')); assert.ok(!content.includes(temp))
    assert.ok(!overlay.files.some(file => file.name.endsWith('.mp4')))
    assert.ok((await git(root, ['show', `${snapshot.sha}:${overlay.prefix}/evidence.md`])).includes('SHA256：' + 'e'.repeat(64)))
    assert.ok((await git(root, ['show', `${snapshot.sha}:${overlay.prefix}/review-record.md`])).includes('历史或未应用记录，不作为当前门禁批准'))
    assert.ok((await git(root, ['show', `${snapshot.sha}:${overlay.prefix}/README.md`])).includes('requirements.md'))
    assert.equal((await snapshotCommit(root, base, ['app'], artifacts, 'retry', signal, base, await prepareBranchDocuments(workspace))).tree, snapshot.tree)
    const nested = await snapshotCommit(path.join(root, 'app'), base, [''], artifacts, 'nested source root', signal, base, overlay)
    assert.ok((await git(root, ['show', `${nested.sha}:app/${overlay.prefix}/requirements.md`])).includes('assets/'))
    const first = overlay.files[0]
    await writeFile(first.source, (await readFile(first.source, 'utf8')) + 'tampered')
    await assert.rejects(snapshotCommit(root, base, ['app'], artifacts, 'bad', signal, base, overlay), /文档/)
    await assert.rejects(snapshotCommit(root, base, ['app'], artifacts, 'bad', signal, base, { ...overlay, prefix: 'app' }), /文档/)
    await writeFile(path.join(artifacts, 'approvals/old/presented.md'), `![Outside](<${path.join(temp, 'outside.png')}>)`)
    await writeFile(path.join(temp, 'outside.png'), 'not allowed')
    await assert.rejects(prepareBranchDocuments(workspace), /范围/)
    await writeFile(path.join(artifacts, 'approvals/old/presented.md'), presentation)
    await writeFile(path.join(artifacts, 'cover.png'), 'changed evidence')
    await assert.rejects(prepareBranchDocuments(workspace), /摘要/)
    await writeFile(path.join(artifacts, 'cover.png'), Buffer.from([137, 80, 78, 71]))
    await writeFile(path.join(artifacts, 'approvals/acceptance-evidence/human.txt'), '{invalid')
    await assert.rejects(prepareBranchDocuments(workspace), SyntaxError)
  } finally { await rm(temp, { recursive: true, force: true }) }
})
