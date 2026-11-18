import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseExecutionConfig } from './execution-config'

test('dependency preparation is explicit and cannot inject shell commands or escape worktrees', () => {
  const build = { cwd: '.', artifact: 'app.hap', command: [process.execPath, 'hvigorw.js'] }
  assert.deepEqual(parseExecutionConfig({ build: { ...build, node_packages: [{ cwd: 'tools/plugin', allow_unlocked: true }] } }).build?.nodePackages, [{ cwd: 'tools/plugin', allowUnlocked: true }])
  for (const entries of [[{ cwd: '../other' }], [{ cwd: 'tools/a', command: ['npm', 'run', 'x'] }], [{ cwd: '.', allow_unlocked: 'true' }], [{ cwd: 'tools/a' }, { cwd: 'tools/a' }]]) {
    assert.throws(() => parseExecutionConfig({ build: { ...build, node_packages: entries } }))
  }
})

test('execution config rejects traversal, shell strings and unbound device adapters', () => {
  assert.throws(() => parseExecutionConfig({ build: { cwd: '../other', artifact: 'entry/app.hap', command: ['hvigor', 'assembleHap'] } }))
  assert.throws(() => parseExecutionConfig({ build: { cwd: '.', artifact: 'entry/app.hap', command: 'hvigor && evil' } }))
  assert.throws(() => parseExecutionConfig({ device: { hdc: process.execPath, descriptor: process.execPath } }))
  assert.throws(() => parseExecutionConfig({ delivery: { knowledge_id: 'docs', knowledge_branch: '-bad', knowledge_path: 'migration' } }))
  assert.equal(parseExecutionConfig({ build: { cwd: 'apps/live', artifact: 'apps/live/entry/build/default/app.hap', command: [process.execPath, 'hvigorw.js', 'assembleHap'] } }).build?.timeoutSeconds, 1800)
})

test('Android reference is optional, explicit and cannot inject executables or targets', () => {
  const config = parseExecutionConfig({ android_reference: { adb: process.execPath, target: 'synthetic-device', package: 'com.test.app' } })
  assert.equal(config.androidReference?.package, 'com.test.app')
  assert.throws(() => parseExecutionConfig({ android_reference: { adb: 'adb && bad', package: 'com.test.app' } }))
  assert.throws(() => parseExecutionConfig({ android_reference: { adb: process.execPath, target: '-evil', package: 'com.test.app' } }))
})
