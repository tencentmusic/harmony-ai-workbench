#!/usr/bin/env node
import assert from 'node:assert/strict'

const FQN_RE = /(?:^|[\s(@])((?:[A-Za-z_][\w$]*\.){2,}[A-Za-z_][\w$]*)(?=[\s,.，。;；:：!?？)]|$)/g

function extractClassHintsFromMessage(message) {
  const fqns = []
  for (const m of message.matchAll(FQN_RE)) {
    const fqn = String(m[1] || '').trim()
    if (fqn) fqns.push(fqn)
  }
  return [...new Set(fqns)]
}

const msg =
  'com.kugou.ktv.android.playopus.delegate.PlayOpusBottomBarDelegate 这个类明明存在，为什么找不到？'
assert.deepEqual(extractClassHintsFromMessage(msg), [
  'com.kugou.ktv.android.playopus.delegate.PlayOpusBottomBarDelegate',
])

console.log('test-opencode-class-hint: ok')
