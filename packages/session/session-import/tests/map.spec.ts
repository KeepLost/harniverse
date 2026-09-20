import { describe, expect, it } from 'vitest'
import {
  classifyForeignSessionFormatVersion,
  ForeignLogError,
  mapForeignSessionEvents,
  parseForeignSessionLog,
  parseImportPosture,
  scheduleImportEvents,
} from '../src/index.ts'

function rawEvent(type: string, data: unknown, time = 10): string {
  return JSON.stringify({ seq: 0, type, time, data })
}

const FOREIGN_LOG = [
  JSON.stringify({ version: 3, id: 'foreign-1', createdAt: 1000, cwd: '/foreign/home' }),
  rawEvent('turn/start', { turn: 1 }),
  rawEvent('user/message', {
    id: 'foreign-msg-1',
    role: 'user',
    content: [{ type: 'text', text: 'Summarize the repo.' }],
    source: { kind: 'user' },
  }),
  rawEvent('step/start', { turn: 1, step: 1 }),
  rawEvent('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: 'foreign-msg-2',
      role: 'assistant',
      content: [{ type: 'text', text: 'Reading the tree first.' }],
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
    },
    stream: [{ type: 'text', text: 'ignored' }],
    usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 2 },
  }),
  rawEvent('tool/call', { turn: 1, step: 1, callId: 'call-7', name: 'list_dir', arguments: '{"path":"."}' }),
  rawEvent('tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: 'foreign-msg-3',
      role: 'user',
      callId: 'call-7',
      content: [{ type: 'tool-result', toolCallId: 'call-7', content: [{ type: 'text', text: 'src/\nREADME.md' }] }],
      isError: false,
      source: { kind: 'tool' },
    },
    error: { name: 'FsError', code: 'FS_NOT_FOUND', reason: 'dropped lossily' },
  }),
  rawEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  rawEvent('request/header', { header: {}, reason: 'initial' }),
].join('\n')

describe('parseForeignSessionLog', () => {
  it('splits header and events, ignoring blank lines', () => {
    const log = parseForeignSessionLog(`\n${FOREIGN_LOG}\n\n`)
    expect(log.header.version).toBe(3)
    expect(log.header.createdAt).toBe(1000)
    expect(log.header.cwd).toBe('/foreign/home')
    expect(log.events).toHaveLength(8)
    expect(log.events[0]).toMatchObject({ type: 'turn/start', time: 10 })
  })

  it('keeps unsafe header fields undefined', () => {
    const log = parseForeignSessionLog(JSON.stringify({ version: 1, createdAt: 'yesterday', cwd: 'relative/path' }))
    expect(log.header.createdAt).toBeUndefined()
    expect(log.header.cwd).toBeUndefined()
  })

  it('refuses an empty log', () => {
    expect(() => parseForeignSessionLog('  \n\n')).toThrow(ForeignLogError)
    expect(() => parseForeignSessionLog('')).toThrow('no header line')
  })

  it('refuses a non-object or unparseable header', () => {
    expect(() => parseForeignSessionLog('[1,2]')).toThrow('header must be a JSON object')
    expect(() => parseForeignSessionLog('{oops')).toThrow('header is not valid JSON')
  })

  it('refuses a non-object event line', () => {
    expect(() => parseForeignSessionLog(`${JSON.stringify({ version: 2 })}\n42`)).toThrow('line 2 must be a JSON object')
    expect(() => parseForeignSessionLog(`${JSON.stringify({ version: 2 })}\n{}`)).not.toThrow()
  })
})

