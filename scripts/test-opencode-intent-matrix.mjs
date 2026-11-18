#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  classifyOpencodeIntent,
  isWorkbenchCodeQuestion,
} from '../src/lib/opencode/opencode-intent.ts'

const mustConcept = ['ArkTS 里 @State 是什么', 'HarmonyOS 的 ArkUI 语法是什么']
for (const q of mustConcept) {
  const p = classifyOpencodeIntent(q)
  assert.equal(p.intent, 'concept_only', `should stay concept: ${q}`)
  assert.equal(p.injectScope, false, `concept should not inject scope: ${q}`)
}

const mustNotConcept = [
  'https://fx.service.kugou.com/fxservice/rewardservice/getHeadline 接口在安卓端是如何自动更新的？',
  'getHeadline 接口作用是什么',
  'fxservice getHeadline 更新频率',
  '接口更新频率是多少',
  '这个接口谁调的',
  '奖励头条展示逻辑',
  '页面什么时候拉取数据',
  '定时任务在哪里',
  '默认 URL 是什么',
  '代码里怎么写的',
  '项目里有没有实现',
  'feature/inline 模块在哪',
  '请分析 SongBannerFragment 的调用链',
  'fa_default_medal 原图',
  '这个业务调用什么接口 URL',
  '唱模块排行榜逻辑',
]

for (const q of mustNotConcept) {
  const p = classifyOpencodeIntent(q)
  assert.notEqual(p.intent, 'concept_only', `must not be concept_only: ${q} -> ${p.intent}`)
  assert.equal(p.injectScope, true, `should inject scope: ${q}`)
}

assert.equal(isWorkbenchCodeQuestion('getHeadline 接口作用是什么'), true)
assert.equal(isWorkbenchCodeQuestion('ArkTS 里 @State 是什么'), false)

console.log('test-opencode-intent-matrix: ok')
