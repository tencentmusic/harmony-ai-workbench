import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

import { getApp, loadAppCodeModules } from './app-code-modules.mjs'
import { KB_ROOT } from './paths.mjs'

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

export function resolveCodegraphConfigRel(config, appId, platform) {
  const app = getApp(config, appId)
  const rel = app.platforms?.[platform]?.codegraph_config
  if (!rel) throw new Error(`codegraph_config_missing:${appId}:${platform}`)
  return String(rel).replace(/\\/g, '/')
}

export function loadCodegraphConfigTemplate(configRel, kbRoot = KB_ROOT) {
  const file = path.join(kbRoot, configRel)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * 将 KB 模板转为「单 module 根目录」下的 codegraph.json。
 * init 在 modulePath 执行时，module 边界即 scope；include 用 `**`，保留 exclude/includeIgnored。
 */
export function buildModuleCodegraphConfig(template, modRel = '') {
  const mod = String(modRel || '').replace(/\\/g, '/').replace(/\/+$/g, '')
  const exclude = Array.isArray(template.exclude) ? [...template.exclude] : []
  const includeIgnored = Array.isArray(template.includeIgnored) ? [...template.includeIgnored] : []

  const out = { exclude }

  if (includeIgnored.length) {
    if (mod && includeIgnored.some((p) => mod === p.replace(/\/+$/, '') || mod.startsWith(`${p.replace(/\/+$/, '')}/`))) {
      out.includeIgnored = ['**']
    } else if (!mod) {
      out.includeIgnored = includeIgnored
    }
  }

  // 单 module init：索引该目录下全部源码（仍受 exclude + .gitignore + CodeGraph 内置 res/drawable 忽略）
  out.include = ['**']

  return out
}

export function formatCodegraphConfigJson(config) {
  return `${JSON.stringify(config, null, 2)}\n`
}

/**
 * 写入 module 根目录 codegraph.json（仅当缺失或内容变化；force 时覆盖）。
 */
export function ensureModuleCodegraphConfig(modulePath, template, options = {}) {
  const target = path.join(modulePath, 'codegraph.json')
  const next = buildModuleCodegraphConfig(template, options.modRel)
  const body = formatCodegraphConfigJson(next)

  let prev = null
  try {
    prev = fs.readFileSync(target, 'utf8')
  } catch {
    prev = null
  }

  const changed = prev !== body

  if (!options.force && prev && !changed) {
    return { written: false, path: target, changed: false }
  }

  if (options.dryRun) {
    return { written: false, path: target, changed: true, dryRun: true }
  }

  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, body, 'utf8')
  return { written: true, path: target, changed: true, hash: sha256(body) }
}

export function syncAppCodegraphConfigs(options = {}) {
  const config = options.config || loadAppCodeModules()
  const appId = options.appId || 'demo-project'
  const platform = options.platform || 'android'
  const appPaths = options.appPaths
  if (!appPaths) throw new Error('syncAppCodegraphConfigs requires appPaths')

  const templateRel = resolveCodegraphConfigRel(config, appId, platform)
  const template = loadCodegraphConfigTemplate(templateRel, options.kbRoot || KB_ROOT)
  const modules = platform === 'android' ? appPaths.androidModules : appPaths.harmonyModules
  const results = []

  for (const modRel of modules) {
    const modulePath =
      platform === 'android'
        ? appPaths.resolveAndroidModulePath(modRel)
        : path.join(appPaths.harmonyRepo, modRel)
    if (!fs.existsSync(modulePath)) {
      results.push({ module: modRel, status: 'missing', path: modulePath })
      continue
    }
    const r = ensureModuleCodegraphConfig(modulePath, template, {
      modRel,
      force: Boolean(options.force),
      dryRun: Boolean(options.dryRun),
    })
    results.push({
      module: modRel,
      status: r.dryRun ? 'would_write' : r.written ? 'written' : 'unchanged',
      path: r.path,
      changed: r.changed,
    })
  }

  return { templateRel, results }
}
