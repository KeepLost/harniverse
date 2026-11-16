/** The converted-events settle entry: archival posture, content identity, and conflict on re-import. */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { importLineageOf } from '../src/contract.ts'
import { ImportConflictError } from '../src/importer.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createContextFixture } from './import-fixture.ts'

let cleanupRoots: string[] = []

afterEach(async () => {
  for (const root of cleanupRoots) await rm(root, { recursive: true, force: true })
  cleanupRoots = []
})

/** Two settled seed events standing in for one converted conversation. */
function convertedEvents(): SessionEvent[] {
  const user = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  const assistant: SessionEvent = {
    type: 'assistant/message',
    seq: 1,
    time: 1100,
    surfaceOp: 'append',
    data: {
      turn: 1, step: 1,
      message: {
        id: MessageId('site-reply-1'),
        role: 'assistant',
        content: [{ type: 'text', text: 'hi there' }],
        source: { kind: 'model', provider: 'deepseek-chat-export', model: 'deepseek-chat-export' },
      },
    },
  }
  return [
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 1000, surfaceOp: 'append', data: user },
    { type: 'step/start', seq: 2, time: 1000, data: { turn: 1, step: 1 } },
    assistant,
    { type: 'step/end', seq: 4, time: 1100, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 1100, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

describe('settleConverted', () => {
  it('settles a converted conversation under the archival posture with content identity', async () => {
    const fixture = await createContextFixture()
    const destination = join(fixture.root, 'target-workspace')
    await mkdir(destination, { recursive: true })
    cleanupRoots.push(fixture.root)

    const imported = await fixture.importer.settleConverted({
      format: 'deepseek-chat-v3',
      sourceSessionId: 'site-conv-42',
      sourceText: '{"id":"site-conv-42","messages":[...]}',
      title: 'Site conversation',
      events: convertedEvents(),
      artifact: new TextEncoder().encode('{"id":"site-conv-42"}'),
      cwd: destination,
    })

    expect(imported.format).toBe('deepseek-chat-v3')
    expect(imported.title).toBe('Site conversation')
    expect(imported.sessionId.startsWith(importLineageOf('site-conv-42'))).toBe(true)

    const header = (await fixture.persistence.list()).find(candidate => candidate.id === imported.sessionId)
    expect(header).toMatchObject({ id: imported.sessionId, cwd: destination })
    const stored = await fixture.persistence.load(imported.sessionId)
    const events = stored?.events ?? []
    expect(events[0]?.type).toBe('import/record')
    expect((events[0]?.data as { source: { format: string } }).source.format).toBe('deepseek-chat-v3')
    // The settled log ends with the non-executable notice.
    expect(events.at(-1)?.type).toBe('user/message')

    await expect(fixture.importer.settleConverted({
      format: 'deepseek-chat-v3',
      sourceSessionId: 'site-conv-42',
      sourceText: '{"id":"site-conv-42","messages":[...]}',
      events: convertedEvents(),
      artifact: new TextEncoder().encode('{"id":"site-conv-42"}'),
      cwd: destination,
    })).rejects.toBeInstanceOf(ImportConflictError)
  })

  it('refuses a relative destination and an empty event list', async () => {
    const fixture = await createContextFixture()
    cleanupRoots.push(fixture.root)
    await expect(fixture.importer.settleConverted({
      format: 'deepseek-chat-v3', sourceSessionId: 'x', sourceText: 'x', events: convertedEvents(),
      artifact: new Uint8Array(), cwd: 'relative/path',
    })).rejects.toThrow('absolute destination')
    await expect(fixture.importer.settleConverted({
      format: 'deepseek-chat-v3', sourceSessionId: 'x', sourceText: 'x', events: [],
      artifact: new Uint8Array(), cwd: fixture.root,
    })).rejects.toThrow('at least one event')
  })
})
