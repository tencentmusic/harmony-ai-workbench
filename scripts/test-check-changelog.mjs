#!/usr/bin/env node
import assert from 'node:assert/strict'
import { checkReleaseNotes } from './check-changelog.mjs'

function sample(overrides = {}) {
  return {
    changelog: {
      releases: [
        {
          version: '1.4.0',
          date: '2026.09.18',
          latest: true,
          items: ['新增集成台本地 OpenCode'],
        },
        {
          version: '1.3.0',
          date: '2026.08.21',
          latest: false,
          items: ['新增驻场 MCP 功能'],
        },
      ],
    },
    packageVersion: '1.4.0',
    ...overrides,
  }
}

assert.doesNotThrow(() => checkReleaseNotes(sample()))

assert.throws(
  () => checkReleaseNotes(sample({ packageVersion: '1.1.0' })),
  /package\.json version 1\.1\.0 必须等于 changelog 最新版本 1\.4\.0/,
)

assert.throws(
  () =>
    checkReleaseNotes(
      sample({
        changelog: {
          releases: [
            { version: '1.4.0', date: '2026.09.18', latest: true, items: ['a'] },
            { version: '1.3.0', date: '2026.08.21', latest: true, items: ['b'] },
          ],
        },
      }),
    ),
  /只能有一条 latest: true/,
)

assert.throws(
  () =>
    checkReleaseNotes(
      sample({
        changelog: {
          releases: [
            { version: '1.3.0', date: '2026.08.21', latest: false, items: ['旧'] },
            { version: '1.4.0', date: '2026.09.18', latest: true, items: ['新'] },
          ],
        },
      }),
    ),
  /latest: true 必须是 releases\[0\]/,
)

assert.throws(
  () =>
    checkReleaseNotes(
      sample({
        changelog: {
          releases: [
            { version: '1.4.0', date: '2026.09.18', latest: true, items: [] },
          ],
        },
      }),
    ),
  /items 不能为空/,
)

assert.throws(
  () =>
    checkReleaseNotes(
      sample({
        changelog: {
          releases: [
            { version: '1.4.0', date: '2026-09-18', latest: true, items: ['a'] },
          ],
        },
      }),
    ),
  /date 必须是 YYYY\.MM\.DD/,
)

console.log('test-check-changelog: ok')
