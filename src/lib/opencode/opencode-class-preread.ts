import fs from 'node:fs/promises'

import type { AndroidClassIndexItem } from '@/lib/android-class-index'
import { toAndroidWorkspacePath } from '@/lib/android-workspace-path'

const DEFAULT_MAX_LINES = 200
const DEFAULT_MAX_FILES = 1
const DEFAULT_MAX_CHARS = 8_000

function isPrereadEnabled() {
  const raw = String(process.env.ANDROID_CLASS_PREREAD ?? '1').trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}

function getMaxLines() {
  const n = Number(process.env.ANDROID_CLASS_PREREAD_LINES || DEFAULT_MAX_LINES)
  return Number.isFinite(n) && n > 0 ? Math.min(500, Math.floor(n)) : DEFAULT_MAX_LINES
}

function getMaxFiles() {
  const n = Number(process.env.ANDROID_CLASS_PREREAD_MAX_FILES || DEFAULT_MAX_FILES)
  return Number.isFinite(n) && n > 0 ? Math.min(5, Math.floor(n)) : DEFAULT_MAX_FILES
}

function getMaxChars() {
  const n = Number(process.env.ANDROID_CLASS_PREREAD_MAX_CHARS || DEFAULT_MAX_CHARS)
  return Number.isFinite(n) && n > 500 ? Math.min(50_000, Math.floor(n)) : DEFAULT_MAX_CHARS
}

function workspacePathFromRow(row: AndroidClassIndexItem) {
  return toAndroidWorkspacePath(row.relativePath)
}

function codeFenceLang(filePath: string) {
  if (/\.ets$/i.test(filePath)) return 'typescript'
  if (/\.kt$/i.test(filePath)) return 'kotlin'
  return 'java'
}

export async function readAndroidClassSourceSnippet(
  filePath: string,
  maxLines = getMaxLines(),
): Promise<{ workspacePath: string; body: string } | null> {
  const abs = String(filePath || '').trim()
  if (!abs) return null
  try {
    const raw = await fs.readFile(abs, 'utf8')
    const lines = raw.split(/\r?\n/)
    const head = lines.slice(0, maxLines)
    let body = head.join('\n')
    let truncated = lines.length > maxLines
    const maxChars = getMaxChars()
    if (body.length > maxChars) {
      body = `${body.slice(0, maxChars)}\n…`
      truncated = true
    } else if (truncated) {
      body = `${body}\n\n…（后续 ${lines.length - maxLines} 行未展示，可用 read 继续）`
    }
    const rel = abs.replace(/\\/g, '/')
    const marker = '/android-src/'
    const idx = rel.indexOf(marker)
    const workspacePath =
      idx >= 0 ? rel.slice(idx + 1) : rel.includes('android-src/') ? rel.split('android-src/').pop()! : abs
    return {
      workspacePath: workspacePath.startsWith('android-src/') ? workspacePath : `android-src/${workspacePath}`,
      body,
    }
  } catch {
    return null
  }
}

export async function buildClassSourcePrereadDirective(rows: AndroidClassIndexItem[]): Promise<string> {
  if (!isPrereadEnabled() || !rows.length) return ''

  const seen = new Set<string>()
  const snippets: Array<{ workspacePath: string; body: string; lang: string }> = []

  for (const row of rows) {
    if (snippets.length >= getMaxFiles()) break
    const key = String(row.filePath || row.relativePath || '').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    const snippet = await readAndroidClassSourceSnippet(row.filePath)
    if (!snippet) continue
    snippets.push({
      workspacePath: workspacePathFromRow(row),
      body: snippet.body,
      lang: codeFenceLang(row.filePath || row.relativePath),
    })
  }

  if (!snippets.length) return ''

  const lines = [
    '[工台预读源码 — 索引命中]',
    '以下内容已由 BFF 读取，**可直接基于预读分析**；无需再 glob/read 这些主文件。',
    '回复用户时仍须总结、不得大段贴源码。',
    '',
  ]

  for (const item of snippets) {
    lines.push(`### ${item.workspacePath}`)
    lines.push('```' + item.lang)
    lines.push(item.body)
    lines.push('```')
    lines.push('')
  }

  return `${lines.join('\n')}\n\n`
}
