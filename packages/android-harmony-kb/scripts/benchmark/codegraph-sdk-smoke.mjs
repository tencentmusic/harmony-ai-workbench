#!/usr/bin/env node
import pkg from '@colbymchenry/codegraph'
import { resolveProjectPath } from '../lib/codegraph-runtime.mjs'
import { runCodegraph } from '../lib/codegraph.mjs'

const { CodeGraph } = pkg
const p = resolveProjectPath({
  platform: 'android',
  module_rel: 'feature/inline/impl_sing',
  project_id: 'kugou-music',
})
const cg = CodeGraph.openSync(p)
const cls = cg.getNodesByName('SongsNewRecFragment').find((n) => n.kind === 'class')
if (cls) {
  const callers = cg.getCallers(cls.id, 1)
  console.log(
    'lib callers',
    callers.length,
    callers.slice(0, 2).map((c) => ({ name: c.node.name, qn: c.node.qualifiedName })),
  )
}
const out = runCodegraph('callers "SongsNewRecFragment" -j -l 3', p)
const parsed = JSON.parse(out)
console.log('cli callers', (parsed.callers || []).slice(0, 2))
