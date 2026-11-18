/** Legacy conclusions join dependency records with semicolons; keep code and the saved original intact. */
export function conclusionItems(reason: string): string[] {
  const items: string[] = []
  const seen = new Set<string>()
  const delimiters = /(`+)[\s\S]*?\1|；|;(?=\s|$)|\r?\n/g
  let start = 0
  const append = (value: string) => {
    const text = value.trim().replace(/^等待验收条件[：:]\s*/, '')
    const key = text.replace(/[。.]$/, '').trim()
    if (key && !seen.has(key)) { seen.add(key); items.push(text) }
  }
  for (const match of reason.matchAll(delimiters)) {
    if (match[1]) continue
    append(reason.slice(start, match.index))
    start = match.index + match[0].length
  }
  append(reason.slice(start))
  return items
}
