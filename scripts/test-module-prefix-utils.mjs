#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  collectDefaultModulePrefixes,
  isHarmonyScopedModulePrefix,
  parseScopedModulePrefix,
  toHarmonyScopedModulePrefix,
} from '../src/lib/module-prefix-utils.ts'
import { parseScopedModulePrefix as parseScopedModulePrefixPure } from '../src/lib/module-prefix-parse.ts'

const defaults = collectDefaultModulePrefixes()
const harmonyRows = defaults.filter((x) => isHarmonyScopedModulePrefix(x.prefix))
assert.ok(harmonyRows.length >= 10, `expected harmony prefixes, got ${harmonyRows.length}`)

for (const prefix of ['大仓/app/', '大仓/base/', '大仓/component/', '大仓/feature/', '大仓/library/']) {
  assert.ok(defaults.some((x) => x.prefix === prefix), `missing configured monorepo prefix ${prefix}`)
}
assert.ok(defaults.some((x) => x.prefix === 'KugouLive/app_fanxingv2/'))

const playerEntry = defaults.find((x) => x.prefix === 'KugouPlayer/harmony/apps/music/entry/')
assert.ok(playerEntry, 'missing KugouPlayer harmony entry prefix')
assert.ok(playerEntry.note?.includes('harmony-src'), playerEntry.note)

const liveEntry = defaults.find((x) => x.prefix === 'KugouLive/harmony/apps/live/entry/')
assert.ok(liveEntry, 'missing KugouLive harmony entry prefix')
assert.ok(liveEntry.note?.includes('harmony-live-src'), liveEntry.note)

const parsed = parseScopedModulePrefixPure('KugouPlayer/harmony/featrue/ktvallinone/kugou/', {
  projectLabels: { KugouPlayer: '酷狗音乐' },
})
assert.equal(parsed.platform, 'harmony')
assert.equal(parsed.projectId, 'KugouPlayer')
assert.equal(parsed.modulePath, 'featrue/ktvallinone/kugou/')

assert.equal(toHarmonyScopedModulePrefix('KugouPlayer', 'entry'), 'KugouPlayer/harmony/entry/')
assert.equal(toHarmonyScopedModulePrefix('KugouPlayer', '.'), 'KugouPlayer/harmony/')

console.log('test-module-prefix-utils: ok')
