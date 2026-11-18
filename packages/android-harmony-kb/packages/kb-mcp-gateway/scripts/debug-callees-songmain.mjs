#!/usr/bin/env node
import { pickCodegraphContext } from '../../../scripts/lib/codegraph-app-context.mjs'
import { runCodegraph, querySymbol } from '../../../scripts/lib/codegraph.mjs'
import { kbCodegraphCallees } from '../../../scripts/lib/codegraph-runtime.mjs'

function testCallees(label, modulePath, variants) {
  console.log(`\n=== ${label} ===`)
  for (const v of variants) {
    const safe = v.replace(/"/g, '\\"')
    try {
      const out = runCodegraph(`callees "${safe}" -j -l 20`, modulePath)
      const parsed = JSON.parse(out)
      const callees = parsed.callees || []
      console.log(`callees("${v}") -> ${callees.length}`, callees.slice(0, 8).map((c) => c.name).join(', '))
    } catch (e) {
      console.log(`callees("${v}") ERR:`, e.message?.slice(0, 120))
    }
  }
}

const musicMp = pickCodegraphContext({ project_id: 'kugou-music' }).resolveAndroidModulePath('feature/inline/impl_sing')
const musicFq = 'com.kugou.ktv.android.song.activity::SongMainFragment'

testCallees('Music SongMainFragment', musicMp, [
  'SongMainFragment',
  musicFq,
  'com.kugou.ktv.android.song.activity.SongMainFragment',
])

const wrapper = kbCodegraphCallees({
  symbol: 'SongMainFragment',
  module_rel: 'feature/inline/impl_sing',
  project_id: 'kugou-music',
})
console.log('\nkbCodegraphCallees wrapper:', wrapper.callees?.length, 'query_symbol=', wrapper.query_symbol, 'cg=', wrapper.cg_symbol)

const liveMp = pickCodegraphContext({ project_id: 'kugou-live' }).resolveAndroidModulePath('fanxingallinone/FABusiness')
testCallees('Live WeekStarGiftFragment', liveMp, [
  'WeekStarGiftFragment',
  'com.kugou.fanxing.allinone.watch.starlight.ui::WeekStarGiftFragment',
])
