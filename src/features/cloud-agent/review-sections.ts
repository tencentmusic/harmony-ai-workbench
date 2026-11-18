import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { RootContent } from 'mdast'

function label(node: RootContent): string {
  if ('value' in node) return String(node.value)
  if ('children' in node) return node.children.map(child => label(child as RootContent)).join('')
  return ''
}

export function reviewSections(content: string) {
  const tree = unified().use(remarkParse).parse(content)
  const headings = tree.children.filter(node => node.type === 'heading' && node.depth === 2)
  const boundaries = headings.map(node => ({ label: label(node), offset: node.position!.start.offset! }))
  if (!boundaries.length || boundaries[0].offset > 0) boundaries.unshift({ label: '审核概览', offset: 0 })
  return boundaries.map((item, index) => ({ id: `review-section-${index}`, label: item.label,
    content: content.slice(item.offset, boundaries[index + 1]?.offset ?? content.length).trim() })).filter(item => item.content)
}
