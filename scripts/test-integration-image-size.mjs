import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { collectIntegrationImageSizes } from '../src/server/modules/integration/integration-git.ts'
import { finalizePreparedIntegrationArtifact } from '../src/server/modules/integration/integration-opencode.ts'

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'integration-image-size-')))
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
try {
  git('init'); git('config', 'user.email', 'integration@example.invalid'); git('config', 'user.name', 'Test')
  mkdirSync(path.join(root, 'images'))
  writeFileSync(path.join(root, 'images/unchanged.png'), Buffer.alloc(20000))
  writeFileSync(path.join(root, 'images/deleted.png'), Buffer.alloc(20000))
  writeFileSync(path.join(root, 'images/shrunk.png'), Buffer.alloc(20000))
  writeFileSync(path.join(root, 'images/moved.png'), Buffer.alloc(20000, 1))
  git('add', '.'); git('commit', '-qm', 'base')
  const baseSha = git('rev-parse', 'HEAD')
  writeFileSync(path.join(root, 'images/exact.png'), Buffer.alloc(10240))
  writeFileSync(path.join(root, 'images/large.PNG'), Buffer.alloc(10241))
  writeFileSync(path.join(root, 'images/large vector.svg'), 'x'.repeat(10241))
  writeFileSync(path.join(root, 'outside.webp'), Buffer.alloc(10241))
  writeFileSync(path.join(root, 'images/shrunk.png'), Buffer.alloc(10000))
  writeFileSync(path.join(root, 'images/player.har'), Buffer.alloc(20000))
  const special = process.platform === 'win32'
    ? 'images/evil`[b](x)&.png'
    : 'images/evil`<b>\n.png'
  writeFileSync(path.join(root, special), Buffer.alloc(10241))
  if (process.platform !== 'win32') {
    symlinkSync('unchanged.png', path.join(root, 'images/link.png'))
  }
  git('rm', 'images/deleted.png'); git('mv', 'images/moved.png', 'images/renamed.png')
  git('add', '.'); git('commit', '-qm', 'images changed')
  const headSha = git('rev-parse', 'HEAD')
  // Checks must use committed sizes, even if working files are later modified.
  writeFileSync(path.join(root, 'images/large.PNG'), Buffer.alloc(1))
  const findings = await collectIntegrationImageSizes({ repoRoot: root, baseSha, headSha, scopePath: 'images' })
  assert.equal(findings.find(f => f.path === 'images/exact.png')?.byteLength, 10240,
    'review input must include exact sizes for images that do not exceed the limit')
  assert.deepEqual(findings.map(f => f.path).sort(), [special, 'images/large.PNG', 'images/large vector.svg', 'images/renamed.png', 'images/exact.png', 'images/shrunk.png'].sort())
  assert.equal(findings.find(f => f.path === 'images/large.PNG').byteLength, 10241)
  assert.ok(findings.every(f => /^[a-f0-9]{40}$/.test(f.blobId)))
  assert.equal((await collectIntegrationImageSizes({ repoRoot: root, baseSha, headSha })).length, 7)
  assert.deepEqual(await collectIntegrationImageSizes({ repoRoot: root, baseSha: headSha, headSha }), [])
  for (const type of ['initial_review', 'final_review', 'test_cases']) {
    const result = await finalizePreparedIntegrationArtifact({
      prepared: { directory: root, skills: { test: { digest: 'pinned' } } },
      artifact: { type, expectedSkillName: 'test', reportRelativePath: 'report.md' },
      sessionResult: { sessionId: 'session', execution: { status: 'succeeded', promptState: 'accepted', expectedSkillCompleted: true, reportContent: '# 审查与测试用例\n\n暂无问题' }, cleanup: { status: 'safe', abortAttempted: false } },
      frozenDiffHash: 'frozen', imageSizes: findings,
    })
    assert.equal(result.artifact.status, 'succeeded')
    assert.match(result.artifact.content, /^## 系统图片资源审查：存在 P1 严重问题/)
    assert.match(result.artifact.content, /10241 字节/)
    assert.match(result.artifact.content, /\*\*未超限\*\*：`"images\/exact.png"`，10240 字节/)
    assert.match(result.artifact.content, /\*\*未超限\*\*：`"images\/shrunk.png"`，10000 字节/)
    assert.doesNotMatch(result.artifact.content, /<b>/)
    if (process.platform === 'win32') {
      assert.match(result.artifact.content, /evil\\u0060\[b\]\(x\)\\u0026/)
    }
    assert.ok(result.artifact.content.indexOf('P1 严重') < result.artifact.content.indexOf('暂无问题'))
  }
  // Passing checks must remain visible even when the model omits image sizes.
  for (const imageSizes of [findings.filter(f => f.byteLength <= 10240), []]) {
    const result = await finalizePreparedIntegrationArtifact({
      prepared: { directory: root, skills: { test: { digest: 'pinned' } } },
      artifact: { type: 'final_review', expectedSkillName: 'test', reportRelativePath: 'report.md' },
      sessionResult: { sessionId: 'session', execution: { status: 'succeeded', promptState: 'accepted', expectedSkillCompleted: true, reportContent: '# 合入代码审查\n\n暂无问题' }, cleanup: { status: 'safe', abortAttempted: false } },
      frozenDiffHash: 'frozen', imageSizes,
    })
    assert.equal(result.artifact.status, 'succeeded')
    assert.match(result.artifact.content, imageSizes.length ? /^## 系统图片资源审查：全部未超限/ : /^## 系统图片资源审查：无待检查图片/)
    assert.doesNotMatch(result.artifact.content, /\[P1 严重\]/)
    if (imageSizes.length) assert.match(result.artifact.content, /10240 字节/)
  }
  console.log('PASS: all image sizes, frozen sizes, scope, rename/delete, passing checks and mandatory P1 findings')
} finally { rmSync(root, { recursive: true, force: true }) }
