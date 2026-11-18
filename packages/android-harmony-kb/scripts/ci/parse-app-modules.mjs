#!/usr/bin/env node
/**
 * 从 config/app-code-modules.json 输出 module 列表（供 CI matrix / 本地脚本）
 *
 *   node scripts/ci/parse-app-modules.mjs --app kugou-music --domain ktv --platform android
 *   node scripts/ci/parse-app-modules.mjs --app kugou-music --domain ktv --platform android --format json
 */
import {
  getApp,
  listAndroidImplModulePaths,
  listAndroidModulePaths,
  listAndroidOfficialModulePaths,
  listDomainModules,
  loadAppCodeModules,
} from '../lib/app-code-modules.mjs'

function parseArgs(argv) {
  const out = { app: 'kugou-music', domain: 'ktv', platform: 'android', format: 'lines', officialOnly: false, implOnly: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--app') out.app = argv[++i]
    else if (a === '--domain') out.domain = argv[++i]
    else if (a === '--platform') out.platform = argv[++i]
    else if (a === '--format') out.format = argv[++i]
    else if (a === '--official-only') out.officialOnly = true
    else if (a === '--impl-only') out.implOnly = true
  }
  return out
}

const args = parseArgs(process.argv)
const config = loadAppCodeModules()
const app = getApp(config, args.app)

if (args.platform === 'android') {
  const paths = args.implOnly
    ? listAndroidImplModulePaths(config, args.app, args.domain)
    : args.officialOnly
      ? listAndroidOfficialModulePaths(config, args.app, args.domain)
      : listAndroidModulePaths(config, args.app, args.domain)
  if (args.format === 'json') {
    console.log(JSON.stringify(paths))
  } else {
    paths.forEach((p) => console.log(p))
  }
  process.exit(0)
}

if (args.platform === 'harmonyos') {
  const modules = listDomainModules(app, 'harmonyos', args.domain)
  if (args.format === 'json') {
    console.log(JSON.stringify(modules.map((m) => m.path)))
  } else {
    modules.forEach((m) => console.log(m.path))
  }
  process.exit(0)
}

console.error(`unsupported platform: ${args.platform}`)
process.exit(1)
