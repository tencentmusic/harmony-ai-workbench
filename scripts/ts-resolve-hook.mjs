import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcRoot = path.join(repoRoot, 'src')

function resolveCandidate(basePath) {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    path.join(basePath, 'index.ts'),
    path.join(basePath, 'index.js'),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const hit = resolveCandidate(path.join(srcRoot, specifier.slice(2)))
    if (hit) return nextResolve(pathToFileURL(hit).href, context)
  }
  if (specifier.startsWith('.')) {
    const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : repoRoot
    const hit = resolveCandidate(path.resolve(path.dirname(parentPath), specifier))
    if (hit) return nextResolve(pathToFileURL(hit).href, context)
  }
  return nextResolve(specifier, context)
}
