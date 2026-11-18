import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conclusionItems } from './device-conclusion-presentation'

test('historical joined reasons become distinct records without changing evidence or decisions', () => {
  const reason = '等待验收条件：缺少连续播放证据。; 录屏13失败；恢复条件：提供原媒体；缺少连续播放证据。; 录屏13失败。'
  assert.deepEqual(conclusionItems(reason), ['缺少连续播放证据。', '录屏13失败', '恢复条件：提供原媒体'])
})

test('keeps different attempts, negation, paths and code intact', () => {
  const reason = '录屏13失败；录屏21失败；不能登记 ready\n证据 candidates/build26.md；命令 `echo a; echo b` 失败；https://example.test/a;b?q=1'
  assert.deepEqual(conclusionItems(reason), ['录屏13失败', '录屏21失败', '不能登记 ready', '证据 candidates/build26.md', '命令 `echo a; echo b` 失败', 'https://example.test/a;b?q=1'])
})

test('supports empty and already readable records without inventing a conclusion', () => {
  assert.deepEqual(conclusionItems('  '), [])
  assert.deepEqual(conclusionItems('严格交付门禁通过'), ['严格交付门禁通过'])
  assert.deepEqual(conclusionItems('```sh\necho a; echo b\n```\n保留失败'), ['```sh\necho a; echo b\n```', '保留失败'])
})
