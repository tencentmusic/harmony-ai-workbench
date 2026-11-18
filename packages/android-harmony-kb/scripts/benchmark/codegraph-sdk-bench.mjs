#!/usr/bin/env node
/**
 * 对比 SDK 缓存 vs CLI 的 L2 耗时（本地 smoke）
 */
import { getCodegraphCacheStats } from '../lib/codegraph-cache.mjs'
import { kbCodegraphSearch, kbCodegraphCallers } from '../lib/codegraph-runtime.mjs'

async function bench(label, fn) {
  const t0 = Date.now()
  const r = await fn()
  console.log(label, 'ms', Date.now() - t0, 'count', r.hits?.length ?? r.callers?.length ?? 0)
  return r
}

console.log('cache', getCodegraphCacheStats())

await bench('search SongsNewRecFragment (all modules)', () =>
  kbCodegraphSearch({ query: 'SongsNewRecFragment', platform: 'android', project_id: 'kugou-music' }),
)
await bench('search SongsNewRecFragment (warm)', () =>
  kbCodegraphSearch({ query: 'SongsNewRecFragment', platform: 'android', project_id: 'kugou-music' }),
)
await bench('callers SongsNewRecFragment (all modules)', () =>
  kbCodegraphCallers({ symbol: 'SongsNewRecFragment', platform: 'android', project_id: 'kugou-music' }),
)
await bench('callers SongsNewRecFragment (warm)', () =>
  kbCodegraphCallers({ symbol: 'SongsNewRecFragment', platform: 'android', project_id: 'kugou-music' }),
)

console.log('cache after', getCodegraphCacheStats())
