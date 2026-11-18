#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  buildModuleCodegraphConfig,
  formatCodegraphConfigJson,
  loadCodegraphConfigTemplate,
} from '../scripts/lib/codegraph-config.mjs'
import { loadAppCodeModules } from '../scripts/lib/app-code-modules.mjs'

const modulesConfig = loadAppCodeModules({ reload: true })
const demo = modulesConfig.apps.find((app) => app.project_id === 'demo-project')
assert.ok(demo, 'demo-project module configuration')
assert.equal(demo.platforms.android.codegraph_config, 'config/codegraph/demo-android.codegraph.json')
assert.equal(demo.platforms.harmonyos.codegraph_config, 'config/codegraph/demo-harmony.codegraph.json')
assert.equal(demo.platforms.android.domains[0].modules[0].path, 'src')
assert.equal(demo.platforms.harmonyos.domains[0].modules[0].path, 'entry')

const androidTpl = loadCodegraphConfigTemplate('config/codegraph/demo-android.codegraph.json')
const harmonyTpl = loadCodegraphConfigTemplate('config/codegraph/demo-harmony.codegraph.json')

const commonCfg = buildModuleCodegraphConfig(androidTpl, 'src')
assert.deepEqual(commonCfg.include, ['**'])
assert.ok(commonCfg.exclude.includes('**/build/**'))
assert.equal(commonCfg.includeIgnored, undefined)

const harmonyCfg = buildModuleCodegraphConfig(harmonyTpl, 'entry')
assert.deepEqual(harmonyCfg.include, ['**'])
assert.ok(harmonyCfg.exclude.includes('**/oh_modules/**'))

const json = formatCodegraphConfigJson(commonCfg)
assert.ok(json.includes('"include"'))
assert.ok(json.endsWith('\n'))

console.log('test-codegraph-config: ok')
