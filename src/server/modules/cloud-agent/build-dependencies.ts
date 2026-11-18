import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { CloudEnvironmentError, CloudRecoveryError, record } from './domain'
import { harnessEnvironment, type HarnessWorkspace } from './harness'
import type { ExecutionConfig } from './execution-config'
import { scopedPath, sha256 } from './scoped-files'

const execute = promisify(execFile)
type Request = { node: string; cli: string; cwd: string; args: string[]; artifactRoot: string; log: string; signal: AbortSignal }
const scrub = (text: string) => text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@').replace(/((?:_authToken|authorization|_password)\s*[=:]\s*)[^\s]+/gi, '$1[redacted]')

export async function runDependencyCommand(input: Request) {
  const receiptFile = path.join(input.artifactRoot, 'processes', `${randomUUID()}.json`)
  await mkdir(path.dirname(receiptFile), { recursive: true })
  const receipt = { kind: 'harness', command: 'node-dependencies', host: os.hostname(), pid: 0, startedAt: new Date().toISOString(), status: 'starting' }
  await writeFile(receiptFile, JSON.stringify(receipt), { flag: 'wx' })
  const running = execute(input.node, [input.cli, ...input.args, '--prefix', input.cwd, '--workspaces=false', '--global=false'], {
    cwd: input.cwd, env: { ...harnessEnvironment(), PATH: path.dirname(input.node) + path.delimiter + (process.env.PATH || '') },
    signal: input.signal, timeout: 600000, windowsHide: true, shell: false, maxBuffer: 4 * 1024 * 1024,
  })
  void running.catch(() => {})
  receipt.pid = running.child.pid || 0
  receipt.status = 'running'
  try {
    await writeFile(receiptFile, JSON.stringify(receipt))
    const result = await running
    await writeFile(input.log, scrub(result.stdout + '\n' + result.stderr))
    receipt.status = 'stopped'
    await writeFile(receiptFile, JSON.stringify(receipt))
    return result.stdout
  } catch (error) {
    const failure = error as { killed?: boolean; signal?: string; stdout?: string; stderr?: string }
    const uncertain = input.signal.aborted || failure.killed || failure.signal || running.child.exitCode === null && running.child.signalCode === null
    receipt.status = uncertain ? 'uncertain' : 'stopped'
    await writeFile(receiptFile, JSON.stringify(receipt)).catch(() => { throw new CloudRecoveryError('依赖安装进程收据写入失败，需核验后恢复', 409) })
    await writeFile(input.log, scrub((failure.stdout || '') + '\n' + (failure.stderr || '依赖命令执行失败')))
    if (uncertain) throw new CloudRecoveryError('依赖安装进程状态未确认，保留构建锁；核验进程后恢复', 409)
    throw new CloudEnvironmentError(`构建依赖准备失败：${path.relative(input.artifactRoot, input.log).replaceAll('\\', '/')}。请检查该日志中的包、版本和仓库访问问题；未启动 Hvigor。`, 503)
  }
}

export function dependencyInstallArgs(locked: boolean, allowUnlocked: boolean) {
  if (!locked && !allowUnlocked) throw new CloudEnvironmentError('依赖目录没有 package-lock.json；请源码仓提供锁文件，或管理员显式配置 allow_unlocked', 503)
  return [locked ? 'ci' : 'install', '--ignore-scripts', '--include=dev', '--no-save', '--no-audit', '--no-fund', ...(locked ? [] : ['--package-lock=false'])]
}

