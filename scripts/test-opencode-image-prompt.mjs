#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  buildDrawableAgentSearchLines,
  extractDrawableNameHints,
  hasBitmapFilenameHint,
  inferDrawableNamePrefix,
  matchesDrawableResourceName,
  prioritizeDrawableSearchPrefixes,
} from '../src/lib/opencode/opencode-drawable-search-hints.ts'

assert.equal(hasBitmapFilenameHint('btn_titile_back_first_default_theme_1.webp'), true)
assert.equal(hasBitmapFilenameHint('分析 @Foo 的调用链'), false)

const hints = extractDrawableNameHints('你没看到上下文吗？btn_titile_back_first_default_theme_1.webp')
assert.deepEqual(hints, ['btn_titile_back_first_default_theme_1'])

const faHints = extractDrawableNameHints('这个图片fa_default_medal.webp给我返回')
assert.deepEqual(faHints, ['fa_default_medal'])

const fxHints = extractDrawableNameHints('返回 @drawable/fx_living_anim_style1 所有原图')
assert.ok(fxHints.includes('fx_living_anim_style1'))
assert.equal(matchesDrawableResourceName('fx_living_anim_style1_00', 'fx_living_anim_style1'), true)
assert.equal(matchesDrawableResourceName('fx_living_anim_style1_00', 'fx_living_anim_style1_00'), true)

assert.equal(inferDrawableNamePrefix('这个图片fa_default_medal.webp给我返回'), null)
assert.equal(inferDrawableNamePrefix('返回按钮图标'), 'btn_titile_back')

const ordered = prioritizeDrawableSearchPrefixes(['app_fanxingv2', 'fanxingallinone'])
assert.deepEqual(ordered, ['fanxingallinone', 'app_fanxingv2'])

const searchLines = buildDrawableAgentSearchLines(['library/common'], ['btn_titile_back_first_default_theme_1'])
assert.ok(searchLines.some((line) => line.includes('library/common/src/main/res/drawable-<density>/btn_titile_back_first_default_theme_1.webp')))
assert.ok(searchLines.some((line) => line.includes('library/common/**/res/drawable-<density>/btn_titile_back_first_default_theme_1.*')))
assert.ok(searchLines.some((line) => line.includes('brace expansion')))
assert.ok(searchLines.some((line) => line.includes('禁止**只搜 scope 第一个前缀')))

const liveLines = buildDrawableAgentSearchLines(
  ['app_fanxingv2', 'fanxingallinone'],
  ['fa_default_medal'],
  'live-src',
)
assert.ok(
  liveLines.some((line) =>
    line.includes('live-src/fanxingallinone/**/res/drawable-<density>/fa_default_medal.*'),
  ),
)
assert.ok(liveLines.some((line) => line.includes('FABusiness/live/p_fragment')))
assert.ok(liveLines.some((line) => line.includes('live-src/app_fanxingv2/**/res/drawable-<density>/fa_default_medal.*')))

const ktvLines = buildDrawableAgentSearchLines(
  ['app/ktvApp', 'library/ktvCommon', 'feature/inline/impl_ktv'],
  ['btn_playlist_icon'],
)
assert.ok(ktvLines.some((line) => line.includes('library/ktvCommon/**/res/drawable-<density>/btn_playlist_icon.*')))
assert.ok(ktvLines.some((line) => line.includes('middleWareMain')))

console.log('test-opencode-image-prompt: ok')
