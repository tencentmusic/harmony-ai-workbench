#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { getAgentWorkspaceCwd } from '../src/lib/agent-backend/resolve-backend.ts'
import { saveChatAttachment } from '../src/lib/chat-attachments.ts'

const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'chat-attachments-'))
const originalOpencodeCwd = process.env.OPENCODE_AGENT_CWD

try {
  process.env.OPENCODE_AGENT_CWD = fixtureRoot
  assert.equal(getAgentWorkspaceCwd(), fixtureRoot)

  const bytes = new Uint8Array([137, 80, 78, 71])
  const attachment = await saveChatAttachment({
    tokenId: 'fixture-token',
    name: 'clipboard.png',
    mime: 'image/png',
    bytes,
  })
  assert.equal(attachment.kind, 'image')
  assert.equal(attachment.size, bytes.byteLength)
  assert.match(attachment.path, /^user-uploads\/fixture-token\/.+-clipboard\.png$/)
  assert.deepEqual(await readFile(path.join(fixtureRoot, attachment.path)), Buffer.from(bytes))

  const primaryRoot = path.join(fixtureRoot, 'primary')
  await mkdir(primaryRoot)
  process.env.OPENCODE_AGENT_CWD = primaryRoot
  assert.equal(getAgentWorkspaceCwd(), primaryRoot)

  console.log('test-chat-attachments: ok')
} finally {
  if (originalOpencodeCwd === undefined) delete process.env.OPENCODE_AGENT_CWD
  else process.env.OPENCODE_AGENT_CWD = originalOpencodeCwd
  await rm(fixtureRoot, { recursive: true, force: true })
}
