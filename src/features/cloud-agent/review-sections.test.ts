import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reviewSections } from './review-sections'

test('review sections preserve content, duplicate headings and fenced pseudo headings', () => {
  const content = '# 审核\n\n简介\n\n## 范围\n\n```md\n## 不是标题\n```\n\n## 范围\n\n第二部分\n\n### 子节\n\n内容'
  const sections = reviewSections(content)
  assert.deepEqual(sections.map(s => s.label), ['审核概览', '范围', '范围'])
  assert.equal(new Set(sections.map(s => s.id)).size, 3)
  assert.ok(sections[1].content.includes('## 不是标题'))
  assert.ok(sections[2].content.includes('### 子节'))
  assert.equal(reviewSections('普通内容')[0].content, '普通内容')
})
