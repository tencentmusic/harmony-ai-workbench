#!/usr/bin/env node
/**
 * harmony-kb CLI — 类似 codegraph install/init 的一键 Agent 接入
 *
 *   npm run setup              # clone 后一条命令：deps + validate + CodeGraph + MCP
 *   npx harmony-kb codegraph-init   # 仅初始化 CodeGraph 索引
 *   npx harmony-kb setup       # 同上（需在仓库根目录）
 *   npx harmony-kb install     # 仅写 Cursor/Codex MCP 配置
 *   npx harmony-kb init        # 仅校验知识库（L1 就绪）
 *   npx harmony-kb status      # 检查 MCP 配置与 validate
 */
import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  auditCodegraphIndexes,
  detectAgents,
  installClaude,
  installCodex,
  installCursor,
  kbRootFromCli,
  parseTargetArg,
  removeCursorMcpConfig,
  resolveCursorMcpPaths,
  cursorMcpHasServer,
  uninstallClaude,
  uninstallCodex,
  workspaceRootForKb,
} from './agent-install.mjs'
import { runCodegraphInit } from './codegraph-init.mjs'
import { runCodegraphSync } from './codegraph-sync.mjs'

const kbRoot = kbRootFromCli(import.meta.url)

function log(msg) {
  console.log(msg)
}

function runValidate() {
  execSync('node scripts/validate/validate-runtime.mjs', { cwd: kbRoot, stdio: 'inherit' })
}

function ensureDeps() {
  const workspaceRoot = workspaceRootForKb(kbRoot)
  const hasLocal = fs.existsSync(path.join(kbRoot, 'node_modules/@modelcontextprotocol/sdk'))
  const hasWorkspace = fs.existsSync(path.join(workspaceRoot, 'node_modules/@modelcontextprotocol/sdk'))
  if (!hasLocal && !hasWorkspace) {
    log('\n→ npm install …')
    execSync('npm install', { cwd: workspaceRoot, stdio: 'inherit' })
  }
}

function parseFlags(argv) {
  const flags = {
    yes: argv.includes('--yes') || argv.includes('-y'),
    telemetry: argv.includes('--telemetry'),
    location: 'both',
    target: 'auto',
    skipCodegraph: false,
    noTelemetry: false,
  }
  for (const arg of argv) {
    if (arg.startsWith('--target=')) flags.target = arg.slice('--target='.length)
    if (arg.startsWith('--location=')) flags.location = arg.slice('--location='.length)
    if (arg === '--skip-codegraph') flags.skipCodegraph = true
    if (arg === '--no-telemetry') flags.noTelemetry = true
  }
  if (flags.noTelemetry) flags.telemetry = false
  else if (argv.includes('--telemetry') || argv.includes('--yes') || argv.includes('-y')) {
    flags.telemetry = true
  }
  return flags
}

function cmdInit() {
  ensureDeps()
  log('=== harmony-kb init ===')
  log('校验项目业务知识库绑定与 manifest（L1 get_feature_context 所需）…\n')
  runValidate()
  log('\ninit ok — 知识库 L1 就绪。')
  log('下一步：npm run kb:install  或  npm run setup（若尚未 install）')
}

function cmdInstall(argv) {
  const flags = parseFlags(argv)
  const detected = detectAgents()
  let targets = parseTargetArg(flags.target, detected)

  if (!flags.yes && flags.target === 'auto') {
    log(`检测到 Agent：${detected.length ? detected.join(', ') : '（无，默认 cursor 项目配置）'}`)
    if (!detected.length) targets = ['cursor']
  }

  const options = {
    telemetry: flags.telemetry,
    telemetryEndpoint: process.env.KB_TELEMETRY_ENDPOINT,
    telemetryConsumer: targets.includes('codex') && !targets.includes('cursor') ? 'codex-agent' : 'cursor-agent',
  }
  const written = []

  log('=== harmony-kb install ===')
  log(`知识库：${kbRoot.replace(/\\/g, '/')}\n`)

  const cg = auditCodegraphIndexes()
  if (cg.ready) {
    log(`CodeGraph 索引：Android ${cg.android.indexed} module · Harmony ${cg.harmony.indexed} module ✓`)
  } else {
    log('⚠ CodeGraph 索引未就绪（L2 kb_codegraph_* 将返回空）')
    log('  请先：npm run kb:codegraph-init  或  npm run setup（需 Android/Harmony 源码仓）')
  }
  log('')

  if (targets.includes('cursor')) {
    const files = installCursor({ kbRoot, location: flags.location, options })
    written.push(...files.map((f) => `Cursor: ${f}`))
  }
  if (targets.includes('codex')) {
    written.push(`Codex: ${installCodex({ kbRoot, options })}`)
  }
  if (targets.includes('claude')) {
    written.push(`Claude: ${installClaude({ kbRoot, options })}`)
  }

  for (const w of written) log(`  ✓ ${w}`)

  log('\ninstall 完成。请重启 Agent / Reload MCP。')
  log('\n试用（L1 业务 feature）：get_feature_context({ feature_id: "demo_feature", project_id: "demo-project" })')
  log('单端 L2：kb_codegraph_search({ query: "YourClass", platform: "android" | "harmonyos" })')
  if (flags.telemetry) {
    log(`遥测：已开启（consumer=${options.telemetryConsumer} → ${options.telemetryEndpoint || 'http://127.0.0.1:3100/api/kb-telemetry/v1/events'}）`)
    log('  看板需鸿蒙 AI 工台运行中（默认 :3100）')
  } else {
    log('（未启用遥测；看板统计请加 --telemetry）')
  }
}

