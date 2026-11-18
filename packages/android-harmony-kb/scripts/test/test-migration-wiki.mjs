#!/usr/bin/env node
/**
 * Smoke test: migration wiki tools + L3 soft warning
 */
import { kbWikiRead, kbWikiSearch } from '../lib/migration-wiki.mjs'
import {
  attachL3Warning,
  markSessionL2,
  sessionHasL2,
} from '../../packages/kb-mcp-gateway/lib/session-l2-tracker.mjs'

const search = kbWikiSearch({ query: '示例搜索', limit: 5 })
if (!search.result_count) throw new Error('search returned no results')
const top = search.results[0]
if (!top.path_hint) throw new Error('search missing path_hint')

const nav = kbWikiRead({ doc_ref: top.doc_ref, source_id: top.source_id, mode: 'nav' })
if (!nav.content) throw new Error('nav read empty')

const harmony = kbWikiRead({ doc_ref: top.doc_ref, source_id: top.source_id, mode: 'harmony-section' })
if (!harmony.content || harmony.content.length < 20) throw new Error('harmony-section empty')

const liveSearch = kbWikiSearch({ query: '示例权限', project_id: 'demo-project', limit: 5 })
if (!liveSearch.result_count) throw new Error('demo migration docs were not indexed')
const liveDoc = kbWikiRead({
  doc_ref: liveSearch.results[0].doc_ref,
  source_id: liveSearch.results[0].source_id,
  project_id: 'demo-project',
  mode: 'nav',
})
if (!liveDoc.title.includes('示例迁移')) throw new Error('demo migration doc read empty')

const session = { mcpSessionId: 'test-session-' + Date.now() }
if (sessionHasL2(session)) throw new Error('expected no L2 yet')
const warned = attachL3Warning({ ok: true, lines: [] }, 'kb_source_read', session)
if (!warned._kb_mcp_warning) throw new Error('expected L3 soft warning')
markSessionL2(session, 'kb_codegraph_search')
if (!sessionHasL2(session)) throw new Error('expected L2 after mark')
const noWarn = attachL3Warning({ ok: true }, 'kb_source_read', session)
if (noWarn._kb_mcp_warning) throw new Error('unexpected warning after L2')

console.log('✓ migration-wiki optimizations ok')
console.log(`  search: ${top.title} @ ${top.path_hint} (parent: ${top.parent_title || '-'})`)
console.log(`  harmony-section chars: ${harmony.content.length}`)
console.log(`  live search: ${liveSearch.results[0].title}`)
