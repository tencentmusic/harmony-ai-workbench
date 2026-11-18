import type { CloudReview } from '@/contracts/cloud-agent'

export type ReviewFile = CloudReview['files'][number]
export function reviewTitle(kind: CloudReview['kind']) {
  return kind === 'scope' ? '范围与验收审核' : kind === 'visual' ? '实现后视觉验收' : 'UI 基线审核'
}
export type ReviewVisualState = { id: string; baseline?: ReviewFile; prototype?: ReviewFile; render?: ReviewFile }
const kinds: Record<string, keyof Pick<ReviewVisualState, 'baseline' | 'prototype' | 'render'>> = { baselines: 'baseline', prototypes: 'prototype', prototypeRenders: 'render' }
const labels: Record<string, string> = { layoutSpec: '布局说明', visualRegions: '视觉区域与验收依据', baselines: 'Android 基线', prototypes: 'HTML 原型', prototypeRenders: '原型渲染图', androidSources: 'Android 源码依据', baseline: 'Android 基线', prototype: '原型渲染图', harmony: 'Harmony 设备截图', comparison: '视觉对比报告' }
export function reviewFileLabel(file: ReviewFile) {
  const [kind, ...name] = file.label.split('/')
  return `${labels[kind] || kind}${name.length ? ` · ${name.join('/')}` : ''}`
}
export function reviewVisualStates(files: ReviewFile[]): ReviewVisualState[] {
  const states = new Map<string, ReviewVisualState>()
  for (const file of files) {
    const [kind, id] = file.label.split('/')
    if (!id || !kinds[kind]) continue
    const state = states.get(id) || { id }
    state[kinds[kind]] = file
    states.set(id, state)
  }
  return [...states.values()]
}
