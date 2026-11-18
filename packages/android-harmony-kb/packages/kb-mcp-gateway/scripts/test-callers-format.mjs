#!/usr/bin/env node
import { pickCodegraphContext } from '../../../scripts/lib/codegraph-app-context.mjs'
import { runCodegraph } from '../../../scripts/lib/codegraph.mjs'

const ctx = pickCodegraphContext({ project_id: 'kugou-music' })
const mp = ctx.resolveAndroidModulePath('feature/inline/impl_sing')

for (const sym of [
  'SongMainFragment',
  'com.kugou.ktv.android.song.activity::SongMainFragment',
  'com.kugou.ktv.android.song.activity.SongMainFragment',
]) {
  try {
    const safe = sym.replace(/"/g, '\\"')
    const out = runCodegraph(`callers "${safe}" -j -l 5`, mp)
    const parsed = JSON.parse(out)
    console.log(sym, '->', (parsed.callers || parsed.results || []).length)
  } catch (e) {
    console.log(sym, 'ERR', e.message?.slice(0, 160))
  }
}