describe('mapForeignSessionEvents', () => {
  const log = parseForeignSessionLog(FOREIGN_LOG)
  const mapping = mapForeignSessionEvents(log, 500)

  it('maps the display-bearing vocabulary and counts the rest as skipped', () => {
    expect(mapping.events.map(event => event.type)).toEqual([
      'turn/start',
      'user/message',
      'step/start',
      'assistant/message',
      'tool/call',
      'tool/result',
      'turn/end',
    ])
    expect(mapping.skipped).toBe(1)
  })

  it('rebuilds messages with fresh local identities', () => {
    const user = mapping.events[1]
    if (user?.type !== 'user/message') return
    expect(user.type).toBe('user/message')
    expect(user.data.id).not.toBe('foreign-msg-1')
    expect(user.data.source).toEqual({ kind: 'user' })
    expect(user.data.content).toEqual([{ type: 'text', text: 'Summarize the repo.' }])
    const assistant = mapping.events[3]
    if (assistant?.type !== 'assistant/message') return
    expect(assistant.data.message.source).toEqual({ kind: 'model', provider: 'deepseek', model: 'deepseek-chat' })
    expect(assistant.data.usage).toEqual({ inputTokens: 10, outputTokens: 5, reasoningTokens: 2 })
  })

  it('keeps tool correlation and drops lossy error fields', () => {
    const call = mapping.events[4]
    if (call?.type !== 'tool/call') return
    expect(call.data.callId).toBe('call-7')
    expect(call.data.arguments).toBe('{"path":"."}')
    const result = mapping.events[5]
    if (result?.type !== 'tool/result') return
    expect(result.surfaceOp).toBe('append')
    expect(result.data.message.source).toEqual({ kind: 'tool', callId: 'call-7' })
    expect(result.data.message.content[0]).toMatchObject({ type: 'tool-result', toolCallId: 'call-7' })
    expect(result.data.error).toEqual({ name: 'FsError', code: 'FS_NOT_FOUND' })
  })

  it('falls back to the default time when an event carries none', () => {
    const untimed = parseForeignSessionLog([
      JSON.stringify({ version: 1 }),
      JSON.stringify({ type: 'turn/start', data: { turn: 2 } }),
    ].join('\n'))
    const mapped = mapForeignSessionEvents(untimed, 777)
    expect(mapped.events[0]).toMatchObject({ type: 'turn/start', time: 777, data: { turn: 2 } })
  })
})

