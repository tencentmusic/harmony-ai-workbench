#!/usr/bin/env node
import assert from 'node:assert/strict'
import { loadGatewayEnv } from '../lib/load-env.mjs'
import { buildSession } from '../lib/scope-guard.mjs'
import { sourceGrep, sourceRead } from '../lib/l3-source.mjs'

loadGatewayEnv()

const session = buildSession({
  scopes: [
    {
      id: 'KugouPlayer',
      kbProjectId: 'kugou-music',
      workspaceAlias: 'android-src',
      prefixes: ['feature/inline/impl_sing'],
    },
  ],
  allowedKbProjectIds: ['kugou-music'],
})

const withAlias = sourceGrep(session, {
  project_id: 'kugou-music',
  pattern: 'SongMainFragment',
  path_prefix: 'feature/inline/impl_sing',
})
const aliasPrefix = sourceGrep(session, {
  project_id: 'kugou-music',
  pattern: 'SongMainFragment',
  path_prefix: 'android-src/feature/inline/impl_sing',
})
assert.ok(withAlias.match_count > 0, 'plain path_prefix should match')
assert.equal(aliasPrefix.match_count, withAlias.match_count, 'android-src/ path_prefix should strip alias')

const readWithAlias = sourceRead(session, {
  path: 'android-src/feature/inline/impl_sing/src/main/java/com/kugou/ktv/android/song/activity/SongMainFragment.java',
})
const readNoAlias = sourceRead(session, {
  path: 'feature/inline/impl_sing/src/main/java/com/kugou/ktv/android/song/activity/SongMainFragment.java',
})
assert.ok(readWithAlias.total_lines > 0)
assert.equal(readNoAlias.total_lines, readWithAlias.total_lines)

console.log('l3 path normalization test: ok')
