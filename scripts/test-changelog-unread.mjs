#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  changelogSeenToken,
  isChangelogUnread,
  latestRelease,
} from '../src/lib/changelog-unread.ts'

const releases = [
  {
    version: '1.4.0',
    date: '2026.09.18',
    latest: true,
    items: ['本地开发栈同时启动集成专用 OpenCode（4110）'],
  },
  {
    version: '1.3.0',
    date: '2026.08.21',
    latest: false,
    items: ['新增驻场 MCP 功能'],
  },
]

const latest = latestRelease(releases)
assert.equal(latest?.version, '1.4.0')
const token = changelogSeenToken(latest)
assert.ok(token.includes('1.4.0'))

assert.equal(isChangelogUnread(token, null), true)
assert.equal(isChangelogUnread(token, ''), true)
assert.equal(isChangelogUnread(token, token), false)
assert.equal(isChangelogUnread(token, changelogSeenToken(releases[1])), true)

const appended = {
  ...latest,
  items: [...latest.items, '更新日志有未读内容时，入口显示红点'],
}
assert.equal(isChangelogUnread(changelogSeenToken(appended), token), true)

console.log('test-changelog-unread: ok')