describe('mapForeignSessionEvents lossy edges', () => {
  it('placeholders unsupported and malformed blocks', () => {
    const log = parseForeignSessionLog([
      JSON.stringify({ version: 2 }),
      rawEvent('user/message', {
        content: [
          { type: 'text', text: 'see' },
          { type: 'image', attachment: { mediaType: 'image/png' } },
          'not-a-block',
        ],
      }),
    ].join('\n'))
    const [event] = mapForeignSessionEvents(log, 1).events
    expect(event?.type).toBe('user/message')
    if (event?.type !== 'user/message') return
    expect(event.data.content).toEqual([
      { type: 'text', text: 'see' },
      { type: 'text', text: '[imported image block omitted]' },
      { type: 'text', text: '[imported malformed block omitted]' },
    ])
  })

  it('skips turn/end reasons outside the simple native vocabulary', () => {
    const log = parseForeignSessionLog([
      JSON.stringify({ version: 3 }),
      rawEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      rawEvent('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { cause: 'user' } } }),
      rawEvent('turn/end', { turn: 3, reason: { kind: 'error', error: { message: 'boom' } } }),
      rawEvent('turn/end', { turn: 4, reason: 'completed' }),
    ].join('\n'))
    const mapped = mapForeignSessionEvents(log, 1)
    expect(mapped.events).toEqual([{ type: 'turn/end', time: 10, data: { turn: 1, reason: { kind: 'completed' } } }])
    expect(mapped.skipped).toBe(3)
  })

  it('skips message events with unusable payloads', () => {
    const log = parseForeignSessionLog([
      JSON.stringify({ version: 3 }),
      rawEvent('user/message', 'nope'),
      rawEvent('assistant/message', { turn: 1, message: { content: 'not-an-array' } }),
      rawEvent('assistant/message', { turn: -1, step: 1, message: { content: [] } }),
      rawEvent('tool/call', { turn: 1, step: 1, callId: 7, name: 'x', arguments: '{}' }),
      rawEvent('tool/result', { turn: 1, step: 1, message: { callId: 'c', content: [] , isError: true } }),
    ].join('\n'))
    const mapped = mapForeignSessionEvents(log, 1)
    expect(mapped.events.map(event => event.type)).toEqual(['tool/result'])
    expect(mapped.skipped).toBe(4)
  })

  it('defaults unknown assistant provenance and drops unusable usage', () => {
    const log = parseForeignSessionLog([
      JSON.stringify({ version: 3 }),
      rawEvent('assistant/message', { turn: 1, step: 1, message: { content: [], provider: 42 }, usage: 'lots' }),
      rawEvent('assistant/message', {
        turn: 2,
        step: 1,
        interrupted: true,
        message: { content: [{ type: 'text', text: 'partial' }], model: 'm' },
        usage: { inputTokens: '1', outputTokens: 2, cacheReadTokens: 3 },
      }),
    ].join('\n'))
    const mapped = mapForeignSessionEvents(log, 1)
    const [first, second] = mapped.events
    if (first?.type !== 'assistant/message' || second?.type !== 'assistant/message') return
    expect(first.data.message.source).toEqual({ kind: 'model', provider: 'unknown', model: 'unknown' })
    expect(first.data.usage).toBeUndefined()
    expect(second.data.message.source).toEqual({ kind: 'model', provider: 'unknown', model: 'm' })
    expect(second.data.usage).toBeUndefined()
    expect(second.data.interrupted).toBe(true)
  })

  it('placeholders non-array content wholesale', () => {
    const log = parseForeignSessionLog([
      JSON.stringify({ version: 3 }),
      rawEvent('user/message', { content: null }),
    ].join('\n'))
    const [event] = mapForeignSessionEvents(log, 1).events
    if (event?.type !== 'user/message') return
    expect(event.data.content).toEqual([{ type: 'text', text: '[imported malformed content omitted]' }])
  })
})

describe('scheduleImportEvents', () => {
  it('prepends the marker and assigns dense sequence numbers', () => {
    const log = parseForeignSessionLog(FOREIGN_LOG)
    const mapping = mapForeignSessionEvents(log, 500)
    const marker = {
      type: 'import/record' as const,
      time: 1,
      data: {
        source: { format: 'official-v3' as const, artifactName: 'a.source.jsonl' },
        posture: { supervisionMode: 'supervised' as const },
      },
    }
    const events = scheduleImportEvents(marker, mapping.events)
    expect(events[0]).toMatchObject({ seq: 0, type: 'import/record' })
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index))
    expect(events[1]).toMatchObject({ seq: 1, type: 'turn/start' })
  })
})

describe('contract helpers stay re-exported', () => {
  it('classifies and parses posture', () => {
    expect(classifyForeignSessionFormatVersion(2)).toBe('official-v2')
    expect(parseImportPosture(undefined)).toEqual({ supervisionMode: 'supervised' })
    expect(() => parseImportPosture({ supervisionMode: 'nonsense' })).toThrow(TypeError)
  })
})

