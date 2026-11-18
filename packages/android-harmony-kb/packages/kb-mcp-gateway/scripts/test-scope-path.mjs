#!/usr/bin/env node
import assert from 'node:assert/strict'
import { buildSession, findPrefixEntryForWorkspacePath } from '../lib/scope-guard.mjs'

const introspect = {
  tokenId: 'tok_test',
  scopes: [
    {
      id: 'KugouElder',
      kbProjectId: 'kugou-music',
      workspaceAlias: 'android-src',
      prefixes: ['app/elderApp'],
    },
    {
      id: 'KugouPlayer',
      kbProjectId: 'kugou-music',
      workspaceAlias: 'android-src',
      prefixes: ['feature/inline/impl_sing'],
    },
  ],
  allowedKbProjectIds: ['kugou-music'],
}

const session = buildSession(introspect)
const target = 'android-src/feature/inline/impl_sing/src/main/java/com/kugou/ktv/android/song/activity/SongMainFragment.java'

assert.doesNotThrow(() => findPrefixEntryForWorkspacePath(session, target))
const matched = findPrefixEntryForWorkspacePath(session, target)
assert.equal(matched.entry.scopeId, 'KugouPlayer')
assert.match(matched.repoRelative, /^feature\/inline\/impl_sing\//)

assert.throws(
  () => findPrefixEntryForWorkspacePath(session, 'android-src/app/unknownApp/Foo.java'),
  /path_out_of_scope/,
)

console.log('scope-guard multi-app path test: ok')
