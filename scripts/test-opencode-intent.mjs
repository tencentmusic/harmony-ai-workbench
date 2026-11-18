#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  classifyOpencodeIntent,
  buildL2MandatoryDirective,
  buildL1RegisteredClassDirective,
  buildSelectedKnowledgeDocumentDirective,
  extractClassHintsFromMessage,
  isL1RegisteredClassMatch,
  resolvePlatformSearchPlan,
} from '../src/lib/opencode/opencode-intent.ts'

const off = classifyOpencodeIntent('你好')
assert.equal(off.intent, 'off_topic')
assert.equal(off.injectScope, false)
assert.equal(off.injectKnowledge, false)

const concept = classifyOpencodeIntent('ArkTS 里 @State 是什么')
assert.equal(concept.intent, 'concept_only')
assert.equal(concept.injectScope, false)
assert.equal(concept.fallbackLevel, 'docs_only')

const analyze = classifyOpencodeIntent('请分析 SongBannerFragment 的调用链')
assert.equal(analyze.intent, 'android_analyze')
assert.equal(analyze.injectScope, true)
assert.equal(analyze.injectKnowledge, true)
assert.equal(analyze.fallbackLevel, 'kb_first')
assert.ok(analyze.intentDirective.includes('fallback'))

const simpleClassAnalyze = classifyOpencodeIntent(
  'com.kugou.fanxing.core.widget.Utils 分析下这个类',
  [{ fqn: 'com.kugou.fanxing.core.widget.Utils', module: 'app_fanxingv2' }],
)
assert.equal(simpleClassAnalyze.requireL2BeforeRead, false)
assert.equal(simpleClassAnalyze.injectKnowledge, true)

const classCallChain = classifyOpencodeIntent(
  '分析 com.kugou.fanxing.core.widget.Utils 的调用链',
  [{ fqn: 'com.kugou.fanxing.core.widget.Utils', module: 'app_fanxingv2' }],
)
assert.equal(classCallChain.requireL2BeforeRead, true)
assert.equal(classCallChain.injectKnowledge, true)

assert.deepEqual(
  extractClassHintsFromMessage(
    '分析 com.kugou.fanxing.core.modul.user.ui.UpdateUserInfoActivity#onCreate(Bundle)',
  ),
  ['com.kugou.fanxing.core.modul.user.ui.UpdateUserInfoActivity'],
)

const generate = classifyOpencodeIntent('把 SongBannerFragment 迁移成 ArkTS')
assert.equal(generate.intent, 'harmony_generate')
assert.equal(generate.injectClassHint, true)

const url = classifyOpencodeIntent('这个业务调用什么接口 URL')
assert.equal(url.intent, 'asset_url')
assert.equal(url.injectUrlDirective, true)
assert.equal(url.injectKnowledge, false)

const analyzeFqn = classifyOpencodeIntent(
  '请分析 com.kugou.ktv.android.song.activity.SearchSongFragment 鸿蒙侧有没有对应实现，与 Android 是否一致',
  [{ fqn: 'com.kugou.ktv.android.song.activity.SearchSongFragment' }],
)
assert.equal(analyzeFqn.intent, 'android_analyze')
assert.equal(analyzeFqn.requireL2BeforeRead, true)
assert.equal(analyzeFqn.injectKnowledge, true)
assert.ok(!analyzeFqn.intentDirective.includes('kb_codegraph_status'))
assert.ok(analyzeFqn.intentDirective.includes('独立的 L2 强制块'))
assert.ok(analyzeFqn.intentDirective.includes('grep'))

const l2Block = buildL2MandatoryDirective({
  classHints: ['SearchSongFragment'],
  crossPlatform: true,
})
assert.ok(l2Block.includes('L2 结果不满意'))
assert.ok(l2Block.includes('grep'))

const scopedL2Block = buildL2MandatoryDirective({
  classHints: ['com.kugou.fanxing.core.widget.Utils'],
  projectId: 'kugou-live',
  moduleRel: 'app_fanxingv2',
  sourcePath: 'live-src/app_fanxingv2/src/main/java/com/kugou/fanxing/core/widget/Utils.java',
})
assert.match(scopedL2Block, /module_rel=app_fanxingv2/)
assert.match(scopedL2Block, /禁止.*status\/explore/)
assert.match(scopedL2Block, /只尝试一次/)

const androidDefault = resolvePlatformSearchPlan('SongSquareIndexItemFragment 列表自动刷新机制')
assert.equal(androidDefault.androidFirst, true)
assert.equal(androidDefault.includeHarmony, false)

const dualEnd = resolvePlatformSearchPlan('SongSquareIndexItemFragment 鸿蒙实现方式')
assert.equal(dualEnd.androidFirst, true)
assert.equal(dualEnd.includeHarmony, true)

const l2AndroidFirst = buildL2MandatoryDirective({
  classHints: ['SongSquareIndexItemFragment'],
  message: 'SongSquareIndexItemFragment 列表刷新',
  projectId: 'kugou-live',
})
assert.ok(l2AndroidFirst.includes('默认 Android 优先'))
assert.ok(!l2AndroidFirst.includes('platform=harmonyos + kb_resolve_counterpart') || l2AndroidFirst.includes('先** platform=android'))

const l1First = buildL1RegisteredClassDirective({
  classHints: ['com.kugou.android.ktv.sort.ui.KTVSingerMainSortFragment'],
  featureId: 'ktv.singer.list',
  matchBy: 'fqn',
  projectId: 'kugou-music',
})
assert.ok(l1First.includes('[工台 · L1 已登记类 · 作答顺序]'))
assert.ok(l1First.includes('必须先基于下方 [工台知识库上下文]'))
assert.ok(!l1First.includes('[工台强制 · L2 代码图谱]'))

const selectedDocument = buildSelectedKnowledgeDocumentDirective({
  docPath: 'fxwiki/wiki/features/账号/设置/implementation.md',
  codeMapRefs: [
    'wiki/features/账号/设置/code_map/live_android.md',
    'wiki/features/账号/设置/code_map/live_harmony.md',
  ],
  crossPlatformReady: true,
})
assert.match(selectedDocument, /已选知识文档 · 快速核验/)
assert.match(selectedDocument, /精确源码路径直接 read/)
assert.match(selectedDocument, /禁止 kb_codegraph_\*/)
assert.match(selectedDocument, /不得并行发起多次全模块 CodeGraph/)
assert.match(selectedDocument, /总计最多 4 次 read 工具调用/)
assert.match(selectedDocument, /禁止重读同一文件的重叠区间/)
assert.match(selectedDocument, /不得追加第二批读取/)

assert.equal(
  isL1RegisteredClassMatch({ hit: true, match_by: 'knowledge:symbol' }, 'android_analyze'),
  true,
)
assert.equal(
  isL1RegisteredClassMatch({ hit: true, match_by: 'knowledge:doc_ref' }, 'android_analyze'),
  true,
)
assert.equal(
  isL1RegisteredClassMatch({ hit: true, match_by: 'business_text' }, 'android_analyze'),
  false,
)

const headlineUrl = classifyOpencodeIntent(
  'https://fx.service.kugou.com/fxservice/rewardservice/getHeadline 接口在安卓端是如何自动更新的？',
)
assert.equal(headlineUrl.intent, 'asset_url')
assert.equal(headlineUrl.fallbackLevel, 'index_scoped')
assert.equal(headlineUrl.injectUrlDirective, true)
assert.ok(headlineUrl.intentDirective.includes('代码事实'))
assert.ok(!headlineUrl.intentDirective.includes('禁止 android-src glob'))

console.log('test-opencode-intent: ok')
