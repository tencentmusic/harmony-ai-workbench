#!/usr/bin/env node
import assert from 'node:assert/strict'

import { decodeHarmonyScopedRelativePath } from '../src/lib/harmony-scoped-path.ts'

const liveStorageKey =
  'harmony::KugouLive::Common/src/main/ets/constants/StorageKey.ets#StorageKey'
assert.deepEqual(decodeHarmonyScopedRelativePath(liveStorageKey), {
  scopeId: 'KugouLive',
  repoRelativePath: 'Common/src/main/ets/constants/StorageKey.ets',
})

const playerFragment =
  'harmony::KugouPlayer::feature/search/src/main/ets/pages/SearchSongResultFragment.ets#SearchSongResultFragment'
assert.deepEqual(decodeHarmonyScopedRelativePath(playerFragment), {
  scopeId: 'KugouPlayer',
  repoRelativePath: 'feature/search/src/main/ets/pages/SearchSongResultFragment.ets',
})

assert.equal(decodeHarmonyScopedRelativePath('KugouLive::Common/foo.ets'), null)
assert.equal(decodeHarmonyScopedRelativePath('android-src/foo.java'), null)

console.log('test-android-workspace-path: ok')
