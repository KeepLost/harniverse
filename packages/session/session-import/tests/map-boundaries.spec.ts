import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { parseForeignSessionLog, type ForeignRawEvent } from '../src/foreign.ts'
import { mapForeignSessionEvents, scheduleImportEvents } from '../src/map.ts'
import { FOREIGN_TEXT } from './import-fixture.ts'

const log = parseForeignSessionLog(FOREIGN_TEXT)
const map = (events: readonly ForeignRawEvent[]) => mapForeignSessionEvents({ ...log, events }, 1000)
const marker = { type: 'import/record', time: 1, data: { source: { format: 'official-v3', artifactName: 'source.jsonl' }, posture: { supervisionMode: 'supervised' } } } as const
function edited(index: number, patch: Record<string, unknown>): ForeignRawEvent[] {
  return log.events.map((event, i) => i === index ? { ...event, data: { ...event.data as Record<string, unknown>, ...patch } } : event)
}
function messagePatch(index: number, patch: Record<string, unknown>): ForeignRawEvent[] {
  const data = log.events[index]!.data as { message: Record<string, unknown> }
  return edited(index, { message: { ...data.message, ...patch } })
}

describe('foreign mapping boundaries', () => {
  it('settles empty or entirely unsupported history without inventing turns', () => {
    expect(map([])).toEqual({ events: [], skipped: 0 })
    expect(map([{ seq: 0, type: null, time: null, data: null }])).toEqual({ events: [], skipped: 1 })
  })

  it.each([undefined, -1, 1.5, '10'])('uses the fallback for invalid event time %j', (time) => {
    expect(map([{ ...log.events[1]!, time }]).events[0]).toMatchObject({ time: 1000 })
  })

  it('keeps text, reasoning and nested results while making malformed blocks visibly lossy', () => {
    const content = [null, [], { type: 'reasoning', text: 'thinking' },
      { type: 'tool-result', toolCallId: 'nested', content: null, isError: true },
      { type: 'tool-result', toolCallId: 'ok', content: [{ type: 'text', text: 'done' }] },
      { type: 'tool-result', toolCallId: 1 }, { type: 'tool-call', id: 'call' }, {},
      { type: 'text', text: 1 }]
    const result = map(edited(1, { content, source: {} })).events[1]
    expect(result).toMatchObject({ data: { source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-session-import' }, content: [
      { type: 'text', text: '[imported malformed block omitted]' },
      { type: 'text', text: '[imported malformed block omitted]' },
      { type: 'reasoning', text: 'thinking' },
      { type: 'tool-result', toolCallId: 'nested', isError: true, content: [{ type: 'text', text: '[imported malformed content omitted]' }] },
      { type: 'tool-result', toolCallId: 'ok', content: [{ type: 'text', text: 'done' }] },
      { type: 'text', text: '[imported tool-result block omitted]' },
      { type: 'text', text: '[imported tool-call block omitted]' },
      { type: 'text', text: '[imported unknown block omitted]' },
      { type: 'text', text: '[imported text block omitted]' },
    ] } })
  })

  it.each([undefined, null, {}, { inputTokens: -1, outputTokens: 0 }, { inputTokens: 1.5, outputTokens: 0 },
    { inputTokens: 1, outputTokens: -1 }, { inputTokens: 1, outputTokens: 0.5 }, { inputTokens: 1, outputTokens: '0' }])(
    'omits invalid usage %j without losing the assistant response', (usage) => {
      const event = map(edited(3, { usage })).events[3]
      expect(event).toMatchObject({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Reading the tree first.' }] } } })
      expect(event!.data).not.toHaveProperty('usage')
    },
  )

  it('preserves valid token counts and interrupted output', () => {
    const usage = { inputTokens: 0, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 2, reasoningTokens: 3 }
    expect(map(edited(3, { usage, interrupted: true })).events[3]).toMatchObject({ data: { usage, interrupted: true } })
    expect(map(edited(3, { usage: { ...usage, cacheReadTokens: -1, cacheWriteTokens: 0.5, reasoningTokens: '3' } })).events[3])
      .toMatchObject({ data: { usage: { inputTokens: 0, outputTokens: 5 } } })
  })

  it.each([true, false])('uses legacy or unknown model provenance (legacy=%s)', (legacy) => {
    const patch = legacy ? { source: {}, provider: 'legacy-provider', model: 'legacy-model' } : { source: {} }
    expect(map(messagePatch(3, patch)).events[3]).toMatchObject({ data: { message: { source: {
      provider: legacy ? 'legacy-provider' : 'unknown', model: legacy ? 'legacy-model' : 'unknown',
    } } } })
  })

  it.each([{ kind: 'future' }, { kind: 'aborted' }, { kind: 'aborted', reason: { kind: 'shutdown' } },
    { kind: 'error', error: {} }])('settles an unsupported reason %j as interrupted', (reason) => {
    expect(map(edited(6, { reason })).events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'interrupted' } } })
  })

  it.each([undefined, null, {}, { kind: 1 }])('refuses an unusable turn-end reason %j', (reason) => {
    expect(() => map(edited(6, { reason }))).toThrow('malformed supported foreign event turn/end')
  })

  it.each([
    ['turn/start', null], ['turn/start', { turn: 0 }], ['turn/start', { turn: 1.5 }],
    ['step/start', { turn: 1 }], ['tool/call', null], ['tool/call', { turn: 0, step: 1 }],
    ['tool/call', { turn: 1, step: 0 }], ['tool/call', { turn: 1, step: 1, callId: 1 }],
    ['tool/call', { turn: 1, step: 1, callId: 'c', name: 1 }],
    ['tool/call', { turn: 1, step: 1, callId: 'c', name: 'tool', arguments: {} }],
  ])('refuses malformed %s payload %j', (type, data) => {
    expect(() => map([{ seq: 0, type, time: 1, data }])).toThrow('malformed supported foreign event')
  })

  it.each([1, 3, 5])('rejects malformed message envelopes at event %i before mapping', (index) => {
    const raw = log.events[index]!
    for (const data of [null, {}, { message: null }]) {
      expect(() => map([{ ...raw, data }])).toThrow('invalid foreign message')
    }
    for (const patch of [{ id: '' }, { id: 1 }, { content: null }, { role: 'system' }, { source: null }]) {
      expect(() => map(index === 1 ? edited(index, patch) : messagePatch(index, patch))).toThrow('invalid foreign message')
    }
  })

  it.each([3, 5])('rejects invalid execution counters at message event %i', (index) => {
    for (const patch of [{ turn: 0 }, { step: 0 }]) {
      expect(() => map(edited(index, patch))).toThrow('malformed supported foreign event')
    }
  })

  it.each([
    { source: {} }, { source: { kind: 'tool', callId: 1 } }, { content: [] }, { content: [null] },
    { content: [{ type: 'text' }] }, { content: [{ type: 'tool-result', toolCallId: 'call-7', content: null }] },
  ])('rejects invalid tool-result framing %j', (patch) => {
    expect(() => map(messagePatch(5, patch))).toThrow('malformed supported foreign event tool/result')
  })

  it.each([undefined, {}, { name: 1, code: 'FAIL' }, { name: 'Failure', code: 1 }, { name: 'Failure', code: 'FAIL' }])(
    'preserves tool failure content and accepts only complete error metadata %j', (error) => {
      const events = messagePatch(5, { content: [{ type: 'tool-result', toolCallId: 'call-7', isError: true, content: [{ type: 'text', text: 'failed' }] }] })
      const raw = events[5]!
      events[5] = { ...raw, data: { ...raw.data as Record<string, unknown>, error } }
      const mapped = map(events).events[5]!
      expect(mapped).toMatchObject({ data: { message: { content: [{ type: 'tool-result', isError: true, content: [{ type: 'text', text: 'failed' }] }] } } })
      expect('error' in mapped.data ? mapped.data.error : undefined).toEqual(error?.name === 'Failure' && error.code === 'FAIL' ? error : undefined)
    },
  )

  it.each([
    ['turn/start', { turn: 2 }, 'turn counters'],
    ['step/start', { turn: 1, step: 1 }, 'step boundaries'],
    ['step/end', { turn: 1, step: 1 }, 'step/end has no matching start'],
    ['turn/end', { turn: 1, reason: { kind: 'completed' } }, 'turn/end has no matching start'],
  ])('refuses unmatched %s', (type, data, error) => {
    expect(() => map([{ seq: 0, type, time: 1, data }])).toThrow(error)
  })

  it.each([3, 4, 5])('refuses execution event %i outside its active turn or step', (index) => {
    expect(() => map([log.events[index]!])).toThrow('outside its turn/step')
    expect(() => map([log.events[0]!, log.events[index]!])).toThrow('outside its turn/step')
  })

  it('closes an interrupted turn before starting its successor', () => {
    expect(map([log.events[0]!, log.events[2]!, { seq: 3, type: 'turn/start', time: 20, data: { turn: 2 } }]).events)
      .toEqual([
        { type: 'turn/start', time: 10, data: { turn: 1 } },
        { type: 'step/start', time: 10, data: { turn: 1, step: 1 } },
        { type: 'step/end', time: 20, data: { turn: 1, step: 1 } },
        { type: 'turn/end', time: 20, data: { turn: 1, reason: { kind: 'interrupted' } } },
        { type: 'turn/start', time: 20, data: { turn: 2 } },
        { type: 'turn/end', time: 20, data: { turn: 2, reason: { kind: 'interrupted' } } },
      ])
  })

  it('turns a replacement of skipped history into a visible append', () => {
    const user = { ...log.events[1]!, surfaceOp: { op: 'replace', start: 0, end: 0 } as const }
    const result = map([{ seq: 0, type: 'system/message', time: 1, data: {} }, user])
    expect(result.skipped).toBe(1)
    expect(result.events[0]).toMatchObject({ type: 'user/message', surfaceOp: 'append' })
    expect(Session.create(SessionId('skipped-replacement'), scheduleImportEvents(marker, result.events)).deriveMessages())
      .toMatchObject([{ content: [{ type: 'text', text: 'Summarize the repo.' }] }])
  })

  it('preserves assistant identity across a content replacement after its step closes', () => {
    const replacement = messagePatch(3, { content: [{ type: 'text', text: 'revised answer' }] })[3]!
    const events = [...log.events.slice(0, 6), { seq: 6, type: 'step/end', time: 11, data: { turn: 1, step: 1 } },
      { ...replacement, seq: 7, surfaceOp: { op: 'replace', start: 3, end: 3 } as const }]
    const mapped = map(events)
    const session = Session.create(SessionId('assistant-rewrite'), scheduleImportEvents(marker, mapped.events))
    expect(session.deriveMessages().filter(message => message.role === 'assistant')).toMatchObject([
      { content: [{ type: 'text', text: 'revised answer' }] },
    ])
    const assistants = mapped.events.filter(event => event.type === 'assistant/message')
    expect(assistants[0]!.data.message.id).toBe(assistants[1]!.data.message.id)
  })

  it('preserves user and assistant identities through surface replacements', () => {
    const user = { ...log.events[1]!, data: { ...log.events[1]!.data as Record<string, unknown>,
      content: [{ type: 'text', text: 'rewritten prompt' }] }, surfaceOp: { op: 'replace', start: 1, end: 1 } as const, seq: 7 }
    const assistant = { ...log.events[3]!, data: { ...log.events[3]!.data as Record<string, unknown>,
      message: { ...(log.events[3]!.data as { message: Record<string, unknown> }).message, content: [{ type: 'text', text: 'rewritten answer' }] } },
    surfaceOp: { op: 'replace', start: 3, end: 3 } as const, seq: 8 }
    const mapped = map([...log.events.slice(0, 4), assistant, ...log.events.slice(4), user])
    const users = mapped.events.filter(event => event.type === 'user/message')
    const assistants = mapped.events.filter(event => event.type === 'assistant/message')
    expect(users).toHaveLength(2)
    expect(assistants).toHaveLength(2)
    expect(users[0]!.data.id).toBe(users[1]!.data.id)
    expect(assistants[0]!.data.message.id).toBe(assistants[1]!.data.message.id)
    expect(users[1]).toMatchObject({ surfaceOp: { op: 'replace' }, sourceEventSeqs: [expect.any(Number)] })
    expect(assistants[1]).toMatchObject({ surfaceOp: { op: 'replace' }, sourceEventSeqs: [expect.any(Number)] })
  })
})
