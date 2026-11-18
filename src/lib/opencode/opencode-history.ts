import {
  dedupeOpencodeImages,
  resolveOpencodeImageFromPart,
  type OpencodeFilePartLike,
  type OpencodeImageRef,
} from './opencode-image'

export type OpencodeRestoredMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  images?: OpencodeImageRef[]
}

export type OpencodeMessageRaw = {
  info?: {
    id?: string
    role?: string
    finish?: string
  }
  parts?: Array<OpencodeFilePartLike & { type?: string; text?: string }>
}

export function convertOpencodeMessages(raw: OpencodeMessageRaw[]): OpencodeRestoredMessage[] {
  const out: OpencodeRestoredMessage[] = []
  raw.forEach((m, i) => {
    const role = m.info?.role
    if (role !== 'user' && role !== 'assistant') return
    const text = (m.parts ?? [])
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join('')
      .trim()
    const images = dedupeOpencodeImages(
      (m.parts ?? [])
        .map((p) => resolveOpencodeImageFromPart(p))
        .filter((x): x is OpencodeImageRef => !!x),
    )
    if (!text && !images.length) return
    out.push({
      id: m.info?.id ?? `restored-${i}`,
      role,
      content: text,
      images: images.length ? images : undefined,
    })
  })
  return out
}
