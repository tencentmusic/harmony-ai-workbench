#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const sourceExtensions = new Set(['.ts', '.tsx', '.mjs', '.js', '.cjs'])
const ignoredDirectories = new Set(['.git', '.next', '.runtime', 'data', 'node_modules'])
const violations = []

function walk(relativeDirectory) {
  const absoluteDirectory = path.join(root, relativeDirectory)
  if (!fs.existsSync(absoluteDirectory)) return []

  const files = []
  for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const relativePath = path.join(relativeDirectory, entry.name)
    if (entry.isDirectory()) files.push(...walk(relativePath))
    else if (sourceExtensions.has(path.extname(entry.name))) files.push(relativePath)
  }
  return files
}

function importsOf(source) {
  const imports = []
  const pattern = /(?:from\s*|import\s*\()(['"])([^'"\n]+)\1/g
  for (const match of source.matchAll(pattern)) imports.push(match[2])
  return imports
}

function reject(file, reason) {
  violations.push(`${file.replaceAll('\\', '/')}: ${reason}`)
}

for (const file of [...walk('src'), ...walk('workers')]) {
  const normalized = file.replaceAll('\\', '/')
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  const imports = importsOf(source)

  if (normalized === 'src/features/chat-workbench/ChatWorkbench.tsx') {
    // Keep CloudAgent's CSS in the dashboard entry, not an optional HMR chunk.
    if (!/import\s*\{\s*CloudAgent\s*\}\s*from\s*['"]@\/features\/cloud-agent\/CloudAgent['"]/.test(source)) {
      reject(file, '云Agent必须静态导入，确保样式随工作台入口加载；挂载仍由菜单控制')
    }
  }

  if (normalized.startsWith('src/features/') || normalized.startsWith('src/shared/')) {
    for (const imported of imports) {
      if (imported.startsWith('@/server/') || imported.includes('/src/server/')) {
        reject(file, `前端代码不得导入服务端模块：${imported}`)
      }
    }
  }

  // Test-only Node imports do not become dependencies of the shared runtime contract.
  if (normalized.startsWith('src/contracts/') && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)) {
    if (/\bprocess\.env\b/.test(source)) reject(file, '共享契约不得读取环境变量')
    for (const imported of imports) {
      if (
        imported.startsWith('@/app/') ||
        imported.startsWith('@/features/') ||
        imported.startsWith('@/server/') ||
        imported.startsWith('node:')
      ) {
        reject(file, `共享契约必须保持运行时中立：${imported}`)
      }
    }
  }

  if (normalized.startsWith('src/server/')) {
    const currentModule = normalized.match(/^src\/server\/modules\/([^/]+)\//)?.[1]
    if (/^\s*['"]use client['"]/m.test(source)) reject(file, '服务端代码不得声明 use client')
    for (const imported of imports) {
      if (imported.startsWith('@/app/') || imported.startsWith('@/features/')) {
        reject(file, `服务端不得反向依赖页面或前端模块：${imported}`)
      }
      const crossModule = imported.match(/^@\/server\/modules\/([^/]+)\/(.+)$/)
      if (
        crossModule &&
        crossModule[1] !== currentModule &&
        !['public', 'worker-public'].includes(crossModule[2])
      ) {
        reject(file, `跨服务端模块只能导入 public.ts：${imported}`)
      }
    }
  }

  if (normalized.startsWith('src/app/api/')) {
    for (const imported of imports) {
      const moduleImport = imported.match(/^@\/server\/modules\/([^/]+)\/(.+)$/)
      if (moduleImport && moduleImport[2] !== 'public') {
        reject(file, `API 入口只能导入模块 public.ts：${imported}`)
      }
    }
  }

  if (normalized.startsWith('workers/')) {
    for (const imported of imports) {
      const moduleImport = imported.match(/^@\/server\/modules\/([^/]+)\/(.+)$/)
      if (moduleImport && !['public', 'worker-public'].includes(moduleImport[2])) {
        reject(file, `Worker 入口只能导入模块公开面：${imported}`)
      }
      if (
        imported.includes('/src/server/modules/') &&
        !imported.endsWith('/public.ts') &&
        !imported.endsWith('/worker-public.ts')
      ) {
        reject(file, `Worker 入口只能导入模块公开面：${imported}`)
      }
    }
  }
}

for (const file of [...walk('src'), ...walk('scripts'), ...walk('workers')]) {
  if (file.replaceAll('\\', '/') === 'scripts/test-architecture.mjs') continue
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  for (const retired of ['src/lib/integration', 'src/lib/repo-sync', 'server/opencode-runtime']) {
    if (source.includes(retired)) reject(file, `仍引用已退役路径：${retired}`)
  }
}

if (violations.length > 0) {
  console.error('架构检查失败：')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exit(1)
}

console.log('架构检查通过')
