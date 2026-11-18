import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink, realpath, access, readdir } from 'node:fs/promises'
import { dependencyInstallArgs, prepareBuildDependencies, runDependencyCommand } from './build-dependencies'
import type { HarnessWorkspace } from './harness'
import { CloudRecoveryError } from './domain'

test('package commands disable scripts and require explicit permission for unlocked installs', () => {
  assert.throws(() => dependencyInstallArgs(false, false), /package-lock/)
  assert.deepEqual(dependencyInstallArgs(true, false), ['ci', '--ignore-scripts', '--include=dev', '--no-save', '--no-audit', '--no-fund'])
  assert.ok(dependencyInstallArgs(false, true).includes('--package-lock=false'))
})

test('real npm keeps manifests unchanged and skips lifecycle scripts', async t => {
  const candidates = [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')]
  let cli = ''
  for (const candidate of candidates) { try { await access(candidate); cli = candidate; break } catch {} }
  if (!cli) { t.skip('Node installation has no bundled npm'); return }
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-real-npm-'))
  try {
    const cwd = path.join(root, 'package'), artifactRoot = path.join(root, 'artifacts')
    await mkdir(cwd)
    await mkdir(artifactRoot)
    const manifest = JSON.stringify({ name: 'cloud-deps-regression', version: '1.0.0', scripts: { preinstall: 'node -e "process.exit(42)"', postinstall: 'node -e "process.exit(42)"' } })
    await writeFile(path.join(cwd, 'package.json'), manifest)
    const request = { node: process.execPath, cli, cwd, artifactRoot, log: path.join(artifactRoot, 'npm.log'), signal: AbortSignal.timeout(60000) }
    await runDependencyCommand({ ...request, args: [...dependencyInstallArgs(false, true), '--offline'] })
    assert.equal(await readFile(path.join(cwd, 'package.json'), 'utf8'), manifest)
    await assert.rejects(access(path.join(cwd, 'package-lock.json')), { code: 'ENOENT' })
    await runDependencyCommand({ ...request, args: ['ls', '--depth=0', '--json', '--offline'] })
    await assert.rejects(runDependencyCommand({ ...request, args: ['cloud-invalid-command'] }), /构建依赖准备失败/)
    for (const file of await readdir(path.join(artifactRoot, 'processes'))) {
      const receipt = JSON.parse(await readFile(path.join(artifactRoot, 'processes', file), 'utf8'))
      assert.equal(receipt.status, 'stopped')
      assert.ok(receipt.pid > 0)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('dependency receipts reuse only matching manifests and valid local packages', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-node-deps-'))
  try {
    const harmonyRoot = path.join(root, 'repo'), artifactRoot = path.join(root, 'artifacts'), tools = path.join(root, 'tools')
    await mkdir(path.join(harmonyRoot, 'plugin'), { recursive: true })
    await mkdir(path.join(tools, 'node_modules/npm/bin'), { recursive: true })
    const node = path.join(tools, 'node.exe')
    await writeFile(node, 'synthetic node')
    await writeFile(path.join(tools, 'node_modules/npm/bin/npm-cli.js'), 'synthetic npm')
    const manifest = path.join(harmonyRoot, 'plugin/package.json')
    await writeFile(manifest, JSON.stringify({ dependencies: { example: '1.0.0' } }))
    const workspace = { harmonyRoot, artifactRoot } as HarnessWorkspace
    const build = { cwd: '.', artifact: 'app.hap', command: [node, 'hvigorw.js'], timeoutSeconds: 30, dependencies: [], nodePackages: [{ cwd: 'plugin', allowUnlocked: true }] }
    let installs = 0, missing = false, uncertain = false
    const runner: Parameters<typeof prepareBuildDependencies>[4] = async input => {
      assert.equal(input.cwd, await realpath(path.join(harmonyRoot, 'plugin')))
      if (uncertain) throw new CloudRecoveryError('synthetic uncertain process', 409)
      if (input.args[0] === 'ls' && missing) { missing = false; throw Error('missing package') }
      if (input.args[0] === 'install') { installs++; assert.ok(input.args.includes('--ignore-scripts')) }
      return '{}'
    }
    const prepare = () => prepareBuildDependencies(workspace, build, AbortSignal.timeout(30000), async () => {}, runner)
    await prepare(); await prepare(); assert.equal(installs, 1)
    uncertain = true
    await assert.rejects(prepare(), CloudRecoveryError)
    assert.equal(installs, 1)
    uncertain = false
    missing = true; await prepare(); assert.equal(installs, 2)
    await writeFile(manifest, JSON.stringify({ dependencies: { example: '2.0.0' } }))
    await prepare(); assert.equal(installs, 3)
    await writeFile(manifest, JSON.stringify({ dependencies: { example: 'file:../../other' } }))
    await assert.rejects(prepare(), /非 registry/)
    await writeFile(manifest, '{}')
    await symlink(tools, path.join(harmonyRoot, 'plugin/node_modules'), 'junction')
    await assert.rejects(prepare(), /链接/)
    assert.equal(await readFile(node, 'utf8'), 'synthetic node')
  } finally { await rm(root, { recursive: true, force: true }) }
})
