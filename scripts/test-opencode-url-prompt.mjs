#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  buildKtvUrlLookupRulesText,
  extractUrlBusinessClassHints,
  extractUrlPathGrepHints,
  KTV_URL_CONTEXT_CLASS_NAMES,
  shouldUseKtvUrlLookup,
} from '../src/lib/ktv-url-lookup.ts'

assert.equal(shouldUseKtvUrlLookup('这个业务调用什么接口 URL'), true)
assert.equal(
  shouldUseKtvUrlLookup(
    'https://fx.service.kugou.com/fxservice/rewardservice/getHeadline 接口在安卓端是如何自动更新的？',
  ),
  true,
)
assert.equal(shouldUseKtvUrlLookup('PlayOpus 用的 ConfigKey 和默认地址'), true)
assert.equal(shouldUseKtvUrlLookup('AccompanySearchTipProtocol 的 ConfigKey 是什么'), true)
assert.equal(shouldUseKtvUrlLookup('帮我查业务接口地址'), true)
assert.equal(shouldUseKtvUrlLookup('分析 @Foo 的调用链'), false)

const hints = extractUrlBusinessClassHints('AccompanySearchTipProtocol 的 ConfigKey 是什么')
assert.deepEqual(hints, ['AccompanySearchTipProtocol'])

const pathHints = extractUrlPathGrepHints(
  'https://fx.service.kugou.com/fxservice/rewardservice/getHeadline 接口在安卓端是如何自动更新的？',
)
assert.ok(pathHints.includes('getHeadline'))
assert.ok(pathHints.includes('rewardservice'))

assert.ok(KTV_URL_CONTEXT_CLASS_NAMES.includes('KtvModuleConfigKeys'))
assert.ok(KTV_URL_CONTEXT_CLASS_NAMES.includes('KtvModuleUrlMgr'))

const rules = buildKtvUrlLookupRulesText()
assert.ok(rules.includes('getKtvConfigUrl'))
assert.ok(rules.includes('KtvModuleConfigKeys'))
assert.ok(rules.includes('android-src'))
assert.ok(rules.includes('禁止仅凭迁移案例'))
assert.ok(rules.includes('以 android-src 为准'))

console.log('test-opencode-url-prompt: ok')
