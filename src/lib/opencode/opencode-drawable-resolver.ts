import path from 'node:path'

import {
  getAndroidAppScopeById,
  getAndroidAppScopeWorkspaceAlias,
  resolveAndroidAppScopeRepoRoot,
} from '@/lib/android-app-scopes'
import { collectSourceFiles } from '@/lib/index-source-files'
import {
  dedupeOpencodeImages,
  mimeFromAssetPath,
  type OpencodeImageRef,
} from '@/lib/opencode/opencode-image'
import {
  buildDrawableAgentSearchLines,
  extractDrawableNameHints,
  inferDrawableNamePrefix,
  matchesDrawableResourceName,
  prioritizeDrawableSearchPrefixes,
} from '@/lib/opencode/opencode-drawable-search-hints'
import { loadWorkspaceAppsConfig, resolveSharedAndroidMonorepoPath } from '@/lib/workspace-apps-config'

export { extractDrawableNameHints, inferDrawableNamePrefix, matchesDrawableResourceName }

const DRAWABLE_FILE_RE = /\/res\/drawable[^/]*\/.+\.(webp|png|jpe?g|gif)$/i
const DRAWABLE_IMAGE_EXTENSIONS = ['.webp', '.png', '.jpg', '.jpeg', '.gif']
const DRAWABLE_EXT_RE = /\.(webp|png|jpe?g|gif)$/i

const cachedRepoFiles = new Map<string, { expiresAt: number; files: string[] }>()

function resolveScopeRepo(appScopeId?: string) {
  const sid = String(appScopeId || '').trim()
  const scope = getAndroidAppScopeById(sid && sid !== 'all' ? sid : undefined)
  if (scope) {
    try {
      return { repoRoot: resolveAndroidAppScopeRepoRoot(scope), workspaceAlias: getAndroidAppScopeWorkspaceAlias(sid) }
    } catch {
      return null
    }
  }
  const repoRoot = resolveSharedAndroidMonorepoPath(loadWorkspaceAppsConfig())
  if (!repoRoot) return null
  return { repoRoot: path.resolve(repoRoot), workspaceAlias: 'android-src' }
}

async function listRepoDrawableFiles(repoRoot: string, scopePrefixes: string[]) {
  const now = Date.now()
  const cacheKey = `${repoRoot}::${scopePrefixes.join('|') || '.'}`
  const cached = cachedRepoFiles.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return cached.files
  }
  const roots = scopePrefixes.length ? scopePrefixes : ['.']
  const files = await collectSourceFiles(repoRoot, roots, DRAWABLE_IMAGE_EXTENSIONS)
  cachedRepoFiles.set(cacheKey, { expiresAt: now + 60_000, files })
  return files
}

function pathInScope(filePath: string, scopePrefixes: string[]) {
  if (!scopePrefixes.length) return true
  return scopePrefixes.some((p) => {
    const prefix = p.replace(/\/+$/g, '')
    if (prefix === '.') return true
    return filePath === prefix || filePath.startsWith(`${prefix}/`)
  })
}

function drawableBaseName(filePath: string) {
  return path.basename(filePath).replace(DRAWABLE_EXT_RE, '').toLowerCase()
}

function looksLikeAnimationBase(name: string) {
  return !/_\d{2}$/.test(name) && /^(fx_|anim_|ic_.*_anim)/i.test(name)
}

function toWorkspaceAssetPath(relativePath: string, workspaceAlias: string): OpencodeImageRef {
  const rel = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  const alt = path.basename(rel)
  return { path: `${workspaceAlias}/${rel}`, mime: mimeFromAssetPath(rel), alt }
}

