import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { createKbAppContext } from './kb-app-context.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const KB_ROOT = path.resolve(__dirname, '../..')

const _defaultCtx = createKbAppContext({ appId: 'demo-project', domainId: 'default' })

export const PATHS = {
  androidRepo: _defaultCtx.paths.androidRepo,
  harmonyRepo: _defaultCtx.paths.harmonyRepo,
  androidCommit: _defaultCtx.paths.androidCommit,
  harmonyCommit: _defaultCtx.paths.harmonyCommit,
  androidBranch: _defaultCtx.paths.androidBranch,
  harmonyBranch: _defaultCtx.paths.harmonyBranch,
}

export const ANDROID_KTV_MODULES = _defaultCtx.androidModules
export const HARMONY_KTV_MODULES = _defaultCtx.harmonyModules
export const HARMONY_KTV_MODULE = _defaultCtx.harmonyPrimaryModule

export function getAppPaths(appId = 'demo-project', domainId) {
  const ctx = createKbAppContext({ appId, domainId })
  return {
    androidRepo: ctx.paths.androidRepo,
    harmonyRepo: ctx.paths.harmonyRepo,
    androidCommit: ctx.paths.androidCommit,
    harmonyCommit: ctx.paths.harmonyCommit,
    androidBranch: ctx.paths.androidBranch,
    harmonyBranch: ctx.paths.harmonyBranch,
    androidModules: ctx.androidModules,
    harmonyModules: ctx.harmonyModules,
    harmonyPrimaryModule: ctx.harmonyPrimaryModule,
    resolveAndroidModulePath: ctx.resolveAndroidModulePath,
    appId: ctx.appId,
    domainId: ctx.domainId,
  }
}

/** Android CodeGraph module 绝对路径（默认项目；多 App 请用 getAppPaths） */
export function resolveAndroidModulePath(modRel) {
  return _defaultCtx.resolveAndroidModulePath(modRel)
}

export function readJson(relFromKb) {
  return JSON.parse(fs.readFileSync(path.join(KB_ROOT, relFromKb), 'utf8'))
}

export function writeJson(relFromKb, data) {
  const full = path.join(KB_ROOT, relFromKb)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, JSON.stringify(data, null, 2) + '\n')
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

export function runCmd(cmd, opts = {}) {
  return execSync(cmd, {
    encoding: 'utf8',
    stdio: opts.stdio || 'pipe',
    env: { ...process.env, CODEGRAPH_NO_WATCHDOG: '1', ...opts.env },
    ...opts,
  })
}
