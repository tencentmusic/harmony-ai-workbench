import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reviewScrollTarget, activeReviewSection } from './review-scroll'

test('chapter navigation subtracts the measured sticky toolbar from the shared scroll root', () => {
  assert.equal(reviewScrollTarget(300, 800, 50, 40), 998)
  assert.equal(reviewScrollTarget(0, 20, 50, 40), 0)
})

test('chapter follows the shared scroll position and selects the last chapter at the end', () => {
  const sections = [{ id: 'first', top: -30 }, { id: 'second', top: 95 }, { id: 'third', top: 500 }]
  assert.equal(activeReviewSection(sections, 50, 40, false), 'second')
  assert.equal(activeReviewSection(sections, 50, 20, false), 'first')
  assert.equal(activeReviewSection(sections, 50, 40, true), 'third')
  assert.equal(activeReviewSection([], 50, 40, false), undefined)
})
