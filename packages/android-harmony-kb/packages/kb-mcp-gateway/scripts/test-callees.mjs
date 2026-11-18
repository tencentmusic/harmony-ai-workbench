#!/usr/bin/env node
import { kbCodegraphCallees } from '../../../scripts/lib/codegraph-runtime.mjs'
import { pickCodegraphContext } from '../../../scripts/lib/codegraph-app-context.mjs'
import { runCodegraph } from '../../../scripts/lib/codegraph.mjs'

const cases = [
  { project_id: 'kugou-music', symbol: 'SongMainFragment', module_rel: 'feature/inline/impl_sing' },
  { project_id: 'kugou-live', symbol: 'WeekStarGiftFragment', module_rel: 'fanxingallinone/FABusiness' },
]

for (const c of cases) {
  const r = kbCodegraphCallees(c)
  const ctx = pickCodegraphContext({ project_id: c.project_id })
  const mp = ctx.resolveAndroidModulePath(c.module_rel)
  let rawLen = 'n/a'
  try {
    const out = runCodegraph(`callees "${c.symbol}" -j -l 10`, mp)
    const p = JSON.parse(out)
    rawLen = (p.callees || []).length
  } catch (e) {
    rawLen = `err:${e.message?.slice(0, 80)}`
  }
  console.log(c.project_id, c.symbol, 'wrapper=', r.callees?.length, 'raw=', rawLen, 'query=', r.query_symbol)
}