describe('lossy mapping coverage edges', () => {
  it('covers placeholder and provenance fallbacks', () => {
    const log = parseForeignSessionLog([
      JSON.stringify({ version: 2 }),
      JSON.stringify({ type: 'user/message', time: 'not-a-number', data: {
        content: [
          { type: 42 },
          { type: 'tool-result', toolCallId: 7, content: [] },
          { type: 'tool-result', toolCallId: 'ok-call', content: [{ type: 'text', text: 'inner' }], isError: true },
        ],
      } }),
      JSON.stringify({ type: 'assistant/message', time: 5, data: {
        turn: 1, step: 1,
        message: { content: [], provider: 'top-level', model: 'top-model' },
        usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
      } }),
      JSON.stringify({ type: 'step/start', data: { turn: 1, step: 1 } }),
      JSON.stringify({ type: 'step/end', data: { turn: 1, step: 2 } }),
      JSON.stringify({ type: 'step/start', data: { turn: 1 } }),
      JSON.stringify({ type: 'turn/start', data: 'not-a-record' }),
    ].join('\n'))
    const mapped = mapForeignSessionEvents(log, 42)
    const [user, assistant, stepStart, stepEnd] = mapped.events
    expect(mapped.skipped).toBe(2)
    if (user?.type !== 'user/message') return
    expect(user.time).toBe(42)
    expect(user.data.content).toEqual([
      { type: 'text', text: '[imported unknown block omitted]' },
      { type: 'text', text: '[imported tool-result block omitted]' },
      { type: 'tool-result', toolCallId: 'ok-call', content: [{ type: 'text', text: 'inner' }], isError: true },
    ])
    if (assistant?.type !== 'assistant/message') return
    expect(assistant.data.message.source).toEqual({ kind: 'model', provider: 'top-level', model: 'top-model' })
    expect(assistant.data.usage).toEqual({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 })
    expect(stepStart).toMatchObject({ type: 'step/start', data: { turn: 1, step: 1 } })
    expect(stepEnd).toMatchObject({ type: 'step/end', data: { turn: 1, step: 2 } })
  })

  it('refuses an unparseable event line', () => {
    expect(() => parseForeignSessionLog(`${JSON.stringify({ version: 1 })}\n{"type":`)).toThrow('line 2 is not valid JSON')
  })
})

describe('lossy mapping defensive rejects', () => {
  it('skips events whose records are unusable at each guard', () => {
    const log = parseForeignSessionLog([
      JSON.stringify({ version: 3 }),
      JSON.stringify({ type: 'assistant/message', data: 'nope', time: 1 }),
      JSON.stringify({ type: 'assistant/message', data: { turn: 1, step: 1, message: 42 }, time: 1 }),
      JSON.stringify({ type: 'tool/call', data: 'nope', time: 1 }),
      JSON.stringify({ type: 'tool/call', data: { step: 1, callId: 'c', name: 'n', arguments: '{}' }, time: 1 }),
      JSON.stringify({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'c', name: 7, arguments: '{}' }, time: 1 }),
      JSON.stringify({ type: 'tool/result', data: { turn: 1, step: 1, message: 'nope' }, time: 1 }),
      JSON.stringify({ type: 'tool/result', data: { turn: 1, step: 1, message: { callId: 'c', content: 'nope' } }, time: 1 }),
      JSON.stringify({ type: 'user/message', data: { content: [
        { type: 'tool-result', toolCallId: 'nested', content: 'not-an-array' },
      ] }, time: 1 }),
    ].join('\n'))
    const mapped = mapForeignSessionEvents(log, 9)
    expect(mapped.events).toHaveLength(1)
    const [only] = mapped.events
    if (only?.type !== 'user/message') return
    expect(only.data.content).toEqual([
      { type: 'tool-result', toolCallId: 'nested', content: [{ type: 'text', text: '[imported malformed content omitted]' }] },
    ])
    expect(mapped.skipped).toBe(7)
  })
})

describe('tool-result guard edges', () => {
  it('rejects a non-string callId and a non-record message separately', () => {
    const log = parseForeignSessionLog([
      JSON.stringify({ version: 3 }),
      JSON.stringify({ type: 'tool/result', data: { turn: 1, step: 1, message: { callId: 42, content: [] } }, time: 1 }),
      JSON.stringify({ type: 'tool/result', data: { turn: 1, step: 1, message: [] }, time: 1 }),
    ].join('\n'))
    const mapped = mapForeignSessionEvents(log, 5)
    expect(mapped.events).toHaveLength(0)
    expect(mapped.skipped).toBe(2)
  })
})

describe('tool-result record guards', () => {
  it('rejects non-record data and missing turn separately', () => {
    const log = parseForeignSessionLog([
      JSON.stringify({ version: 3 }),
      JSON.stringify({ type: 'tool/result', data: 'nope', time: 1 }),
      JSON.stringify({ type: 'tool/result', data: { step: 1, message: { callId: 'c', content: [] } }, time: 1 }),
    ].join('\n'))
    const mapped = mapForeignSessionEvents(log, 5)
    expect(mapped.events).toHaveLength(0)
    expect(mapped.skipped).toBe(2)
  })
})
