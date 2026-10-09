import { describe, expect, it } from 'vitest'
import { CallId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent, type SurfaceOp } from '@deepseek-ai/dsh-session'
import { continuationNoteText, continuationSeedOf, SESSION_IMPORT_PLUGIN } from '../src/continuation.ts'
import { createContextFixture, FOREIGN_TEXT } from './import-fixture.ts'

const MARKER = {
  type: 'import/record', seq: 0, time: 5,
  data: { source: { format: 'official-v4', artifactName: 'a.jsonl', sessionId: 'official-1' }, posture: { supervisionMode: 'supervised' } },
} as const satisfies SessionEvent

function user(seq: number, text: string): SessionEvent {
  return { type: 'user/message', seq, time: 10 + seq, surfaceOp: 'append', data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }) }
}

function assistant(
  seq: number, turn: number, content: Parameters<typeof createAssistantMessage>[0]['content'],
  extra: { surfaceOp: SurfaceOp; sourceEventSeqs?: number[] } = { surfaceOp: 'append' },
): SessionEvent {
  return {
    type: 'assistant/message', seq, time: 10 + seq, ...extra,
    data: { turn, step: 1, message: createAssistantMessage({ content, source: { provider: 'deepseek', model: 'deepseek-chat' } }) },
  }
}

describe('continuation seed of an imported archive', () => {
  it('drops the marker and archive notice, opens with the origin note, and keeps the title', async () => {
    const f = await createContextFixture()
    try {
      const imported = await f.importer.import({ artifact: Buffer.from(FOREIGN_TEXT), cwd: f.root })
      const archive = await f.loadedSession(imported.sessionId)
      const seed = continuationSeedOf(archive.events)
      expect(seed.map(event => event.seq)).toEqual(seed.map((_event, index) => index))
      expect(seed.some(event => event.type === 'import/record')).toBe(false)
      const session = Session.create(SessionId('continuation'), seed)
      const messages = session.deriveMessages()
      expect(messages[0]).toMatchObject({
        source: { kind: 'plugin', plugin: SESSION_IMPORT_PLUGIN },
        content: [{ type: 'text', text: continuationNoteText('/foreign/home') }],
      })
      expect(JSON.stringify(messages)).toContain('Summarize the repo.')
      expect(JSON.stringify(messages)).not.toContain('This session cannot execute')
      expect(messages.filter(message => message.source.kind === 'plugin')).toHaveLength(1)
    } finally { await f.dispose() }
  })

  it('phrases the origin note with and without a recorded working directory', () => {
    expect(continuationNoteText('/home/a b')).toBe('The conversation history below was imported from an official DeepSeek Harness session that ran in "/home/a b". It was mapped lossily: system prompts, compaction summaries, and non-text content are omitted, and its tool calls ran in that environment, so files and state they describe may differ now.')
    expect(continuationNoteText(undefined)).toBe('The conversation history below was imported from an official DeepSeek Harness session. It was mapped lossily: system prompts, compaction summaries, and non-text content are omitted, and its tool calls ran in that environment, so files and state they describe may differ now.')
  })

  it('answers unanswered tool requests inside their step and renumbers later surface references', () => {
    const archive: SessionEvent[] = [
      MARKER,
      { type: 'turn/start', seq: 1, time: 11, data: { turn: 1 } },
      user(2, 'first'),
      { type: 'step/start', seq: 3, time: 13, data: { turn: 1, step: 1 } },
      assistant(4, 1, [{ type: 'tool-call', id: CallId('call-lost'), name: 'read', arguments: '{}' }]),
      { type: 'step/end', seq: 5, time: 15, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 6, time: 16, data: { turn: 1, reason: { kind: 'interrupted' } } },
      { type: 'turn/start', seq: 7, time: 17, data: { turn: 2 } },
      user(8, 'second'),
      { type: 'step/start', seq: 9, time: 19, data: { turn: 2, step: 1 } },
      assistant(10, 2, [{ type: 'text', text: 'draft' }]),
      assistant(11, 2, [{ type: 'text', text: 'final' }], { surfaceOp: { op: 'replace', start: 10, end: 10 }, sourceEventSeqs: [10] }),
      { type: 'step/end', seq: 12, time: 22, data: { turn: 2, step: 1 } },
      { type: 'turn/end', seq: 13, time: 23, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    const seed = continuationSeedOf(archive)
    expect(seed.map(event => event.type)).toEqual([
      'user/message', 'turn/start', 'user/message', 'step/start', 'assistant/message',
      'tool/result', 'step/end', 'turn/end',
      'turn/start', 'user/message', 'step/start', 'assistant/message', 'assistant/message', 'step/end', 'turn/end',
    ])
    expect(seed[5]).toMatchObject({ type: 'tool/result', data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'call-lost' } } } })
    expect(seed[12]).toMatchObject({ seq: 12, surfaceOp: { op: 'replace', start: 11, end: 11 }, sourceEventSeqs: [11] })
    const messages = Session.create(SessionId('continuation'), seed).deriveMessages()
    expect(JSON.stringify(messages)).toContain('final')
    expect(JSON.stringify(messages)).not.toContain('draft')
  })

  it('refuses ordinary sessions and references to dropped events', () => {
    expect(() => continuationSeedOf([user(0, 'native')])).toThrow(new TypeError('only an imported archival session can be continued'))
    const dangling = [MARKER, { ...user(1, 'x'), sourceEventSeqs: [0] } as SessionEvent]
    expect(() => continuationSeedOf(dangling)).toThrow(new TypeError('continuation seed cannot reference dropped event 0'))
  })

  it('skips only the importer notice among plugin messages', () => {
    const notice: SessionEvent = {
      type: 'user/message', seq: 2, time: 12, surfaceOp: 'append',
      data: createUserMessage({ source: { kind: 'plugin', plugin: SESSION_IMPORT_PLUGIN }, content: [{ type: 'text', text: 'archive notice' }] }),
    }
    const context: SessionEvent = {
      type: 'user/message', seq: 1, time: 11, surfaceOp: 'append',
      data: createUserMessage({ source: { kind: 'plugin', plugin: 'runtime-context' }, content: [{ type: 'text', text: 'context' }] }),
    }
    const seed = continuationSeedOf([MARKER, context, notice])
    expect(seed).toHaveLength(2)
    expect(JSON.stringify(seed[1])).toContain('context')
    expect(seed[0]?.time).toBe(5)
  })
})
