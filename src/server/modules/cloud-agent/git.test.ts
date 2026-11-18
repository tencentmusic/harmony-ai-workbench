import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { inScope, sourcePrefixes, sourceRelativePath, collectCode, git, repositoryIssue, repositoryIdentity, gitFailureReason } from './git'

test('source preflight accepts tracked source subdirectories and worktrees, rejects empty or untracked children', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-repository-test-'))
  try {
    assert.match(await repositoryIssue(path.join(root, 'missing')) || '', /不存在/)
    assert.match(await repositoryIssue(root) || '', /为空/)
    execFileSync('git', ['-C', root, 'init'], { stdio: 'pipe' })
    assert.equal(await repositoryIssue(root), null)
    await writeFile(path.join(root, 'README.md'), 'fixture')
    execFileSync('git', ['-C', root, 'add', '.'], { stdio: 'pipe' })
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { stdio: 'pipe' })
    const child = path.join(root, 'child')
    await mkdir(child)
    await writeFile(path.join(child, 'file.txt'), 'not a repository')
    assert.match(await repositoryIssue(child) || '', /不是 Git 仓库/)
    execFileSync('git', ['-C', root, 'add', 'child'], { stdio: 'pipe' })
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'tracked source'], { stdio: 'pipe' })
    assert.equal(await repositoryIssue(child), null)
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://git.example/fixture/repo.git'], { stdio: 'pipe' })
    assert.equal((await repositoryIdentity(child)).sourcePrefix, 'child/')
    await rm(path.join(child, 'file.txt'))
    assert.match(await repositoryIssue(child) || '', /为空/)
    await writeFile(path.join(child, '.git'), `gitdir: ${path.join(root, '.git')}`)
    assert.equal(await repositoryIssue(child), null, '.git files used by worktrees are accepted')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Git failures are actionable without leaking upstream URLs or credentials', () => {
  const secret = 'secret-token-not-for-ui'
  const cases = [
    [{ stderr: `fatal: not a git repository; ${secret}` }, /不是 Git 仓库/],
    [{ stderr: `fatal: No such remote 'origin'; ${secret}` }, /origin/],
    [{ stderr: `fatal: Authentication failed for https://user:${secret}@example.invalid/repo` }, /认证失败/],
    [{ stderr: 'fatal: unable to access remote: The requested URL returned error: 403' }, /认证失败/],
    [{ stderr: 'Updating files: 50% (403/806)\nerror: Filename too long' }, /路径过长/],
    [{ stderr: 'Updating files: 50% (403/806)\nfatal: unknown checkout error' }, /执行失败/],
    [{ stderr: `fatal: Could not read from remote repository; ${secret}` }, /访问失败/],
    [{ stderr: `fatal: couldn't find remote ref refs/heads/missing; ${secret}` }, /分支或提交不存在/],
    [{ stderr: `Could not resolve host; ${secret}` }, /网络连接失败/],
    [{ killed: true, signal: 'SIGTERM', stderr: secret }, /超时/],
    [{ code: 'ENOENT', stderr: secret }, /未找到 Git/],
    [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stderr: secret }, /输出超过/],
    [{ stderr: secret }, /执行失败/],
  ] as const
  for (const [error, expected] of cases) {
    const message = gitFailureReason(error)
    assert.match(message, expected)
    assert.ok(!message.includes(secret))
  }
})

test('task Git commands check out deep paths without changing global Git settings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-long-path-'))
  try {
    const repo = path.join(root, 'repo'), target = path.join(root, 'task-worktree')
    await mkdir(repo)
    await git(repo, ['init'])
    const relative = `${'nested-package/'.repeat(20)}Entry.java`
    await mkdir(path.dirname(path.join(repo, relative)), { recursive: true })
    await writeFile(path.join(repo, relative), 'class Entry {}')
    await git(repo, ['add', '.'])
    await git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'long path fixture'])
    await git(repo, ['worktree', 'add', '--detach', target, 'HEAD'])
    assert.equal(await repositoryIssue(target), null)
    assert.equal(await git(target, ['status', '--porcelain']), '')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('monorepo prefixes and whole-repo scope preserve nested-repository boundaries', () => {
  assert.equal(sourceRelativePath('android/profile/Page.java', 'android/'), 'profile/Page.java')
  assert.equal(sourceRelativePath('android2/profile/Page.java', 'android/'), null)
  assert.deepEqual(sourcePrefixes(['fanxing/profile', 'feature'], 'fanxing'), ['profile'])
  assert.deepEqual(sourcePrefixes(['fanxing'], 'fanxing'), [''])
  assert.deepEqual(sourcePrefixes([''], 'fanxing'), [''])
  assert.equal(inScope('profile/MainPage.ets', ['profile']), true)
  for (const file of ['profile2/MainPage.ets', '../profile/MainPage.ets', 'profile/.env', 'profile/../../secret', 'profile\\file']) assert.equal(inScope(file, ['profile']), false)
  assert.equal(inScope('entry/MainPage.ets', ['']), true)
  assert.equal(inScope('.git/config', ['']), false)
  assert.equal(inScope('profile/MainPage.ets', []), false)
})

test('code evidence comes from frozen commit, excludes out-of-scope and uncommitted content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-git-test-'))
  const run = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=NUL', ...args], { encoding: 'utf8', windowsHide: true }).trim()
  try {
    run('init')
    await mkdir(path.join(root, 'profile'))
    await mkdir(path.join(root, 'other'))
    await writeFile(path.join(root, 'profile', 'ProfileActivity.java'), 'class ProfileActivity { /* pinned */ }')
    await writeFile(path.join(root, 'other', 'ProfileActivity.java'), 'private other App')
    run('add', '.')
    run('-c', 'user.email=cloud-test@example.invalid', '-c', 'user.name=Cloud Test', 'commit', '-m', 'fixture')
    const sha = run('rev-parse', 'HEAD')
    await writeFile(path.join(root, 'profile', 'ProfileActivity.java'), 'uncommitted user edit')
    const evidence = await collectCode({ cache: root, sha }, ['profile'], 'ProfileActivity')
    assert.equal(evidence.length, 1)
    assert.match(evidence[0], /pinned/)
    assert.doesNotMatch(evidence[0], /uncommitted|private other/)
    assert.match(await git(root, ['status', '--porcelain']), /ProfileActivity/)
    const subdirectoryEvidence = await collectCode({ cache: root, sha, identity: { sourcePrefix: 'profile/' } }, [''], 'ProfileActivity')
    assert.equal(subdirectoryEvidence.length, 1)
    assert.match(subdirectoryEvidence[0], /profile\/ProfileActivity.java.*\nclass ProfileActivity/)
    assert.doesNotMatch(subdirectoryEvidence[0], /uncommitted|private other/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
