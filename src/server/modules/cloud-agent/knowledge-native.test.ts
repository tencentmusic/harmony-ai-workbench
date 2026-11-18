import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { runWikiValidation, validateKnowledgePlan, withWikiSkillAlias } from './knowledge-ingest'

test('native wiki apply rebuilds projections, passes final gates and rolls back an invalid plan in an isolated fixture', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-native-wiki-')), signal = AbortSignal.timeout(120000)
  const library = path.resolve(process.env.CLOUD_AGENT_TEST_WIKI_ROOT || '../fxwiki')
  try {
    for (const folder of ['.wiki-tmp', '.agent', '.claude', 'artifacts', 'android_wiki/wiki/features/工程规范/合成验证']) await mkdir(path.join(root, folder), { recursive: true })
    for (const name of ['fxwiki', 'fxwiki-lint']) await cp(path.join(library, '.agents/skills', name), path.join(root, '.agents/skills', name), { recursive: true, filter: source => !source.includes('__pycache__') })
    await cp(path.join(library, 'fxwiki_config.json'), path.join(root, 'fxwiki_config.json'))
    await writeFile(path.join(root, '.claude/skills'), '../.agents/skills')
    await writeFile(path.join(root, 'log.md'), '# Fixture log\n')
    await writeFile(path.join(root, 'android_wiki/index.md'), '# Fixture index\n')
    const prefix = 'wiki/features/工程规范/合成验证'
    const metadata = (title: string, type: string, slot: string) => `---\ntitle: ${title}\ntype: ${type}\ncapability: synthetic_fixture\napplies_to: [kugou_live.android]\nupdated: 2026-10-13\nconfidence: high\nknowledge_slot: ${slot}\nsources: []\nrelated: []\n---\n# ${title}\n`
    const readme = metadata('合成验证', 'readme', 'core') + '## 模块定位\n隔离测试使用的合成能力，不描述真实业务。\n## 知识路由\n| 问题意图 | 关键词 | 适用目标 | 读取目标 |\n|---|---|---|---|\n| 核验结果 | 合成验证 | kugou_live.android | [核心流程](implementation.md#核心流程) |\n'
    const implementation = metadata('合成验证实现', 'implementation', 'flow') + '## 核心流程\n分型：功能点。\n### 测试输入提交\n合成测试收到输入后检查固定字符串是否一致，一致时写入本地测试结果并返回成功；不一致时返回失败，不修改任何业务数据。本页面仅作为原生校验器的测试输入。\n'
    await writeFile(path.join(root, '.wiki-tmp/readme.md'), readme); await writeFile(path.join(root, '.wiki-tmp/implementation.md'), implementation)
    const plan = { operation: 'ingest', summary: 'Synthetic fixture only', date: '2026-10-13', log: { kind: 'ingest', title: 'Synthetic fixture' }, pages: [
      { action: 'create', path: `${prefix}/README.md`, content_file: '.wiki-tmp/readme.md' },
      { action: 'create', path: `${prefix}/implementation.md`, content_file: '.wiki-tmp/implementation.md' },
    ] }
    await writeFile(path.join(root, '.wiki-tmp/apply-plan.json'), JSON.stringify(plan))
    const { planPath, pages } = await validateKnowledgePlan(root)
    await withWikiSkillAlias(root, async () => {
      await runWikiValidation(root, path.join(root, 'artifacts'), ['.agents/skills/fxwiki/scripts/apply_wiki_plan.py', planPath], signal)
      await runWikiValidation(root, path.join(root, 'artifacts'), ['.agents/skills/fxwiki-lint/scripts/validate_wiki_gate.py', '--root', root, 'log.md', 'android_wiki/index.md', 'android_wiki/code.md', ...pages.map(file => `android_wiki/${file}`)], signal)
      await runWikiValidation(root, path.join(root, 'artifacts'), ['.agents/skills/fxwiki/scripts/build_wiki_indexes.py', '--root', root, '--check'], signal)
      const before = await readFile(path.join(root, 'android_wiki', prefix, 'README.md'), 'utf8')
      await writeFile(path.join(root, '.wiki-tmp/readme.md'), readme.replace('implementation.md#核心流程', 'missing.md#失效链接'))
      await assert.rejects(runWikiValidation(root, path.join(root, 'artifacts'), ['.agents/skills/fxwiki/scripts/apply_wiki_plan.py', planPath], signal), /校验未通过/)
      assert.equal(await readFile(path.join(root, 'android_wiki', prefix, 'README.md'), 'utf8'), before)
    })
    assert.equal(await readFile(path.join(root, '.claude/skills'), 'utf8'), '../.agents/skills')
  } finally { await rm(root, { recursive: true, force: true }) }
})