export async function resolveDrawableAssetsInScope(
  scopePrefixes: string[],
  opts: { names?: string[]; namePrefix?: string | null; limit?: number; appScopeId?: string } = {},
) {
  const resolved = resolveScopeRepo(opts.appScopeId)
  if (!resolved) return [] as OpencodeImageRef[]

  const files = await listRepoDrawableFiles(resolved.repoRoot, scopePrefixes)
  let candidates = files.filter((f) => DRAWABLE_FILE_RE.test(f))

  candidates = candidates.filter((f) => pathInScope(f, scopePrefixes))

  if (opts.namePrefix) {
    const prefix = opts.namePrefix.toLowerCase()
    candidates = candidates.filter((f) => {
      const base = path.basename(f).replace(DRAWABLE_EXT_RE, '').toLowerCase()
      return base.startsWith(prefix) || base.includes(prefix)
    })
  }

  if (opts.names?.length) {
    candidates = candidates.filter((f) => {
      const base = drawableBaseName(f)
      return opts.names!.some((name) => matchesDrawableResourceName(base, name))
    })
  }

  candidates.sort((a, b) => drawableBaseName(a).localeCompare(drawableBaseName(b)))

  const limit = Math.max(1, Math.min(40, opts.limit ?? 24))
  return dedupeOpencodeImages(candidates.map((f) => toWorkspaceAssetPath(f, resolved.workspaceAlias))).slice(0, limit)
}

export async function buildOpencodeDrawablePresearchDirective(
  message: string,
  scopePrefixes: string[],
  appScopeId?: string,
) {
  const resolved = resolveScopeRepo(appScopeId)
  const workspaceAlias = resolved?.workspaceAlias || 'android-src'
  const names = extractDrawableNameHints(message)
  const namePrefix = names.length ? null : inferDrawableNamePrefix(message)
  if (!names.length && !namePrefix) return { directive: '', images: [] as OpencodeImageRef[] }

  const animationSequence = names.some((n) => looksLikeAnimationBase(n))
  const limit = animationSequence
    ? 24
    : names.length
      ? Math.max(names.length + 2, 8)
      : 20

  const images = await resolveDrawableAssetsInScope(scopePrefixes, {
    names: names.length ? names : undefined,
    namePrefix,
    limit,
    appScopeId,
  })

  if (!images.length) {
    const searchNames = names.length ? names : namePrefix ? [namePrefix] : []
    const orderedPrefixes = prioritizeDrawableSearchPrefixes(scopePrefixes)
    const repoHint = resolved
      ? `工台 git 索引（${resolved.repoRoot.replace(/\\/g, '/')}）未命中；确认 env 指向含该资源的 checkout。`
      : '项目包未配置 Android 源码路径，git 预检索跳过。'
    const lines = [
      '[drawable 预检索 — 工台 git 索引未命中]',
      repoHint,
      '位图不在 L2 CodeGraph 索引内（res/drawable* 内置 ignore）；勿 kb_codegraph_search，须按下列 glob/read 找 webp/png。',
      orderedPrefixes.length
        ? `须在下列 scope 前缀**全部**尝试 glob/read：${orderedPrefixes.slice(0, 8).join('、')}${orderedPrefixes.length > 8 ? `…（共 ${orderedPrefixes.length} 个，见 [应用范围]）` : ''}`
        : 'scope 前缀为空时按 [应用范围] 限定检索。',
      ...buildDrawableAgentSearchLines(scopePrefixes, searchNames, workspaceAlias),
      'animation-list：`@drawable/fx_living_anim_style1` 的位图帧在 `drawable-<density>/fx_living_anim_style1_00.webp` 等；可先 read `drawable/fx_living_anim_style1.xml` 列出帧名。',
      'layout 里 @drawable/xxx 仅为资源名；用户若给出 `xxx.webp` 文件名，按上列 pattern 检索。',
      '',
    ]
    return { directive: lines.join('\n'), images: [] }
  }

  const lines = [
    '[drawable 预检索 — 工台 git 已命中下列位图，必须逐条输出 opencode-asset 图片]',
    ...images.map((img) => `- \`${img.path}\``),
    '对上述每个路径输出：',
    `  \`![文件名](opencode-asset:${workspaceAlias}/.../xxx.webp)\``,
    '禁止只列 @drawable 资源名而不给 opencode-asset 链接。',
    '',
  ]
  return { directive: lines.join('\n'), images }
}
