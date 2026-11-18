#!/usr/bin/env node
import assert from 'node:assert/strict'
import { augmentOpencodeMessage } from '../src/lib/opencode/opencode-app-scope.ts'
import {
  buildOpencodeSessionContinueText,
  buildWorkbenchRehydrateText,
  resolveOpencodeChatContinuity,
} from '../src/lib/opencode/opencode-session-continuity.ts'

const followUp = '这个Utils类有什么漏洞吗'
const firstQuestion = 'com.kugou.android.ugc.history.Utils 分析下这个类'

const first = await augmentOpencodeMessage(firstQuestion, 'all', ['kugou-music'])
assert.ok(first.text.includes('[工台意图'), 'first turn should inject platform directives')

const continued = await augmentOpencodeMessage(followUp, 'all', ['kugou-music'], [], undefined, {
  opencodeSessionId: 'ses_test_continue_001',
  continuity: 'opencode_session',
})
assert.ok(continued.text.includes('[工台 · OpenCode session 续聊]'), 'session continue marker')
assert.ok(continued.text.includes(followUp), 'session continue keeps user question')
assert.ok(!continued.text.includes('[工台意图'), 'session continue must not re-inject intent block')

const continuedWithNewClass = await augmentOpencodeMessage(
  'com.kugou.fanxing.core.widget.Utils 分析下这个类',
  'KugouLive',
  ['KugouLive'],
  [{ fqn: 'com.kugou.fanxing.core.widget.Utils', module: 'app_fanxingv2' }],
  undefined,
  {
    opencodeSessionId: 'ses_test_continue_001',
    continuity: 'opencode_session',
  },
)
assert.ok(continuedWithNewClass.text.includes('[工台 · 续聊中新类目标]'))
assert.ok(continuedWithNewClass.text.includes('[工台意图'), 'new class in continued session must rerun routing')
assert.ok(continuedWithNewClass.text.includes('module=app_fanxingv2'))
assert.ok(!continuedWithNewClass.text.includes('直接承接上一轮已确定的 FQN'))

const rehydrate = await augmentOpencodeMessage(followUp, 'all', ['kugou-music'], [], undefined, {
  continuity: 'workbench_rehydrate',
  priorMessages: [
    {
      id: 'u1',
      sessionId: 'chat-1',
      role: 'user',
      content: firstQuestion,
      metadata: null,
      createdAt: '2026-08-07T08:16:27.000Z',
    },
    {
      id: 'a1',
      sessionId: 'chat-1',
      role: 'assistant',
      content: '该类是 UGC 历史上传工具类，入口 com.kugou.android.ugc.history.Utils ...',
      metadata: { opencodeSessionId: 'ses_dead' },
      createdAt: '2026-08-07T08:18:08.000Z',
    },
  ],
})
assert.ok(rehydrate.text.includes('[工台 · 工台 chat session 续聊]'), 'rehydrate marker')
assert.ok(rehydrate.text.includes('UGC 历史上传工具类'), 'rehydrate includes prior assistant answer')
assert.ok(!rehydrate.text.includes('[工台意图'), 'rehydrate must not run fresh intent inject')

assert.equal(
  resolveOpencodeChatContinuity({
    priorMessages: [{ id: 'a', sessionId: 'c', role: 'assistant', content: 'x', metadata: null, createdAt: '' }],
    opencodeSessionId: 'ses_alive',
  }),
  'opencode_session',
)
assert.equal(
  resolveOpencodeChatContinuity({
    priorMessages: [{ id: 'a', sessionId: 'c', role: 'assistant', content: 'x', metadata: null, createdAt: '' }],
    opencodeSessionId: null,
  }),
  'workbench_rehydrate',
)

assert.ok(buildOpencodeSessionContinueText(followUp).includes('禁止因当前句未重述类名'))
assert.ok(buildWorkbenchRehydrateText([], followUp).includes('用户问题：'))

console.log('test-opencode-session-continue: ok')
