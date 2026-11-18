#!/usr/bin/env node
/**
 * 跨平台准备 OpenCode workspace symlink（本机 dev / start-harmony 调用）。
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeOpencodeConfig } from './render-opencode-config.mjs'
import {
  listWorkspaceLinks,
  loadWorkspaceAppsConfig,
  toLegacyScopeRows,
} from './lib/workspace-apps.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return false
  const text = readFileSync(filePath, 'utf8')
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    let val = trimmed.slice(idx + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    process.env[key] = val
  }
  return true
}

function loadRepoEnv() {
  for (const file of [
    path.join(repoRoot, '.env.local'),
    path.join(repoRoot, '.env'),
    path.join(repoRoot, '.env.production'),
  ]) {
    if (loadEnvFile(file)) return file
  }
  return ''
}

function linkPath(target, linkPathName) {
  const absTarget = path.resolve(target)
  if (!existsSync(absTarget)) {
    console.warn(`WARN: skip symlink ${linkPathName} → ${absTarget} (target missing)`)
    return false
  }
  mkdirSync(path.dirname(linkPathName), { recursive: true })
  try {
    lstatSync(linkPathName)
    rmSync(linkPathName, { recursive: true, force: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (process.platform === 'win32') {
    symlinkSync(absTarget, linkPathName, 'junction')
  } else {
    symlinkSync(absTarget, linkPathName, 'dir')
  }
  console.log(`✓ ${linkPathName} → ${absTarget}`)
  return true
}

function readAndroidAppScopes() {
  try {
    const config = loadWorkspaceAppsConfig({ repoRoot })
    return toLegacyScopeRows(config)
  } catch (e) {
    console.warn(`WARN: workspace-apps.json unavailable: ${e?.message || e}`)
    return []
  }
}

function writeAppScopesJson(workspaceDir) {
  try {
    const rows = readAndroidAppScopes()
    if (!rows.length) return false
    writeFileSync(
      path.join(workspaceDir, 'app-scopes.json'),
      `${JSON.stringify(rows, null, 2)}\n`,
      'utf8',
    )
    console.log(`✓ ${path.join(workspaceDir, 'app-scopes.json')}`)
    return true
  } catch (e) {
    console.warn(`WARN: skip app-scopes.json: ${e?.message || e}`)
    return false
  }
}

export function prepareOpencodeWorkspace(options = {}) {
  const workspaceDir = path.resolve(
    options.workspaceDir ||
      process.env.OPENCODE_WORKSPACE_DIR ||
      'C:/Users/jaydenxiao/fx-project/harmony-opencode-workspace',
  )
  loadRepoEnv()
  mkdirSync(workspaceDir, { recursive: true })

  const workspaceConfig = loadWorkspaceAppsConfig({ repoRoot })
  for (const link of listWorkspaceLinks(workspaceConfig)) {
    linkPath(link.root, path.join(workspaceDir, link.alias))
  }

  const agentDir = path.join(repoRoot, 'runtime', 'agents', 'harmony')
  const agentsMd = path.join(agentDir, 'AGENTS.md')
  if (existsSync(agentsMd)) {
    copyFileSync(agentsMd, path.join(workspaceDir, 'AGENTS.md'))
    console.log(`✓ AGENTS.md → ${workspaceDir}`)
  }

  writeAppScopesJson(workspaceDir)

  writeOpencodeConfig(path.join(workspaceDir, 'opencode.json'))
  console.log(`✓ ${path.join(workspaceDir, 'opencode.json')} (含 android-harmony-kb-mcp)`)

  console.log(`✓ workspace ready: ${workspaceDir}`)
  return workspaceDir
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  prepareOpencodeWorkspace({ workspaceDir: process.argv[2] })
}
