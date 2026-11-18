#!/usr/bin/env node
import { loadGatewayEnv } from '../lib/load-env.mjs'
import { buildSession } from '../lib/scope-guard.mjs'
import { sourceGrep, sourceRead } from '../lib/l3-source.mjs'
import { findWorkspaceApp, loadWorkspaceConfig } from '@kugou/workspace-config'

loadGatewayEnv()
const workspace = loadWorkspaceConfig()

const introspect = {
  scopes: [
    {
      id: 'KugouElder',
      kbProjectId: 'kugou-music',
      workspaceAlias: 'android-src',
      repoRoot: findWorkspaceApp('KugouElder', workspace)?.android?.path,
      prefixes: ['app/elderApp'],
    },
    {
      id: 'KugouPlayer',
      kbProjectId: 'kugou-music',
      workspaceAlias: 'android-src',
      repoRoot: findWorkspaceApp('KugouPlayer', workspace)?.android?.path,
      prefixes: ['feature/inline/impl_sing'],
    },
    {
      id: 'KugouLive',
      kbProjectId: 'kugou-live',
      workspaceAlias: 'live-src',
      repoRoot: findWorkspaceApp('KugouLive', workspace)?.android?.path,
      prefixes: ['app_fanxingv2', 'fanxingallinone'],
    },
  ],
  allowedKbProjectIds: ['kugou-music', 'kugou-live'],
}

const session = buildSession(introspect)

const musicGrep = sourceGrep(session, {
  project_id: 'kugou-music',
  pattern: 'SongMainFragment',
  path_prefix: 'feature/inline/impl_sing',
})
console.log('music grep:', musicGrep.match_count, musicGrep.matches[0]?.path || 'none')

const musicRead = sourceRead(session, {
  path: 'android-src/feature/inline/impl_sing/src/main/java/com/kugou/ktv/android/song/activity/SongMainFragment.java',
})
console.log('music read:', musicRead.scope_id, musicRead.total_lines > 0 ? 'ok' : 'empty')

try {
  const liveRead = sourceRead(session, {
    path: 'live-src/app_fanxingv2/src/main/AndroidManifest.xml',
  })
  console.log('live read:', liveRead.scope_id, liveRead.total_lines > 0 ? 'ok' : 'empty')
} catch (e) {
  console.log('live read skipped:', e.message)
}

console.log('l3 integration test done')