export async function prepareBuildDependencies(workspace: HarnessWorkspace, build: NonNullable<ExecutionConfig['build']>, signal: AbortSignal,
  notice: (message: string) => Promise<void> = async () => {}, run = runDependencyCommand) {
  if (!build.nodePackages?.length) return
  const node = await realpath(build.command[0])
  if (!/^node(?:\.exe)?$/i.test(path.basename(node))) throw new CloudEnvironmentError('Node 依赖准备需要 build.command 使用 DevEco 自带 Node + hvigorw.js', 503)
  const nodeDir = path.dirname(node)
  let cli = ''
  for (const [base, relative] of [[nodeDir, 'node_modules/npm/bin/npm-cli.js'], [path.dirname(nodeDir), 'lib/node_modules/npm/bin/npm-cli.js']]) {
    try { cli = await scopedPath(base, relative, ['']); break } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  if (!cli) throw new CloudEnvironmentError('DevEco Node 缺少配套 npm-cli.js，请管理员修复工具安装', 503)
  for (const pkg of build.nodePackages) {
    signal.throwIfAborted()
    const prefix = pkg.cwd === '.' ? '' : `${pkg.cwd}/`
    const manifestFile = await scopedPath(workspace.harmonyRoot, `${prefix}package.json`, [''])
    const cwd = path.dirname(manifestFile)
    await scopedPath(workspace.harmonyRoot, `${prefix}node_modules`, [''], true)
    const manifest = await readFile(manifestFile), json = record(JSON.parse(manifest.toString()))
    // Linked/workspace packages could cross task boundaries. This adapter installs registry packages only.
    if (json.workspaces || Object.entries({ ...record(json.dependencies || {}), ...record(json.devDependencies || {}), ...record(json.optionalDependencies || {}) }).some(([name, value]) => !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || typeof value !== 'string' || /[:/\\]/.test(value))) throw new CloudEnvironmentError(`依赖目录 ${pkg.cwd} 包含工作区或非 registry 依赖，当前受控安装器不支持`, 503)
    const lockFile = await scopedPath(workspace.harmonyRoot, `${prefix}package-lock.json`, [''], true)
    const lock = await readFile(lockFile).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (lock && Object.values(record(record(JSON.parse(lock.toString())).packages || {})).some(value => { const entry = record(value); return entry.link === true || typeof entry.resolved === 'string' && /^(file:|\.\.?\/|[A-Za-z]:[\\/])/.test(entry.resolved) })) throw new CloudEnvironmentError('依赖锁文件包含本地链接，不允许跨任务安装', 503)
    const args = dependencyInstallArgs(!!lock, pkg.allowUnlocked)
    const fingerprint = sha256(JSON.stringify({ manifest: sha256(manifest), lock: lock && sha256(lock), node: sha256(await readFile(node)), cli: sha256(await readFile(cli)), args }))
    const out = path.join(workspace.artifactRoot, 'dependencies', sha256(pkg.cwd).slice(0, 16))
    await mkdir(out, { recursive: true })
    const receiptFile = path.join(out, 'installed.json')
    const saved = await readFile(receiptFile, 'utf8').then(value => record(JSON.parse(value)), () => ({} as Record<string, unknown>))
    const probe = () => run({ node, cli, cwd, args: ['ls', '--depth=0', '--json', '--include=dev'], artifactRoot: workspace.artifactRoot, log: path.join(out, 'check.log'), signal })
    if (saved.fingerprint === fingerprint) {
      try { await probe(); await notice(`构建依赖已校验，复用 ${pkg.cwd}`); continue }
      catch (error) { if (error instanceof CloudRecoveryError || signal.aborted) throw error }
    }
    await notice(`准备构建依赖：${pkg.cwd}（${lock ? '按锁文件安装' : '管理员允许无锁安装'}，禁用安装脚本）`)
    await run({ node, cli, cwd, args, artifactRoot: workspace.artifactRoot, log: path.join(out, 'install.log'), signal })
    await probe()
    if (sha256(await readFile(manifestFile)) !== sha256(manifest) || (await readFile(lockFile).catch(error => { if (error.code === 'ENOENT') return null; throw error }))?.toString() !== lock?.toString()) throw new CloudEnvironmentError('安装期间依赖清单已变化，不能复用审查或继续构建', 409)
    await writeFile(receiptFile, JSON.stringify({ fingerprint, cwd: pkg.cwd, locked: !!lock, installedAt: new Date().toISOString() }))
    await notice(`构建依赖准备完成：${pkg.cwd}`)
  }
}
