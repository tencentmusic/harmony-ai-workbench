export const OPENCODE_ASSET_PREFIX = 'opencode-asset:'

export const OPENCODE_ASSET_ROOTS = ['user-uploads/'] as const
const OPENCODE_WORKSPACE_ALIAS_RE = /^[A-Za-z0-9_-]+$/

export const OPENCODE_IMAGE_EXTENSIONS = ['.png', '.webp', '.jpg', '.jpeg', '.gif'] as const

export const OPENCODE_IMAGE_MIMES = new Set([
  'image/png',
  'image/webp',
  'image/jpeg',
  'image/gif',
])

export type OpencodeImageRef = {
  path: string
  mime: string
  alt?: string
}

export type OpencodeFilePartLike = {
  type?: string
  mime?: string
  filename?: string
  url?: string
  source?: {
    type?: string
    path?: string
  }
}

function normalizeSlashes(raw: string) {
  return raw.replace(/\\/g, '/').replace(/^\/+/, '')
}

export function isOpencodeImageMime(mime?: string | null) {
  const value = String(mime || '').trim().toLowerCase()
  return !!value && OPENCODE_IMAGE_MIMES.has(value)
}

export function isAllowedOpencodeAssetPath(rawPath?: string | null): rawPath is string {
  const path = normalizeSlashes(String(rawPath || '').trim())
  if (!path || path.includes('..') || path.startsWith('/')) return false
  if (OPENCODE_ASSET_ROOTS.some((root) => path.startsWith(root))) return true
  const [root] = path.split('/')
  return OPENCODE_WORKSPACE_ALIAS_RE.test(root || '')
}

export function normalizeOpencodeAssetPath(rawPath?: string | null): string | null {
  const path = normalizeSlashes(String(rawPath || '').trim())
  return isAllowedOpencodeAssetPath(path) ? path : null
}

export function isAllowedOpencodeImagePath(rawPath?: string | null): rawPath is string {
  const path = normalizeSlashes(String(rawPath || '').trim())
  if (!isAllowedOpencodeAssetPath(path)) return false
  const lower = path.toLowerCase()
  return OPENCODE_IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

export function normalizeOpencodeImagePath(rawPath?: string | null): string | null {
  const path = normalizeSlashes(String(rawPath || '').trim())
  return isAllowedOpencodeImagePath(path) ? path : null
}

function extractPathFromUrl(rawUrl?: string | null): string | null {
  const url = String(rawUrl || '').trim()
  if (!url) return null

  if (url.startsWith(OPENCODE_ASSET_PREFIX)) {
    return normalizeOpencodeAssetPath(url.slice(OPENCODE_ASSET_PREFIX.length))
  }

  try {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const parsed = new URL(url)
      const fromQuery = parsed.searchParams.get('path')
      if (fromQuery) return normalizeOpencodeAssetPath(fromQuery)
      const pathname = normalizeSlashes(decodeURIComponent(parsed.pathname.replace(/^\/+/, '')))
      return normalizeOpencodeAssetPath(pathname)
    }
  } catch {
    // fall through
  }

  if (url.startsWith('/api/opencode/asset')) {
    try {
      const parsed = new URL(url, 'http://local')
      const fromQuery = parsed.searchParams.get('path')
      if (fromQuery) return normalizeOpencodeAssetPath(fromQuery)
    } catch {
      return null
    }
  }

  return normalizeOpencodeAssetPath(url)
}

export function resolveOpencodeImagePathFromPart(part: OpencodeFilePartLike): string | null {
  if (part.type !== 'file') return null
  if (!isOpencodeImageMime(part.mime)) return null

  const fromSource =
    part.source?.type === 'file' ? normalizeOpencodeImagePath(part.source.path) : null
  if (fromSource) return fromSource

  const fromUrl = extractPathFromUrl(part.url)
  if (fromUrl) return fromUrl

  return normalizeOpencodeImagePath(part.filename)
}

export function resolveOpencodeImageFromPart(part: OpencodeFilePartLike): OpencodeImageRef | null {
  const path = resolveOpencodeImagePathFromPart(part)
  if (!path) return null
  const mime = String(part.mime || '').trim().toLowerCase()
  const alt = String(part.filename || path.split('/').pop() || 'image').trim()
  return { path, mime, alt }
}

