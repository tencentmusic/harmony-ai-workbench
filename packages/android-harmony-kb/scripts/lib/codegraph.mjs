import fs from 'fs'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import {
  ANDROID_KTV_MODULES,
  HARMONY_KTV_MODULE,
  HARMONY_KTV_MODULES,
  PATHS,
  resolveAndroidModulePath,
  runCmd,
} from './paths.mjs'
import { getCachedCodeGraph, isCodegraphSdkEnabled } from './codegraph-cache.mjs'

function mapSdkNode(node) {
  if (!node) return null
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    language: node.language,
    startLine: node.startLine,
    endLine: node.endLine,
    startColumn: node.startColumn,
    endColumn: node.endColumn,
    docstring: node.docstring,
    visibility: node.visibility,
    isExported: node.isExported,
    isAsync: node.isAsync,
    isStatic: node.isStatic,
    isAbstract: node.isAbstract,
    updatedAt: node.updatedAt,
  }
}

function mapSdkSearchResults(results) {
  if (!Array.isArray(results)) return []
  return results.map((row) => ({
    node: mapSdkNode(row.node || row),
    score: row.score ?? null,
  }))
}

function mapSdkRelationNodes(rows, limit) {
  const out = []
  const seen = new Set()
  for (const row of rows || []) {
    const node = row?.node || row
    if (!node?.name) continue
    const key = node.id || `${node.qualifiedName}:${node.startLine}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      name: node.name,
      kind: node.kind,
      filePath: node.filePath,
      startLine: node.startLine,
      qualifiedName: node.qualifiedName,
    })
    if (out.length >= limit) break
  }
  return out
}

function pickNodeForSymbol(cg, symbol, cgSymbol) {
  const short = simpleName(symbol)
  const wantFqn = String(cgSymbol || '').includes('::') ? cgSymbol : null
  const results = cg.searchNodes(short, { limit: 40 })
  let best = null
  let bestScore = -Infinity
  for (const row of results) {
    const node = row?.node
    if (!node) continue
    let score = Number(row.score || 0)
    if (wantFqn && node.qualifiedName === wantFqn) score += 200
    if (node.name === short) score += 100
    if (node.kind === 'class' || node.kind === 'interface') score += 20
    if (score > bestScore) {
      bestScore = score
      best = node
    }
  }
  return best
}

function sdkQuerySymbol(search, projectPath) {
  const cg = getCachedCodeGraph(projectPath)
  if (!cg) return null
  try {
    return mapSdkSearchResults(cg.searchNodes(String(search || '').trim(), { limit: 40 }))
  } catch {
    return null
  }
}

function sdkGetCallers(symbol, projectPath, limit = 30) {
  const cg = getCachedCodeGraph(projectPath)
  if (!cg) return null
  try {
    const cgSymbol = symbol.includes('.') ? fqnToCodegraphSymbol(symbol) : symbol
    const node = pickNodeForSymbol(cg, symbol, cgSymbol)
    if (!node) return []
    return mapSdkRelationNodes(cg.getCallers(node.id, 1), limit)
  } catch {
    return null
  }
}

function sdkGetCallees(symbol, projectPath, limit = 30) {
  const cg = getCachedCodeGraph(projectPath)
  if (!cg) return null
  try {
    const cgSymbol = symbol.includes('.') ? fqnToCodegraphSymbol(symbol) : symbol.includes('::') ? symbol : simpleName(symbol)
    const node = pickNodeForSymbol(cg, symbol, cgSymbol)
    if (!node) return []

    if (node.kind === 'class' || node.kind === 'interface') {
      const methods = cg
        .getNodesInFile(node.filePath)
        .filter(
          (n) =>
            n.kind === 'method' &&
            n.startLine >= node.startLine &&
            n.endLine <= node.endLine &&
            n.qualifiedName.startsWith(`${node.qualifiedName}::`),
        )
      const merged = []
      for (const method of methods) {
        merged.push(...cg.getCallees(method.id, 1))
        if (merged.length >= limit * 3) break
      }
      return mapSdkRelationNodes(merged, limit)
    }

    return mapSdkRelationNodes(cg.getCallees(node.id, 1), limit)
  } catch {
    return null
  }
}

export { isCodegraphSdkEnabled, getCachedCodeGraph }

const execAsync = promisify(exec)

export function fqnToCodegraphSymbol(fqn) {
  const lastDot = fqn.lastIndexOf('.')
  if (lastDot === -1) return fqn
  return `${fqn.slice(0, lastDot)}::${fqn.slice(lastDot + 1)}`
}

export function simpleName(symbol) {
  if (!symbol) return ''
  const part = symbol.includes('::') ? symbol.split('::').pop() : symbol.split('.').pop()
  return part.replace(/\(\)$/, '')
}

export function runCodegraph(args, projectPath) {
  const p = projectPath.replace(/\\/g, '/')
  const out = runCmd(`codegraph ${args} -p "${p}"`, { stdio: 'pipe' })
  return out
}

/** status 子命令用 positional path，不支持 -p（codegraph 1.5+） */
export function runCodegraphStatusJson(projectPath) {
  const p = projectPath.replace(/\\/g, '/')
  return runCmd(`codegraph status -j "${p}"`, { stdio: 'pipe' }).trim()
}

export function querySymbol(search, projectPath) {
  const sdk = sdkQuerySymbol(search, projectPath)
  if (sdk) return sdk
  try {
    const safe = search.replace(/"/g, '\\"')
    const out = runCodegraph(`query "${safe}" -j`, projectPath)
    return JSON.parse(out)
  } catch {
    return []
  }
}

/** 并行 search 用：优先 SDK 缓存，否则 CLI 子进程 */
export async function querySymbolAsync(search, projectPath) {
  const sdk = sdkQuerySymbol(search, projectPath)
  if (sdk) return sdk
  try {
    const safe = search.replace(/"/g, '\\"')
    const p = projectPath.replace(/\\/g, '/')
    const { stdout } = await execAsync(`codegraph query "${safe}" -j -p "${p}"`, {
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
    return JSON.parse(String(stdout || '').trim())
  } catch {
    return []
  }
}

export function getCallers(symbol, projectPath, limit = 30) {
  const sdk = sdkGetCallers(symbol, projectPath, limit)
  if (sdk) return sdk
  try {
    const safe = String(symbol || '').replace(/"/g, '\\"')
    const out = runCodegraph(`callers "${safe}" -j -l ${limit}`, projectPath)
    const parsed = JSON.parse(out)
    return parsed.callers || parsed.results || []
  } catch {
    return []
  }
}

export function getCallees(symbol, projectPath, limit = 30) {
  const sdk = sdkGetCallees(symbol, projectPath, limit)
  if (sdk) return sdk
  try {
    const safe = symbol.replace(/"/g, '\\"')
    const out = runCodegraph(`callees "${safe}" -j -l ${limit}`, projectPath)
    const parsed = JSON.parse(out)
    return parsed.callees || []
  } catch {
    return []
  }
}

export function resolveAndroidModule(fqn, appPaths) {
  if (!fqn) return null
  const modules = appPaths?.androidModules || ANDROID_KTV_MODULES
  const resolvePath = appPaths?.resolveAndroidModulePath || resolveAndroidModulePath
  const cgSymbol = fqnToCodegraphSymbol(fqn)
  const short = simpleName(fqn)
  for (const modRel of modules) {
    const modulePath = resolvePath(modRel)
    if (!fs.existsSync(path.join(modulePath, '.codegraph'))) continue
    const results = querySymbol(short, modulePath)
    const hit = results.find(
      (r) =>
        r.node?.qualifiedName === cgSymbol ||
        (r.node?.kind === 'class' && r.node?.name === short),
    )
    if (hit) return { modulePath, moduleRel: modRel, node: hit.node }
  }
  return null
}

export function resolveHarmonySymbol(symbol, fileHint, appPaths) {
  const short = simpleName(symbol)
  const harmonyRepo = appPaths?.harmonyRepo || PATHS.harmonyRepo
  const modules = appPaths?.harmonyModules || HARMONY_KTV_MODULES
  for (const modRel of modules) {
    const modulePath = path.join(harmonyRepo, modRel)
    if (!fs.existsSync(path.join(modulePath, '.codegraph'))) continue
    const results = querySymbol(short, modulePath)
    const hit =
      results.find((r) => r.node?.name === short && (!fileHint || r.node?.filePath?.includes(path.basename(fileHint)))) ||
      results.find((r) => r.node?.name === short && (!fileHint || r.node?.file?.includes(path.basename(fileHint)))) ||
      results.find((r) => r.node?.name === short)
    if (hit) return { modulePath, moduleRel: modRel, node: hit.node }
  }
  return null
}

export function absSourcePath(platform, node, modulePath) {
  if (platform === 'harmonyos') {
    if (node?.file) return path.join(PATHS.harmonyRepo, node.file.replace(/\\/g, '/'))
    if (node?.filePath) return path.join(modulePath, node.filePath)
  }
  if (node?.filePath && modulePath) return path.join(modulePath, node.filePath)
  return null
}

function scoreEvidenceLine(line, text, targetName, edgeType) {
  let score = 0
  const trimmed = text.trim()
  if (trimmed.includes(targetName)) score += 10
  if (/new\s+/.test(trimmed) && trimmed.includes(targetName)) score += 20
  if (edgeType === 'call' && /\.\w+\(/.test(trimmed) && trimmed.includes(targetName)) score += 15
  if ((edgeType === 'route' || edgeType === 'host_jump') && /\.\w+\(/.test(trimmed) && trimmed.includes(targetName)) score += 15
  if (edgeType === 'event' && /setKtvNotifyInterface|addKtvNotifyInterface/.test(trimmed)) score += 25
  if (edgeType === 'event' && /\bprivate\b.*NotifyInterface/.test(trimmed)) score -= 20
  if (edgeType === 'compose' && (trimmed.includes('Delegate') || trimmed.includes('Fragment') || trimmed.includes('Store'))) score += 5
  if (trimmed.startsWith('import ')) score -= 30
  if (trimmed.startsWith('//') || trimmed.startsWith('*')) score -= 20
  return score
}

function searchNamesForTarget(toSymbol, edgeType = 'call') {
  const names = new Set()
  for (const part of String(toSymbol).split('/').map((s) => s.trim())) {
    if (part) names.add(simpleName(part))
  }
  if (toSymbol.includes('.')) {
    const parts = toSymbol.split('.')
    names.add(parts[parts.length - 1])
  }
  const primary = simpleName(toSymbol)

  const protocolAliases = {
    GetSongOpusRankProtocol: [
      'GetHotOpusListProtocol',
      'GetHighestScoreOpusListProtocolV2',
      'GetSongRankWeekProtocol',
      'GetLbsSongRankProtocol',
    ],
    RelationFriendRecommendProtocol: ['PlayOpusRecOpusListProtocol'],
    OpusInfoV4Protocol: ['GetOpusInfoV4Protocol'],
  }
  for (const alias of protocolAliases[primary] || []) names.add(alias)

  if (primary.includes('SingerList') && primary.includes('Protocol')) names.add('SingerProtocol')
  if (primary.startsWith('Get') && primary.endsWith('Protocol')) names.add(primary.slice(3))

  if (edgeType === 'event' && primary === 'KtvMiniPlayingBar') {
    names.add('setKtvNotifyInterface')
    names.add('addKtvNotifyInterface')
    names.add('IKtvNotifyInterface')
  }
  if (/specify/i.test(toSymbol)) {
    names.add('fetchQmSpecifySong')
    names.add('fetchSpecifySong')
    names.add('QMSpecifyProtocol')
  }
  return [...names].filter(Boolean)
}

function findBestLineInFile(sourceAbsPath, searchNames, edgeType) {
  let best = null
  for (const name of searchNames) {
    const found = findEvidenceLine(sourceAbsPath, name, edgeType)
    if (found && (!best || found.line)) best = found
  }
  return best
}

function findEvidenceInModule(modulePath, fromRelativeFile, searchNames, edgeType) {
  if (!modulePath || !fs.existsSync(modulePath)) return null
  const fromDir = fromRelativeFile ? path.dirname(fromRelativeFile.replace(/\\/g, '/')) : ''
  let hits = []
  try {
    const pattern = searchNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    const out = runCmd(`rg -n "${pattern}" --glob "*.java" --glob "*.kt" --glob "*.ets" "${modulePath.replace(/\\/g, '/')}"`, {
      stdio: 'pipe',
    })
    hits = out
      .split('\n')
      .filter(Boolean)
      .map((line) => line.replace(/\r$/, ''))
      .map((line) => {
        const m = line.match(/^(.+?):(\d+):(.*)$/)
        if (!m) return null
        return { file: m[1], line: Number(m[2]), text: m[3] }
      })
      .filter(Boolean)
  } catch {
    hits = walkSourceFiles(modulePath).flatMap((file) => {
      const rel = path.relative(modulePath, file).replace(/\\/g, '/')
      const text = fs.readFileSync(file, 'utf8')
      const rows = []
      text.split(/\r?\n/).forEach((row, idx) => {
        if (searchNames.some((n) => row.includes(n))) rows.push({ file, rel, line: idx + 1, text: row })
      })
      return rows
    })
  }

  let best = null
  for (const hit of hits) {
    const rel = hit.rel || path.relative(modulePath, hit.file).replace(/\\/g, '/')
    let score = scoreEvidenceLine(hit.line, hit.text, searchNames[0], edgeType)
    if (fromDir && rel.startsWith(fromDir)) score += 30
    if (rel.includes('/sort/') || rel.includes('/song/') || rel.includes('/search/') || rel.includes('/playopus/')) score += 10
    if (rel.includes('ktvplayingbar') || rel.includes('ktvCommon')) score += 8
    if (hit.text.includes('import ')) score -= 25
    if (!best || score > best.score) best = { ...hit, rel, score }
  }
  if (!best || best.score <= 0) return null
  return { line: best.line, symbol: searchNames[0], file: best.rel, score: best.score }
}

function findEvidenceAcrossAndroidModules(fromRelativeFile, searchNames, edgeType) {
  let best = null
  for (const modRel of ANDROID_KTV_MODULES) {
    const modulePath = resolveAndroidModulePath(modRel)
    if (!fs.existsSync(modulePath)) continue
    const hit = findEvidenceInModule(modulePath, fromRelativeFile, searchNames, edgeType)
    if (hit && (!best || hit.score > best.score)) best = hit
  }
  return best
}

function resolveAndroidNode(symbol) {
  if (!symbol || !symbol.includes('.')) return null
  return resolveAndroidModule(symbol)
}

function walkSourceFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) {
      if (name === 'build' || name === '.codegraph') continue
      walkSourceFiles(p, acc)
    } else if (/\.(java|kt|ets)$/.test(name)) acc.push(p)
  }
  return acc
}

export function findEvidenceLine(sourceAbsPath, targetSymbol, edgeType = 'call') {
  if (!sourceAbsPath || !fs.existsSync(sourceAbsPath)) return null
  const targetName = simpleName(targetSymbol)
  const lines = fs.readFileSync(sourceAbsPath, 'utf8').split(/\r?\n/)
  let best = null
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    if (!text.includes(targetName)) continue
    const score = scoreEvidenceLine(i + 1, text, targetName, edgeType)
    if (!best || score > best.score) {
      best = { line: i + 1, score, text: text.trim().slice(0, 120) }
    }
  }
  if (!best || best.score <= 0) return null
  return { line: best.line, symbol: targetName }
}

export function enrichEdgeEvidence(edge, nodeById, platform, moduleResolver) {
  const fromNode = nodeById.get(edge.from)
  const toNode = nodeById.get(edge.to)
  if (!fromNode || !toNode) return { enriched: false, reason: 'missing_node' }

  const fromSymbol = fromNode.symbol
  const toSymbol = toNode.symbol
  let modulePath = null
  let sourceAbs = null
  let evidenceFile = edge.evidence?.file

  if (platform === 'android') {
    const resolved = moduleResolver(fromSymbol.includes('.') ? fromSymbol : fromNode.symbol)
    if (resolved) {
      modulePath = resolved.modulePath
      sourceAbs = absSourcePath('android', resolved.node, modulePath)
      evidenceFile = resolved.node.filePath.replace(/\\/g, '/')
    }
  } else {
    const resolved = resolveHarmonySymbol(fromSymbol, fromNode.file)
    modulePath = resolved?.modulePath || path.join(PATHS.harmonyRepo, HARMONY_KTV_MODULE)
    sourceAbs = absSourcePath('harmonyos', fromNode, modulePath)
    if (fromNode.file) evidenceFile = path.basename(fromNode.file)
    else if (resolved?.node?.filePath) evidenceFile = path.basename(resolved.node.filePath)
  }

  const names = searchNamesForTarget(toSymbol, edge.type)
  const found = findBestLineInFile(sourceAbs, names, edge.type)
  if (found) {
    return applyEvidence(edge, evidenceFile, found.line, found.symbol, 'source_scan')
  }

  let moduleHit = findEvidenceInModule(modulePath, evidenceFile, names, edge.type)

  if (!moduleHit && platform === 'android') {
    const toResolved = resolveAndroidNode(toSymbol.includes('.') ? toSymbol : toNode.symbol)
    if (toResolved) {
      const toAbs = absSourcePath('android', toResolved.node, toResolved.modulePath)
      const toFile = toResolved.node.filePath.replace(/\\/g, '/')
      const toFound = findBestLineInFile(toAbs, names, edge.type)
      if (toFound) {
        return applyEvidence(edge, toFile, toFound.line, toFound.symbol, 'target_source_scan')
      }
      moduleHit = findEvidenceInModule(toResolved.modulePath, toFile, names, edge.type)
    }
  }

  if (!moduleHit && platform === 'harmonyos') {
    const toAbs = absSourcePath('harmonyos', toNode, modulePath)
    const toFound = findBestLineInFile(toAbs, names, edge.type)
    if (toFound) {
      const toFile = toNode.file ? path.basename(toNode.file) : evidenceFile
      return applyEvidence(edge, toFile, toFound.line, toFound.symbol, 'target_source_scan')
    }
  }

  if (!moduleHit) moduleHit = findEvidenceAcrossAndroidModules(evidenceFile, names, edge.type)

  if (moduleHit) {
    return applyEvidence(edge, moduleHit.file, moduleHit.line, moduleHit.symbol, 'module_scan')
  }

  const cgLine = tryCodegraphCalleeLine(fromSymbol, toSymbol, modulePath, platform)
  if (cgLine) {
    return applyEvidence(edge, evidenceFile, cgLine.line, simpleName(toSymbol), cgLine.via)
  }
  return { enriched: false, reason: 'line_not_found' }
}

function tryCodegraphCalleeLine(fromSymbol, toSymbol, modulePath, platform) {
  if (!modulePath) return null
  const cgFrom =
    platform === 'android' && fromSymbol.includes('.')
      ? fqnToCodegraphSymbol(fromSymbol)
      : simpleName(fromSymbol)
  const callees = getCallees(cgFrom, modulePath, 50)
  const target = simpleName(toSymbol)
  const hit = callees.find((c) => c.name === target || c.name?.includes(target))
  if (hit?.startLine) return { line: hit.startLine, via: 'codegraph_callees' }
  return null
}

function applyEvidence(edge, file, line, symbol, via) {
  const next = {
    ...edge,
    evidence: {
      file: file || edge.evidence?.file || 'unknown',
      line,
      symbol,
    },
    status: 'fact',
    unresolved: false,
  }
  return { enriched: true, edge: next, via }
}

export function countLineEvidence(bundle) {
  const total = bundle.edges?.length || 0
  const withLine = (bundle.edges || []).filter((e) => e.evidence?.line).length
  return { total, withLine, ratio: total ? withLine / total : 0 }
}

export function codegraphStatus(projectPath) {
  try {
    const p = projectPath.replace(/\\/g, '/')
    return runCmd(`codegraph status "${p}"`, { stdio: 'pipe' }).trim()
  } catch (e) {
    return `error: ${e.message}`
  }
}

function readNodeSourceLines(projectPath, node) {
  if (!node?.filePath || !node.startLine || !node.endLine) return null
  const abs = path.join(projectPath, node.filePath)
  if (!fs.existsSync(abs)) return null
  try {
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/)
    return lines.slice(node.startLine - 1, node.endLine).join('\n')
  } catch {
    return null
  }
}

function formatNodeMarkdown(projectPath, node, ctx) {
  const lines = []
  lines.push(`## ${node.name} (${node.kind})`)
  lines.push(`- qualified: \`${node.qualifiedName}\``)
  lines.push(`- file: \`${node.filePath}:${node.startLine}\``)
  if (node.signature) lines.push(`- signature: \`${node.signature}\``)
  if (node.docstring) lines.push(`\n${node.docstring.trim()}\n`)

  const source = readNodeSourceLines(projectPath, node)
  if (source) {
    lines.push('```')
    lines.push(source)
    lines.push('```')
  }

  if (ctx?.incomingRefs?.length) {
    lines.push('\n### Callers')
    for (const ref of ctx.incomingRefs.slice(0, 20)) {
      const n = ref.node
      lines.push(`- ${n.name} (${n.kind}) @ ${n.filePath}:${n.startLine}`)
    }
  }
  if (ctx?.outgoingRefs?.length) {
    lines.push('\n### Callees / References')
    for (const ref of ctx.outgoingRefs.slice(0, 20)) {
      const n = ref.node
      lines.push(`- ${n.name} (${n.kind}) @ ${n.filePath}:${n.startLine}`)
    }
  }
  return lines.join('\n')
}

/** SDK explore：search + 简要上下文，输出 markdown；不可用时返回 null */
export function sdkExploreMarkdown(query, projectPath, maxFiles = 20) {
  const cg = getCachedCodeGraph(projectPath)
  if (!cg) return null
  try {
    const q = String(query || '').trim()
    if (!q) return { text: '', result_count: 0 }
    const limit = Math.max(1, Math.min(Number(maxFiles) || 20, 50))
    const results = cg.searchNodes(q, { limit })
    const sections = []
    for (const row of results.slice(0, limit)) {
      const node = row?.node
      if (!node) continue
      let ctx = null
      try {
        ctx = cg.getContext(node.id)
      } catch {
        ctx = null
      }
      sections.push(formatNodeMarkdown(projectPath, node, ctx))
    }
    const text = [`# Explore: ${q}`, '', `Found ${sections.length} symbols`, '', ...sections].join('\n')
    return { text, result_count: sections.length }
  } catch {
    return null
  }
}

/** SDK node 详情 markdown；不可用时返回 null */
export function sdkNodeMarkdown(target, projectPath) {
  const cg = getCachedCodeGraph(projectPath)
  if (!cg) return null
  try {
    const t = String(target || '').trim()
    if (!t) return { text: '', result_count: 0 }
    const node = pickNodeForSymbol(cg, t, t.includes('.') ? fqnToCodegraphSymbol(t) : null)
    if (!node) return { text: `No node found for: ${t}`, result_count: 0 }
    const ctx = cg.getContext(node.id)
    const text = formatNodeMarkdown(projectPath, node, ctx)
    return { text, result_count: text.trim() ? 1 : 0 }
  } catch {
    return null
  }
}

/** SDK impact JSON；不可用时返回 null */
export function sdkImpactJson(symbol, projectPath, depth = 2, limit = 40) {
  const cg = getCachedCodeGraph(projectPath)
  if (!cg) return null
  try {
    const sym = String(symbol || '').trim()
    if (!sym) return { impacted: [], edges: [] }
    const cgSymbol = sym.includes('.') ? fqnToCodegraphSymbol(sym) : sym
    const node = pickNodeForSymbol(cg, sym, cgSymbol)
    if (!node) return { impacted: [], edges: [] }
    const subgraph = cg.getImpactRadius(node.id, Math.max(1, Math.min(Number(depth) || 2, 5)))
    const impacted = [...(subgraph?.nodes?.values?.() || [])]
      .map((n) => mapSdkNode(n))
      .filter(Boolean)
      .slice(0, limit)
    const edges = (subgraph?.edges || []).slice(0, limit * 2).map((e) => ({
      source: e.source,
      target: e.target,
      kind: e.kind,
      line: e.line ?? null,
    }))
    return { impacted, edges }
  } catch {
    return null
  }
}

/** SDK status JSON；不可用时返回 null */
export function sdkStatusJson(projectPath) {
  const cg = getCachedCodeGraph(projectPath)
  if (!cg) return null
  try {
    const stats = cg.getStats()
    return {
      indexed: true,
      nodeCount: stats.nodeCount,
      edgeCount: stats.edgeCount,
      fileCount: stats.fileCount,
      dbSizeBytes: stats.dbSizeBytes,
      lastIndexedAt: cg.getLastIndexedAt?.() ?? stats.lastUpdated ?? null,
      indexState: cg.getIndexState?.() ?? null,
      indexBuildInfo: cg.getIndexBuildInfo?.() ?? null,
      journalMode: cg.getJournalMode?.() ?? null,
      backend: cg.getBackend?.() ?? null,
    }
  } catch {
    return null
  }
}