function cmdCodegraphInit(argv) {
  const force = argv.includes('--force')
  try {
    runCodegraphInit(kbRoot, { force })
  } catch (e) {
    if (e.message === 'source_repo_missing') {
      process.exitCode = 1
      return
    }
    throw e
  }
}

function cmdCodegraphSync() {
  try {
    runCodegraphSync(kbRoot)
  } catch (e) {
    if (e.message === 'source_repo_missing' || e.message === 'no_index_to_sync') {
      process.exitCode = 1
      return
    }
    throw e
  }
}

function cmdSetup(argv) {
  const flags = parseFlags(argv)
  log('=== harmony-kb setup（init + codegraph-init + install）===\n')
  ensureDeps()
  runValidate()
  log('')
  if (!flags.skipCodegraph) {
    try {
      runCodegraphInit(kbRoot)
      log('')
    } catch (e) {
      if (e.message === 'source_repo_missing') {
        log('\n⚠ setup 继续（跳过 CodeGraph）；源码就绪后执行: npm run kb:codegraph-init\n')
      } else {
        throw e
      }
    }
  } else {
    log('（已 --skip-codegraph，跳过 CodeGraph 索引）\n')
  }
  cmdInstall([...argv, '--yes'])
  log('\n--- setup 完成 ---')
  log('Reload MCP 后应看到 android-harmony-kb-mcp；试用 get_feature_context({ feature_id: "demo_feature", project_id: "demo-project" })')
}

function cmdStatus() {
  const detected = detectAgents()
  log('=== harmony-kb status ===')
  log(`KB_ROOT: ${kbRoot}`)
  log(`Agents detected: ${detected.join(', ') || '(none)'}`)

  const mcpPaths = resolveCursorMcpPaths(kbRoot, 'both')
  for (const mcp of mcpPaths) {
    const ok = cursorMcpHasServer(mcp)
    log(`Cursor mcp (${ok ? '✓' : '✗'} android-harmony-kb-mcp): ${mcp}`)
  }
  log(`Codex config:       ${fs.existsSync(path.join(os.homedir(), '.codex/config.toml')) ? '✓' : '✗'}`)

  const cg = auditCodegraphIndexes()
  log(`CodeGraph Android:  ${cg.android.indexed} module indexed`)
  log(`CodeGraph Harmony:  ${cg.harmony.indexed} module indexed`)

  try {
    runValidate()
  } catch {
    process.exitCode = 1
  }
}

function cmdUninstall(argv) {
  const flags = parseFlags(argv)
  const targets = parseTargetArg(flags.target, detectAgents())
  log('=== harmony-kb uninstall ===')
  if (targets.includes('cursor')) {
    removeCursorMcpConfig(path.join(kbRoot, '.cursor/mcp.json'))
    for (const mcp of resolveCursorMcpPaths(kbRoot, 'both')) {
      removeCursorMcpConfig(mcp)
    }
    log('  ✓ Cursor android-harmony-kb-mcp removed')
  }
  if (targets.includes('codex') && uninstallCodex()) log('  ✓ Codex block removed')
  if (targets.includes('claude') && uninstallClaude()) log('  ✓ Claude removed')
}

function cmdHelp() {
  log(`harmony-kb — Android↔Harmony 知识库 Agent 接入 CLI

用法（在 Workbench 根目录通过 kb:*，或在 packages/android-harmony-kb 内执行）：
  npm run setup                 一条命令：deps + validate + CodeGraph + MCP（推荐）
  npm run kb:codegraph-init     全量：CodeGraph CLI + codegraph init（各 module）
  npm run kb:codegraph-sync     增量：仅更新 CodeGraph 索引（源码变更后）
  npx harmony-kb setup          同上
  npx harmony-kb codegraph-sync  增量更新 CodeGraph 索引
  npx harmony-kb init             校验业务知识库绑定与 manifest
  npx harmony-kb install          写入 Cursor/Codex MCP 配置
  npx harmony-kb status           检查配置与 validate
  npx harmony-kb uninstall        移除 MCP 配置

install / setup 选项：
  --yes, -y              非交互（setup 默认）
  --skip-codegraph       setup 时跳过 CodeGraph 索引（仅 MCP）
  --target=auto          自动检测 cursor,codex,claude
  --target=cursor,codex  指定 Agent
  --location=both        写 KB 包 + Workbench 根目录 + ~/.cursor/mcp.json（默认）
  --telemetry            开启 KB 遥测（setup/install --yes 默认开启）
  --no-telemetry         关闭遥测（仅 install/setup）

clone 后最快路径（需在 workspace-apps.json 配置 Android/Harmony 源码仓）：
  git clone <workbench-url> && cd kugou-harmony-ai-workbench && npm install && npm run kb:setup
`)
}

const [,, command, ...rest] = process.argv

switch (command) {
  case 'setup':
    cmdSetup(rest)
    break
  case 'codegraph-sync':
    cmdCodegraphSync()
    break
  case 'codegraph-init':
    cmdCodegraphInit(rest)
    break
  case 'init':
    cmdInit()
    break
  case 'install':
    cmdInstall(rest)
    break
  case 'status':
    cmdStatus()
    break
  case 'uninstall':
    cmdUninstall(rest)
    break
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    cmdHelp()
    break
  default:
    console.error(`unknown command: ${command}`)
    cmdHelp()
    process.exit(1)
}