export function resolveOpencodeAssetPathFromMarkdownSrc(src?: string | null): string | null {
  const raw = String(src || '').trim()
  if (!raw) return null
  if (raw.startsWith(OPENCODE_ASSET_PREFIX)) {
    return normalizeOpencodeAssetPath(raw.slice(OPENCODE_ASSET_PREFIX.length))
  }
  return extractPathFromUrl(raw)
}

export function dedupeOpencodeImages(items: OpencodeImageRef[]): OpencodeImageRef[] {
  const out: OpencodeImageRef[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const path = normalizeOpencodeImagePath(item.path)
    if (!path || seen.has(path)) continue
    seen.add(path)
    out.push({
      path,
      mime: String(item.mime || '').trim().toLowerCase() || 'application/octet-stream',
      alt: item.alt,
    })
  }
  return out
}

export function parseOpencodeImagesFromMetadata(metadata: unknown): OpencodeImageRef[] {
  if (!metadata || typeof metadata !== 'object') return []
  const images = (metadata as { images?: unknown }).images
  if (!Array.isArray(images)) return []
  const out: OpencodeImageRef[] = []
  for (const row of images) {
    if (!row || typeof row !== 'object') continue
    const path = normalizeOpencodeImagePath((row as { path?: unknown }).path as string)
    if (!path) continue
    out.push({
      path,
      mime: String((row as { mime?: unknown }).mime || '').trim().toLowerCase() || 'application/octet-stream',
      alt: typeof (row as { alt?: unknown }).alt === 'string' ? (row as { alt?: string }).alt : undefined,
    })
  }
  return dedupeOpencodeImages(out)
}

export function mimeFromAssetPath(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.txt') || lower.endsWith('.md')) return 'text/plain; charset=utf-8'
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8'
  if (lower.endsWith('.csv')) return 'text/csv; charset=utf-8'
  if (lower.endsWith('.zip')) return 'application/zip'
  return 'application/octet-stream'
}

/** 从助手正文/backtick/链接里扫描 android-src 图片路径（模型常只写路径不写 markdown） */
const TEXT_ASSET_PATH_RE =
  /(?:opencode-asset:)?([\w-]+\/[\w./+-]+\.(?:png|webp|jpe?g|gif))/gi

export function extractOpencodeImagesFromText(text?: string | null): OpencodeImageRef[] {
  const raw = String(text || '')
  if (!raw) return []
  const out: OpencodeImageRef[] = []
  for (const match of raw.matchAll(TEXT_ASSET_PATH_RE)) {
    const path = normalizeOpencodeImagePath(match[1])
    if (!path) continue
    const alt = path.split('/').pop() || 'image'
    out.push({ path, mime: mimeFromAssetPath(path), alt })
  }
  return dedupeOpencodeImages(out)
}

export function collectOpencodeImages(input: {
  metadata?: unknown
  content?: string | null
  extra?: OpencodeImageRef[]
}): OpencodeImageRef[] {
  return dedupeOpencodeImages([
    ...parseOpencodeImagesFromMetadata(input.metadata),
    ...(input.extra ?? []),
    ...extractOpencodeImagesFromText(input.content),
  ])
}

const MARKDOWN_OPENCODE_IMAGE_RE =
  /!\[[^\]]*]\((?:opencode-asset:[^)\s]+|\/api\/opencode\/asset[^)\s]+)\)/gi

const STANDALONE_ASSET_PATH_LINE_RE =
  /^\s*(?:opencode-asset:)?([\w-]+\/[\w./+-]+\.(?:png|webp|jpe?g|gif))\s*$/gim

/** 顶部附件区已展示图片时，去掉正文里重复的 markdown 图片与裸路径，避免空白占位 */
export function stripOpencodeAssetContentFromMarkdown(text?: string | null): string {
  let out = String(text || '')
  if (!out) return out
  out = out.replace(MARKDOWN_OPENCODE_IMAGE_RE, '')
  out = out.replace(STANDALONE_ASSET_PATH_LINE_RE, '')
  out = out.replace(/\n{3,}/g, '\n\n').trim()
  return out
}
