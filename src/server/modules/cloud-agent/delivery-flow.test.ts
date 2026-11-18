import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import type { HarnessWorkspace } from './harness'
import type { DeliveryMR } from './delivery-git'

const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-delivery-flow-'))
process.env.DATABASE_URL = `file:${path.join(root, 'test.db')}`
process.env.CLOUD_AGENT_RUNTIME_ROOT = path.join(root, 'runtime')
for (const name of Object.keys(process.env)) if (/^CLOUD_AGENT_GITLAB.*TOKEN$/.test(name)) delete process.env[name]
Object.assign(process.env, { CLOUD_AGENT_WECOM_WEBHOOK: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic', CLOUD_AGENT_WECOM_DEFAULT_USER: 'fixture', CLOUD_AGENT_WECOM_USERS: '{}', CLOUD_AGENT_PUBLIC_URL: 'http://192.168.1.10:3100' })
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { env: { ...process.env, RUST_LOG: 'info' }, stdio: 'pipe' })
const { prisma } = await import('@/lib/prisma')
const { runDelivery } = await import('./delivery')
const { git } = await import('./git')
const { cloudProject } = await import('./config')
const { executionConfig } = await import('./execution-config')
const { pushSnapshot } = await import('./delivery-git')
const { claimCloudRun, decideCloudTask } = await import('./store')
const { queueAutomaticDelivery, deferDeliveryRun } = await import('./delivery-automation')
const { findMergedReceipt, verifyHandoffSource } = await import('./delivery-ssh')
const { withMergeProof } = await import('./merge-proof')
const { receiveCloudWebhook } = await import('./webhook')
const { collectCloudNotifications, dispatchCloudNotification } = await import('./notifications')
const { projectHarnessStatus } = await import('./harness-domain')
const { CloudTransientError } = await import('./domain')
const { sha256 } = await import('./scoped-files')
const { deviceConclusion } = await import('./device-conclusion')
const { loadWorkspaceAppsConfig, resolveKnowledgeBase } = await import('@/lib/workspace-apps-config')
after(async () => { await prisma.$disconnect(); await rm(root, { recursive: true, force: true }) })

test('isolated delivery lifecycle: native gate -> handoff -> authenticated merge + Git -> wiki MR -> knowledge merge, without tokens', async () => {
  const signal = AbortSignal.timeout(180000), appId = 'KugouLive', identity = 'synthetic-delivery'
  const code = path.join(root, 'code'), wiki = path.join(root, 'wiki'), codeRemote = path.join(root, 'code.git'), wikiRemote = path.join(root, 'wiki.git'), artifacts = path.join(root, 'artifacts')
  for (const dir of [code, wiki, codeRemote, wikiRemote, artifacts]) await mkdir(dir)
  const initialize = async (dir: string, branch: string, remote: string) => {
    await git(dir, ['init', '-b', branch]); await git(dir, ['config', 'user.name', 'fixture']); await git(dir, ['config', 'user.email', 'fixture@localhost'])
    await writeFile(path.join(dir, '.gitignore'), '.wiki-tmp/\n'); await writeFile(path.join(dir, 'page.txt'), 'before')
    await git(dir, ['add', '.']); await git(dir, ['commit', '-m', 'fixture'])
    await git(remote, ['init', '--bare']); await git(dir, ['push', remote, branch])
    return git(dir, ['rev-parse', 'HEAD'])
  }
  const base = await initialize(code, 'kan-fx-release', codeRemote), wikiBase = await initialize(wiki, 'master', wikiRemote)
  await git(code, ['checkout', '-b', 'feature/fixture'])
  await writeFile(path.join(code, 'debug-profile.json'), '{"fixture":true}')
  await git(code, ['add', '.']); await git(code, ['commit', '-m', 'registered signing commit'])
  const registeredHead = await git(code, ['rev-parse', 'HEAD'])
  await writeFile(path.join(code, 'page.txt'), 'accepted implementation')
  const runDir = path.join(artifacts, 'harness'), docRoot = path.join(artifacts, 'branch-documents')
  await mkdir(runDir); await mkdir(docRoot)
  const files: { name: string; source: string; sha256: string }[] = []
  for (const name of ['requirements.md', 'implementation.md', 'acceptance.md', 'summary.md']) {
    const source = path.join(docRoot, name), content = `# Synthetic ${name}\nThis is a fixture, not real acceptance.\n`
    await writeFile(source, content); files.push({ name, source, sha256: sha256(content) })
  }
  const documents = files.map((file, index) => ({ role: `fixture-${index}`, path: file.source, sha256: file.sha256 }))
  await writeFile(path.join(runDir, 'verification-report.json'), JSON.stringify({ delivery: { documents } }))
  const workspace: HarnessWorkspace = { identity, artifactRoot: artifacts, runDir, androidRoot: code, androidSha: base, harmonyRoot: code, branch: 'feature/fixture', baseSha: base, harmonyHeadSha: registeredHead, androidPrefixes: [''], harmonyPrefixes: [''], appId, title: 'synthetic flow', profile: '', continuous: true, materialVersion: 1, documentsPath: 'docs/migrations' }
  const task = await prisma.cloudAgentTask.create({ data: { appId, title: workspace.title, material: 'synthetic', source: 'android-mr', originKey: 'synthetic-origin', targetBranch: 'kan-fx-release', status: 'delivery_ready', harnessJson: JSON.stringify({ workspace, status: { phase: 'delivery_ready' } }) } })
  const repoIdentity = (dir: string) => ({ origin: 'https://git.example', repository: dir === code ? 'team/code' : 'team/wiki', remote: dir === code ? codeRemote : wikiRemote, sourcePrefix: '' })
  let verified = false, ingests = 0, knowledgeMRs = 0
  const adapters: NonNullable<Parameters<typeof runDelivery>[3]> = {
    cloudProject: () => ({ ...cloudProject(appId), harmonyRoot: code, mrTrigger: true }),
    executionConfig: () => executionConfig(appId), repositoryIdentity: async dir => repoIdentity(dir),
    requireCodeReview: async () => {}, verifyHarness: async () => ({ raw: { verified }, status: projectHarnessStatus({ verified, phase: 'delivery_ready' }) }),
    prepareBranchDocuments: async () => ({ prefix: `docs/migrations/${appId}/${identity}`, appId, identity, files }),
    resolveKnowledgeBase: () => ({ ...resolveKnowledgeBase('fxwiki', loadWorkspaceAppsConfig())!, root: wiki }),
    freezeBranch: async () => ({ cache: wiki, sha: wikiBase, identity: repoIdentity(wiki) }),
    taskWorktree: async () => ({ root: wiki, branch: 'feature/knowledge-fixture', sha: wikiBase }),
    prepareFeatureKnowledge: async input => {
      assert.notEqual(input.code.sha, JSON.parse((await current()).harnessJson).delivery.codeSnapshot.sha, 'knowledge uses developer local-fix commit, not old acceptance')
      assert.equal(await git(input.code.sourceRoot!, ['show', `${input.code.mergedSha}:page.txt`]), 'developer locally verified fix')
      ingests++; await mkdir(path.join(wiki, 'android_wiki/wiki/features/demo'), { recursive: true })
      await writeFile(path.join(wiki, 'android_wiki/wiki/features/demo/implementation.md'), '# Synthetic accepted capability\n')
      return ['android_wiki/wiki/features']
    },
    mergedByWebhook: async (dir, expected, _signal, iid, baseSha, handedOff) => {
      const event = await findMergedReceipt(expected, iid, handedOff)
      if (!event) return null
      const sourceSha = String(event.sourceSha)
      const sourceRoot = await withMergeProof({ remote: pathToFileURL(repoIdentity(dir).remote).href, target: expected.target, iid: Number(event.iid), sourceSha, mergedSha: String(event.mergedSha), baseSha }, signal, async proof => {
        if (handedOff) await verifyHandoffSource(proof.cache, expected.sha, sourceSha, signal)
        const changes = (await git(proof.cache, ['diff', '--name-only', '-z', sourceSha, String(event.mergedSha)], signal)).split('\0')
        assert.equal(proof.paths.some(file => changes.includes(file)), false)
        return proof.cache
      })
      return { ...expected, sha: sourceSha, mergedSha: String(event.mergedSha), sourceRoot, iid: Number(event.iid), url: `${expected.origin}/${expected.repository}/-/merge_requests/${event.iid}` }
    },
    pushKnowledgeMR: async (dir, remote, expected) => {
      knowledgeMRs++; await pushSnapshot(dir, remote, expected.branch, expected.sha, signal)
      return { ...expected, iid: 2, url: `${expected.origin}/${expected.repository}/-/merge_requests/2` }
    },
  }
  const current = () => prisma.cloudAgentTask.findUniqueOrThrow({ where: { id: task.id } })
  const claim = async () => { const item = await claimCloudRun(); assert.equal(item?.task.id, task.id); return item! }
  const guard = async () => { assert.equal((await current()).status, 'delivering') }
  await queueAutomaticDelivery(task.id, 'submit_delivery')
  const first = await claim()
  await assert.rejects(runDelivery(first, signal, guard, adapters), /证据已失效/)
  assert.equal(await git(codeRemote, ['for-each-ref', '--format=%(refname)', 'refs/heads/feature']), '')
  verified = true
  await runDelivery(first, signal, guard, adapters)
  assert.equal((await current()).status, 'awaiting_merge'); assert.equal(ingests, 0); assert.equal(knowledgeMRs, 0)
  assert.equal(await prisma.integrationTask.count(), 0); assert.equal(await prisma.integrationRun.count(), 0)
  await collectCloudNotifications(); await collectCloudNotifications()
  let notices = 0
  await dispatchCloudNotification(signal, async payload => {
    notices++
    assert.match(payload.text.content, /^转译任务待办\n/)
    assert.match(payload.text.content, /应用：酷狗直播\n当前环节：提测\n/)
    assert.match(payload.text.content, /本地复核/)
  })
  await dispatchCloudNotification(signal, async () => { notices++ })
  assert.equal(notices, 1)
  const published = JSON.parse((await current()).harnessJson).delivery
  assert.equal(await queueAutomaticDelivery(task.id, 'sync_delivery'), false, 'pending developer review does not schedule a worker')
  const owner = await prisma.apiToken.create({ data: { tokenHash: 'delivery-confirm-fixture', personName: 'fixture', personCode: 'fixture' } })
  await decideCloudTask({ id: owner.id, appIds: [appId] }, task.id, { action: 'confirm_delivery', revision: (await current()).revision })
  assert.equal(await prisma.integrationTask.count(), 1)
  assert.equal(await prisma.integrationRun.count(), 0)
  assert.equal(await git(code, ['rev-parse', 'HEAD']), registeredHead, 'verified worktree never switches to published commit')
  assert.equal(await git(codeRemote, ['show', `${published.codeSnapshot.sha}:debug-profile.json`]), '{"fixture":true}')
  assert.equal(await git(codeRemote, ['show', `${published.codeSnapshot.sha}:docs/migrations/${appId}/${identity}/requirements.md`]), '# Synthetic requirements.md\nThis is a fixture, not real acceptance.')
  await queueAutomaticDelivery(task.id, 'sync_delivery'); await runDelivery(await claim(), signal, guard, adapters)
  assert.equal((await current()).status, 'awaiting_merge'); assert.equal(ingests, 0)
  const merge = async (mr: DeliveryMR, dir: string, projectId: number, commit: string) => {
    const remote = repoIdentity(dir).remote
    await git(dir, ['push', remote, `${commit}:refs/heads/${mr.target}`, `${commit}:refs/merge-requests/${mr.iid}/head`])
    return receiveCloudWebhook({ object_kind: 'merge_request', project: { id: projectId, web_url: `${mr.origin}/${mr.repository}` }, object_attributes: { state: 'merged', iid: mr.iid, source_project_id: projectId, source_branch: mr.branch, target_branch: mr.target, last_commit: { id: commit }, merge_commit_sha: commit } })
  }
  const codeMR = { ...published.codeCandidate, iid: 1, url: 'https://git.example/team/code/-/merge_requests/1' }
  const developer = path.join(root, 'developer')
  await git(code, ['worktree', 'add', '--detach', developer, codeMR.sha])
  await writeFile(path.join(developer, 'page.txt'), 'developer locally verified fix')
  await git(developer, ['commit', '-am', 'local developer fix'])
  const fixedSha = await git(developer, ['rev-parse', 'HEAD'])
  await merge(codeMR, code, 1, fixedSha)
  await queueAutomaticDelivery(task.id, 'sync_delivery')
  const retry = await claim()
  await assert.rejects(runDelivery(retry, signal, guard, { ...adapters, prepareFeatureKnowledge: async () => { throw new CloudTransientError('synthetic temporary unavailable', 503) } }), /temporary/)
  assert.equal(await deferDeliveryRun(retry, new CloudTransientError('synthetic temporary unavailable', 503), signal), true)
  assert.equal(JSON.parse((await current()).harnessJson).delivery.codeSnapshot.sha, published.codeSnapshot.sha)
  await queueAutomaticDelivery(task.id, 'sync_delivery'); await runDelivery(await claim(), signal, guard, adapters)
  assert.equal((await current()).status, 'knowledge_review'); assert.equal(ingests, 1); assert.equal(knowledgeMRs, 1)
  await queueAutomaticDelivery(task.id, 'sync_delivery'); await runDelivery(await claim(), signal, guard, adapters)
  assert.equal((await current()).status, 'knowledge_review'); assert.equal(ingests, 1); assert.equal(knowledgeMRs, 1)
  const knowledge = JSON.parse((await current()).harnessJson).delivery.knowledge
  await merge(knowledge, wiki, 2, knowledge.sha)
  await queueAutomaticDelivery(task.id, 'sync_delivery'); await runDelivery(await claim(), signal, guard, adapters)
  assert.equal((await current()).status, 'completed'); assert.equal(await prisma.integrationTask.count(), 1)
  assert.equal(await prisma.cloudAgentRun.count({ where: { kind: { not: 'delivery' } } }), 0, 'delivery retries never start analysis or translation')
})

test('incomplete device conclusion publishes an honest branch without strict acceptance documents', async () => {
  const signal = AbortSignal.timeout(60000), appId = 'KugouLive', identity = 'synthetic-device-gap'
  const code = path.join(root, 'incomplete-code'), remote = path.join(root, 'incomplete-code.git'), artifacts = path.join(root, 'incomplete-artifacts')
  for (const dir of [code, remote, artifacts]) await mkdir(dir)
  await git(code, ['init', '-b', 'kan-fx-release'])
  await git(code, ['config', 'user.name', 'fixture'])
  await git(code, ['config', 'user.email', 'fixture@localhost'])
  await writeFile(path.join(code, 'page.txt'), 'baseline')
  await git(code, ['add', '.']); await git(code, ['commit', '-m', 'baseline'])
  const baseSha = await git(code, ['rev-parse', 'HEAD'])
  await git(remote, ['init', '--bare'])
  await git(code, ['push', remote, 'kan-fx-release'])
  await git(code, ['checkout', '-b', 'feature/device-gap'])
  await writeFile(path.join(code, 'page.txt'), 'new implementation')
  const runDir = path.join(artifacts, 'harness')
  await mkdir(runDir)
  await writeFile(path.join(runDir, 'verification-report.json'), JSON.stringify({ build: { artifact_sha256: 'c'.repeat(64) }, device: { status: 'incomplete' } }))
  const workspace: HarnessWorkspace = { identity, artifactRoot: artifacts, runDir, androidRoot: code, harmonyRoot: code,
    androidPrefixes: [''], harmonyPrefixes: [''], appId, title: 'device gap', profile: '', branch: 'feature/device-gap',
    baseSha, materialVersion: 1, continuous: true, documentsPath: 'docs/migrations' }
  const status = projectHarnessStatus({ verified: false, phase: 'build_passed' })
  status.nodes = [{ id: 'build_passed', label: '构建验证', status: 'passed' }, { id: 'functional_parity_passed', label: '功能验收', status: 'blocked' }]
  status.blockers = [{ code: 'fixture_missing', message: '缺少真实播放证据' }]
  status.codeReview = { status: 'passed', summary: '通过', checks: [], findings: [] }
  const conclusion = await deviceConclusion(workspace, status, false, '设备验收未完成')
  const task = await prisma.cloudAgentTask.create({ data: { appId, title: workspace.title, material: 'synthetic', source: 'android-mr',
    originKey: 'synthetic-device-gap', targetBranch: 'kan-fx-release', status: 'device_concluded',
    harnessJson: JSON.stringify({ workspace, status, deviceConclusion: conclusion }) } })
  assert.equal(await queueAutomaticDelivery(task.id, 'submit_delivery'), true)
  const claim = await claimCloudRun()
  assert.equal(claim?.task.id, task.id)
  await runDelivery(claim!, signal, async () => {}, {
    cloudProject: () => ({ ...cloudProject(appId), harmonyRoot: code }), executionConfig: () => executionConfig(appId),
    repositoryIdentity: async () => ({ origin: 'https://git.example', repository: 'team/code', remote, sourcePrefix: '' }),
    requireCodeReview: async () => {}, inspectCodeReview: async () => status.codeReview!,
    verifyHarness: async () => ({ raw: { verified: false }, status }),
  })
  const saved = JSON.parse((await prisma.cloudAgentTask.findUniqueOrThrow({ where: { id: task.id } })).harnessJson)
  assert.ok(saved.delivery.codeSnapshot.sha)
  const publishedConclusion = JSON.parse(await git(remote, ['show', `${saved.delivery.codeSnapshot.sha}:docs/migrations/${appId}/${identity}/device-conclusion.json`]))
  assert.equal(publishedConclusion.verificationSha256, conclusion.verificationSha256)
  assert.equal(publishedConclusion.sourceHeadSha, baseSha)
  assert.equal(await git(remote, ['show', `${saved.delivery.codeSnapshot.sha}:page.txt`]), 'new implementation')
  await assert.rejects(git(remote, ['show', `${saved.delivery.codeSnapshot.sha}:docs/migrations/${appId}/${identity}/acceptance-report.md`]))
  assert.equal((await prisma.cloudAgentTask.findUniqueOrThrow({ where: { id: task.id } })).status, 'awaiting_merge')
})
