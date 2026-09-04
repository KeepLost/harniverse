/* oxlint-disable typescript/no-unsafe-assignment -- Vitest asymmetric matchers are typed as any. */

import { Context } from '@deepseek-ai/cordis'
import { CallId, MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'
import { bindRecord, decodeRow } from '../src/compression.ts'
import { MAX_PACKED_DATA_BYTES, MAX_PACKED_ROW_MEMBERS, decodeSerializedChunkRow, packChunkRuns } from '../src/codec.ts'
import type { EventRow } from '../src/schema.ts'
import { meta } from '../../session-persistence/tests/contract.ts'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

function textChunk(seq: number, text: string, time = seq + 1): SessionEvent<'assistant/chunk'> {
  return {
    type: 'assistant/chunk',
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text },
    },
  }
}

function reasoningChunk(seq: number, text: string, time = seq + 1): SessionEvent<'assistant/chunk'> {
  return {
    type: 'assistant/chunk',
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      chunk: { type: 'reasoning-delta', index: 0, text },
    },
  }
}

function toolCallChunk(seq: number, argumentsDelta: string, time = seq + 1): SessionEvent<'assistant/chunk'> {
  return {
    type: 'assistant/chunk',
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      chunk: {
        type: 'tool-call-delta',
        index: 0,
        id: CallId('packed-call'),
        name: 'lookup',
        argumentsDelta,
      },
    },
  }
}

function physicalRow(event: SessionEvent): EventRow {
  const record = bindRecord(event)
  return {
    seq: record.seq,
    type: record.type,
    time: record.time,
    data: record.data,
    source_event_seqs: record.sourceEventSeqs,
    surface_op: record.surfaceOp,
    ignorable: record.ignorable,
  }
}

function streamedTurn(base = 0, turn = 1): SessionEvent[] {
  const chunks = ['packed-', 'stream-', 'restores-', 'exactly'].map((text, index) => ({
    ...textChunk(base + index + 3, text),
    data: { ...textChunk(base + index + 3, text).data, turn },
  })) as SessionEvent<'assistant/chunk'>[]
  return [
    { type: 'turn/start', seq: base, time: base + 1, data: { turn } },
    {
      type: 'user/message',
      seq: base + 1,
      time: base + 2,
      data: freezeMessage({
        id: MessageId(`packed-user-${turn}`),
        role: 'user',
        content: [{ type: 'text', text: 'stream' }],
        source: { kind: 'user' },
      }),
      surfaceOp: 'append',
    },
    { type: 'step/start', seq: base + 2, time: base + 3, data: { turn, step: 1 } },
    ...chunks,
    {
      type: 'assistant/message',
      seq: base + 7,
      time: base + 8,
      data: {
        turn,
        step: 1,
        message: freezeMessage({
          id: MessageId(`packed-assistant-${turn}`),
          role: 'assistant',
          content: [{ type: 'text', text: 'packed-stream-restores-exactly' }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        }),
      },
      surfaceOp: 'append',
      sourceEventSeqs: [base + 3, base + 4, base + 5, base + 6],
    },
    { type: 'step/end', seq: base + 8, time: base + 9, data: { turn, step: 1 } },
    { type: 'turn/end', seq: base + 9, time: base + 10, data: { turn, reason: { kind: 'completed' } } },
  ]
}

describe('schema-17 physical codec', () => {
  it('packs a compatible chunk run and restores every logical boundary', () => {
    const chunks = [textChunk(4, 'a', 10), textChunk(5, 'b', 13), textChunk(6, 'c', 15)]
    const records = packChunkRuns(chunks)
    expect(records).toHaveLength(1)
    const bound = bindRecord(records[0] as ReturnType<typeof packChunkRuns>[number])
    expect(bound.type).toBe('text-chunks')
    expect(decodeRow({
      seq: bound.seq,
      type: bound.type,
      time: bound.time,
      data: bound.data,
      source_event_seqs: bound.sourceEventSeqs,
      surface_op: bound.surfaceOp,
      ignorable: bound.ignorable,
    })).toEqual(chunks)
  })

  it('keeps incompatible or short chunk runs scalar', () => {
    const short = [textChunk(0, 'a'), textChunk(1, 'b')]
    const differentIndex = {
      ...textChunk(2, 'c'),
      data: { turn: 1, step: 1, chunk: { type: 'text-delta' as const, index: 1, text: 'c' } },
    }
    expect(packChunkRuns([...short, differentIndex]).map(record => record.type)).toEqual([
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
    ])
  })

  it('round-trips reasoning and tool-call packed rows', () => {
    const runs = [
      [reasoningChunk(0, 'think'), reasoningChunk(1, ' then'), reasoningChunk(2, ' act')],
      [toolCallChunk(0, '{"q"'), toolCallChunk(1, ':"x"'), toolCallChunk(2, '}')],
    ]
    for (const events of runs) {
      const records = packChunkRuns(events)
      expect(records).toHaveLength(1)
      const bound = bindRecord(records[0] as ReturnType<typeof packChunkRuns>[number])
      expect(decodeRow({
        seq: bound.seq,
        type: bound.type,
        time: bound.time,
        data: bound.data,
        source_event_seqs: bound.sourceEventSeqs,
        surface_op: bound.surfaceOp,
        ignorable: bound.ignorable,
      })).toEqual(events)
    }
  })

  it('partitions runs at the member and uncompressed-data limits', () => {
    const memberBound = Array.from(
      { length: MAX_PACKED_ROW_MEMBERS + 1 },
      (_, index) => textChunk(index, 'x'),
    )
    const memberRecords = packChunkRuns(memberBound)
    expect(memberRecords.map(record => record.type)).toEqual(['text-chunks', 'assistant/chunk'])
    const memberPacked = memberRecords[0]
    if (memberPacked === undefined || !('seq0' in memberPacked)) throw new Error('expected one member-bounded row')
    const memberBoundRecord = bindRecord(memberPacked)
    expect(decodeRow({
      seq: memberBoundRecord.seq,
      type: memberBoundRecord.type,
      time: memberBoundRecord.time,
      data: memberBoundRecord.data,
      source_event_seqs: memberBoundRecord.sourceEventSeqs,
      surface_op: memberBoundRecord.surfaceOp,
      ignorable: memberBoundRecord.ignorable,
    })).toHaveLength(MAX_PACKED_ROW_MEMBERS)

    const byteBound = Array.from({ length: 4 }, (_, index) => textChunk(index, 'x'.repeat(300_000)))
    const byteRecords = packChunkRuns(byteBound)
    expect(byteRecords.map(record => record.type)).toEqual(['text-chunks', 'assistant/chunk'])
    const packed = byteRecords[0]
    if (packed === undefined || !('seq0' in packed)) throw new Error('expected one packed byte-bounded row')
    expect(Buffer.byteLength(JSON.stringify(packed.data))).toBeLessThanOrEqual(MAX_PACKED_DATA_BYTES)

    const oversized = JSON.stringify({
      turn: 1,
      step: 1,
      index: 0,
      dt: [1, 1],
      texts: ['x'.repeat(MAX_PACKED_DATA_BYTES), '', ''],
    })
    expect(() => decodeRow({
      seq: 0,
      type: 'text-chunks',
      time: 1,
      data: zstdCompressSync(oversized),
      source_event_seqs: null,
      surface_op: null,
      ignorable: 0,
    })).toThrow()
  })

  it('compresses profitable payloads and validates provenance encoding', () => {
    const event = {
      type: 'assistant/message',
      seq: 9,
      time: 10,
      data: { content: [{ type: 'text', text: 'repeat '.repeat(2_000) }] },
      sourceEventSeqs: [3, 8, 5, 1000],
      surfaceOp: 'append',
    } as unknown as SessionEvent<'assistant/message'>
    const row = physicalRow(event)
    expect(row.data).toBeInstanceOf(Uint8Array)
    expect(row.source_event_seqs).toBeInstanceOf(Uint8Array)
    expect(decodeRow(row)).toEqual([event])

    const empty = physicalRow({ ...event, sourceEventSeqs: [] })
    expect(empty.source_event_seqs).toBeInstanceOf(Uint8Array)
    expect(empty.source_event_seqs).toHaveLength(0)
    expect(decodeRow(empty)).toEqual([{ ...event, sourceEventSeqs: [] }])

    expect(() => decodeRow({ ...row, source_event_seqs: Uint8Array.of(0x80) })).toThrow('truncated varint')
    expect(() => decodeRow({
      ...row,
      source_event_seqs: 'not-a-blob' as unknown as Uint8Array,
    })).toThrow('source_event_seqs must be a blob or null')
  })

  describe('physical row integrity', () => {
    const scalar = (): EventRow => physicalRow({
      type: 'assistant/message',
      seq: 4,
      time: 5,
      data: { content: [{ type: 'text', text: 'stored' }] },
    } as unknown as SessionEvent<'assistant/message'>)

    it.each([
      ['a fractional seq', { seq: 1.5 }, /seq must be a non-negative safe integer/],
      ['a negative seq', { seq: -1 }, /seq must be a non-negative safe integer/],
      ['a non-numeric seq', { seq: 'four' }, /seq must be a non-negative safe integer/],
      ['an empty type', { type: '' }, /type must be a nonempty string/],
      ['a non-string type', { type: 7 }, /type must be a nonempty string/],
      ['a fractional time', { time: 2.5 }, /time must be a safe integer/],
      ['a non-numeric data column', { data: 42 }, /data must be text or a blob/],
      ['a non-string surface op', { surface_op: 3 }, /surface_op must be text or null/],
      ['an out-of-range ignorable flag', { ignorable: 2 }, /ignorable must be 0, 1, or null/],
    ])('refuses %s', (_label, overrides, message) => {
      // A durable row is external input: a corrupted or foreign writer's row
      // must be refused rather than decoded into a bogus event.
      expect(() => decodeRow({ ...scalar(), ...overrides } as unknown as EventRow)).toThrow(message)
    })

    it('refuses a packed row whose type is not a chunk tag', () => {
      expect(() => decodeRow({ ...scalar(), ignorable: 0, type: 'assistant/message' }))
        .toThrow(/packed discriminator requires a chunk tag/)
    })

    it.each([
      ['provenance', { source_event_seqs: Uint8Array.of(1) }],
      ['a surface op', { surface_op: 'append' }],
    ])('refuses a packed row carrying %s', (_label, overrides) => {
      expect(() => decodeRow({ ...scalar(), ignorable: 0, type: 'text-chunks', ...overrides }))
        .toThrow(/packed surface fields must be null/)
    })

    it('refuses provenance that is not a non-negative safe integer', () => {
      for (const sourceEventSeqs of [[1.5], [-1], [Number.MAX_SAFE_INTEGER + 2]]) {
        expect(() => bindRecord({
          type: 'assistant/message',
          seq: 4,
          time: 5,
          data: { content: [] },
          sourceEventSeqs,
        } as unknown as SessionEvent<'assistant/message'>))
          .toThrow(/sourceEventSeqs must contain non-negative safe integers/)
      }
    })

    it.each([
      ['a non-canonical varint', Uint8Array.of(0x81, 0x00), /non-canonical varint/],
      ['a varint above the first-value bound', Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f), /varint is out of range/],
      ['a varint wider than the shift bound', Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01), /varint is out of range/],
      ['a zigzag delta below zero', Uint8Array.of(0x02, 0x09), /decoded seq is out of range/],
    ])('refuses %s in stored provenance', (_label, source_event_seqs, message) => {
      expect(() => decodeRow({ ...scalar(), source_event_seqs })).toThrow(message)
    })

  })
})

describe('packed SQLite persistence', () => {
  it('stores fewer rows while preserving full, suffix, and backward-page reads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harniverse-packed-sqlite-'))
    directories.push(directory)
    const path = join(directory, 'sessions.db')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SqliteSessionPersistence, { path })
    const header = meta('packed-history')
    const events = streamedTurn()

    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, events)

    const probe = new DatabaseSync(path)
    const physical = probe.prepare(
      'SELECT seq, type FROM events WHERE session_id = ? ORDER BY seq',
    ).all(header.id) as Array<{ seq: number; type: string }>
    expect(physical).toEqual([
      { seq: 0, type: 'turn/start' },
      { seq: 1, type: 'user/message' },
      { seq: 2, type: 'step/start' },
      { seq: 3, type: 'text-chunks' },
      { seq: 7, type: 'assistant/message' },
      { seq: 8, type: 'step/end' },
      { seq: 9, type: 'turn/end' },
    ])
    expect(() => probe.prepare(
      `INSERT INTO events
        (session_id, seq, type, time, data, source_event_seqs, surface_op, ignorable)
       VALUES (?, 10, 'turn/start', 11, '{"turn":2}', NULL, NULL, 0)`,
    ).run(header.id)).toThrow(/CHECK constraint failed/u)
    probe.close()

    expect((await ctx.sessionPersistence.load(header.id)).events).toEqual(events)
    expect((await ctx.sessionPersistence.readFrom(header.id, 5)).events).toEqual(events.slice(5))

    const latest = await ctx.sessionPersistence.readHistoryPage(header.id, { maxMessages: 1 })
    expect(latest.events).toEqual(events.slice(3))
    expect(latest.hasMore).toBe(true)

    const older = await ctx.sessionPersistence.readHistoryPage(header.id, { beforeSeq: 7, maxMessages: 1 })
    expect(older.events).toEqual(events.slice(1, 7))
    expect(older.hasMore).toBe(true)

    const rawTail = await ctx.sessionPersistence.readRawEventPage(header.id, { maxEvents: 2 })
    expect(rawTail.events).toEqual(events.slice(-2))
    expect(rawTail.hasMore).toBe(true)

    const rawOlder = await ctx.sessionPersistence.readRawEventPage(header.id, {
      beforeSeq: rawTail.events[0]!.seq,
      maxEvents: 2,
    })
    expect(rawOlder.events).toEqual(events.slice(-4, -2))
    expect(rawOlder.hasMore).toBe(true)

    await fiber.dispose()
  })

  it('bounds old history pages and rejects a malformed packed predecessor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harniverse-packed-bounds-'))
    directories.push(directory)
    const path = join(directory, 'sessions.db')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SqliteSessionPersistence, { path })
    const header = meta('packed-bounds')
    const first = streamedTurn()
    const second = streamedTurn(10, 2)

    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, first)

    const beforeAppend = new DatabaseSync(path)
    const retained = beforeAppend.prepare(
      `SELECT seq, type, time, hex(data) AS data, hex(source_event_seqs) AS source_event_seqs,
              surface_op, ignorable
       FROM events WHERE session_id = ? ORDER BY seq`,
    ).all(header.id)
    beforeAppend.close()

    await ctx.sessionPersistence.append(header.id, second)

    const afterAppend = new DatabaseSync(path)
    expect(afterAppend.prepare(
      `SELECT seq, type, time, hex(data) AS data, hex(source_event_seqs) AS source_event_seqs,
              surface_op, ignorable
       FROM events WHERE session_id = ? AND seq < 10 ORDER BY seq`,
    ).all(header.id)).toEqual(retained)
    afterAppend.close()

    const corrupt = new DatabaseSync(path)
    corrupt.prepare(
      `UPDATE events SET data = ?
       WHERE session_id = ? AND type = 'text-chunks' AND seq = 13`,
    ).run(Buffer.from([0]), header.id)
    corrupt.close()

    const oldPage = await ctx.sessionPersistence.readHistoryPage(header.id, { beforeSeq: 7, maxMessages: 1 })
    expect(oldPage.events).toEqual(first.slice(1, 7))
    await expect(ctx.sessionPersistence.readFrom(header.id, 15)).rejects.toThrow(
      'corrupt session log: invalid packed predecessor at seq 13',
    )
    await expect(ctx.sessionPersistence.load(header.id)).rejects.toThrow(
      'corrupt session log: invalid committed physical row at seq 13',
    )

    await fiber.dispose()
  })

  it('repairs a malformed packed row only when it belongs to the uncommitted tail', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harniverse-packed-repair-'))
    directories.push(directory)
    const path = join(directory, 'sessions.db')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SqliteSessionPersistence, { path })
    const header = meta('packed-repair')
    const committed = streamedTurn()
    const openTail: SessionEvent[] = [
      { type: 'turn/start', seq: 10, time: 11, data: { turn: 2 } },
      { type: 'step/start', seq: 11, time: 12, data: { turn: 2, step: 1 } },
      textChunk(12, 'a', 13),
      textChunk(13, 'b', 14),
      textChunk(14, 'c', 15),
    ].map(event => event.type === 'assistant/chunk'
      ? { ...event, data: { ...event.data, turn: 2 } }
      : event) as SessionEvent[]

    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, committed)
    await ctx.sessionPersistence.append(header.id, openTail)

    const corrupt = new DatabaseSync(path)
    const original = corrupt.prepare(
      `SELECT data FROM events
       WHERE session_id = ? AND type = 'text-chunks' AND seq = 12`,
    ).get(header.id) as { data: string | Uint8Array }
    corrupt.prepare(
      `UPDATE events SET data = ?
       WHERE session_id = ? AND type = 'text-chunks' AND seq = 12`,
    ).run(Buffer.from([0]), header.id)
    corrupt.close()

    const backend = ctx.sessionPersistence as unknown as {
      loadStored(id: typeof header.id): Promise<{ readonly tornMarker?: number }>
      commitRepair(
        meta: typeof header,
        tornMarker: number | undefined,
        closers: readonly SessionEvent[],
      ): Promise<void>
    }
    const stale = await backend.loadStored(header.id)
    expect(stale.tornMarker).toBe(12)

    const restored = new DatabaseSync(path)
    restored.prepare(
      `UPDATE events SET data = ?
       WHERE session_id = ? AND type = 'text-chunks' AND seq = 12`,
    ).run(original.data, header.id)
    restored.close()
    await expect(backend.commitRepair(header, stale.tornMarker, [])).rejects.toThrow('repair is stale')

    const recorrupt = new DatabaseSync(path)
    recorrupt.prepare(
      `UPDATE events SET data = ?
       WHERE session_id = ? AND type = 'text-chunks' AND seq = 12`,
    ).run(Buffer.from([0]), header.id)
    recorrupt.close()

    const loaded = await ctx.sessionPersistence.load(header.id)
    expect(loaded.events.slice(10).map(event => event.type)).toEqual([
      'turn/start',
      'step/start',
      'step/end',
      'turn/end',
    ])
    expect(loaded.events.map(event => event.seq)).toEqual([...Array.from({ length: 14 }, (_, index) => index)])

    const probe = new DatabaseSync(path)
    expect(probe.prepare(
      'SELECT type FROM events WHERE session_id = ? AND type = \'text-chunks\' AND seq = 12',
    ).get(header.id)).toBeUndefined()
    probe.close()
    await fiber.dispose()
  })
})

describe('pack eligibility', () => {
  /** One assistant chunk carrying an arbitrary chunk payload. */
  const chunkEvent = (seq: number, chunk: unknown, overrides: Record<string, unknown> = {}): SessionEvent => ({
    type: 'assistant/chunk',
    seq,
    time: seq + 1,
    data: { turn: 1, step: 1, chunk },
    ...overrides,
  } as unknown as SessionEvent)

  const toolCall = (seq: number, args: string, extra: Record<string, unknown> = {}): SessionEvent =>
    chunkEvent(seq, { type: 'tool-call-delta', index: 0, id: 'call-1', argumentsDelta: args, ...extra })

  it('packs a tool-call run that names its function', () => {
    const run = [0, 1, 2].map(seq => toolCall(seq, `a${String(seq)}`, { name: 'search' }))
    const packed = packChunkRuns(run)
    expect(packed).toEqual([expect.objectContaining({
      type: 'tool-call-chunks',
      data: expect.objectContaining({ id: 'call-1', name: 'search', args: ['a0', 'a1', 'a2'] }),
    })])
  })

  it('packs a tool-call run that names none', () => {
    const packed = packChunkRuns([0, 1, 2].map(seq => toolCall(seq, `a${String(seq)}`)))
    expect(packed).toHaveLength(1)
    expect((packed[0] as { data: Record<string, unknown> }).data).not.toHaveProperty('name')
  })

  it.each([
    ['an event carrying an extra envelope field', chunkEvent(0, { type: 'text-delta', index: 0, text: 'a' }, { extra: 1 })],
    ['a fractional seq', chunkEvent(0.5, { type: 'text-delta', index: 0, text: 'a' })],
    ['a negative seq', chunkEvent(-1, { type: 'text-delta', index: 0, text: 'a' })],
    ['an unsafe time', chunkEvent(0, { type: 'text-delta', index: 0, text: 'a' }, { time: Number.MAX_SAFE_INTEGER + 2 })],
    ['non-record data', { type: 'assistant/chunk', seq: 0, time: 1, data: 'text' } as unknown as SessionEvent],
    ['data carrying an extra field', { type: 'assistant/chunk', seq: 0, time: 1, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'a' }, extra: 1 } } as unknown as SessionEvent],
    ['a non-numeric turn', { type: 'assistant/chunk', seq: 0, time: 1, data: { turn: '1', step: 1, chunk: { type: 'text-delta', index: 0, text: 'a' } } } as unknown as SessionEvent],
    ['a non-numeric step', { type: 'assistant/chunk', seq: 0, time: 1, data: { turn: 1, step: '1', chunk: { type: 'text-delta', index: 0, text: 'a' } } } as unknown as SessionEvent],
    ['a non-record chunk', chunkEvent(0, 'text-delta')],
    ['a non-numeric chunk index', chunkEvent(0, { type: 'text-delta', index: '0', text: 'a' })],
    ['a text delta with an extra field', chunkEvent(0, { type: 'text-delta', index: 0, text: 'a', extra: 1 })],
    ['a text delta whose text is not a string', chunkEvent(0, { type: 'text-delta', index: 0, text: 1 })],
    ['a tool call with an unusable field set', chunkEvent(0, { type: 'tool-call-delta', index: 0, id: 'c', argumentsDelta: 'a', extra: 1 })],
    ['a tool call whose name is not a string', chunkEvent(0, { type: 'tool-call-delta', index: 0, id: 'c', name: 1, argumentsDelta: 'a' })],
    ['a tool call whose id is not a string', chunkEvent(0, { type: 'tool-call-delta', index: 0, id: 1, argumentsDelta: 'a' })],
    ['a tool call whose delta is not a string', chunkEvent(0, { type: 'tool-call-delta', index: 0, id: 'c', argumentsDelta: 1 })],
    ['an unknown chunk type', chunkEvent(0, { type: 'audio-delta', index: 0, text: 'a' })],
  ])('leaves %s unpacked', (_label, event) => {
    // A run needs three eligible members; an ineligible one never joins a row.
    const events = [event, textChunk(1, 'b'), textChunk(2, 'c'), textChunk(3, 'd')]
    const packed = packChunkRuns(events)
    expect(packed[0]).toBe(event)
  })

  it.each([
    ['a seq gap', [textChunk(0, 'a'), textChunk(2, 'b'), textChunk(3, 'c')]],
    ['an unsafe time delta', [
      textChunk(0, 'a', -Number.MAX_SAFE_INTEGER),
      textChunk(1, 'b', Number.MAX_SAFE_INTEGER),
      textChunk(2, 'c', Number.MAX_SAFE_INTEGER),
    ]],
    ['a turn change', [textChunk(0, 'a'), { ...textChunk(1, 'b'), data: { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'b' } } }, textChunk(2, 'c')]],
    ['a step change', [textChunk(0, 'a'), { ...textChunk(1, 'b'), data: { turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: 'b' } } }, textChunk(2, 'c')]],
    ['an index change', [textChunk(0, 'a'), { ...textChunk(1, 'b'), data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'b' } } }, textChunk(2, 'c')]],
  ])('refuses to pack across %s', (_label, events) => {
    expect(packChunkRuns(events as readonly SessionEvent[]).every(record => 'seq' in record)).toBe(true)
  })

  it.each([
    ['a different call id', [toolCall(0, 'a'), toolCall(1, 'b', { id: 'call-2' }), toolCall(2, 'c')]],
    ['a name appearing mid-run', [toolCall(0, 'a'), toolCall(1, 'b', { name: 'search' }), toolCall(2, 'c')]],
    ['a name changing mid-run', [
      toolCall(0, 'a', { name: 'search' }),
      toolCall(1, 'b', { name: 'fetch' }),
      toolCall(2, 'c', { name: 'search' }),
    ]],
  ])('refuses to pack tool calls across %s', (_label, events) => {
    expect(packChunkRuns(events).every(record => 'seq' in record)).toBe(true)
  })

  it('starts a new run when the delta kind changes', () => {
    const packed = packChunkRuns([
      textChunk(0, 'a'), textChunk(1, 'b'), textChunk(2, 'c'),
      reasoningChunk(3, 'd'), reasoningChunk(4, 'e'), reasoningChunk(5, 'f'),
    ])
    expect(packed.map(record => (record as { type: string }).type)).toEqual(['text-chunks', 'reasoning-chunks'])
  })

  it('leaves a single oversized member unpacked and packs the rest', () => {
    const huge = 'x'.repeat(MAX_PACKED_DATA_BYTES + 10)
    const packed = packChunkRuns([
      textChunk(0, huge),
      textChunk(1, 'b'), textChunk(2, 'c'), textChunk(3, 'd'),
    ])

    // The first member cannot fit any row, so it stays logical while the
    // remaining three still pack.
    expect(packed).toHaveLength(2)
    expect(packed[0]).toMatchObject({ seq: 0 })
    expect(packed[1]).toMatchObject({ type: 'text-chunks', seq0: 1 })
  })
})

describe('packed row decoding integrity', () => {
  /** Decode one stored payload under a tag, as the reader does. */
  const decode = (tag: 'text-chunks' | 'reasoning-chunks' | 'tool-call-chunks', data: unknown, seq0 = 0, time0 = 1): SessionEvent[] =>
    decodeSerializedChunkRow(tag, seq0, time0, JSON.stringify(data))

  const textData = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    turn: 1, step: 1, index: 0, dt: [1, 1], texts: ['a', 'b', 'c'], ...overrides,
  })
  const toolData = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    turn: 1, step: 1, index: 0, id: 'call-1', dt: [1, 1], args: ['a', 'b', 'c'], ...overrides,
  })

  it('rebuilds a text run with its member times', () => {
    expect(decode('text-chunks', textData({ dt: [2, 3] }))).toEqual([
      textChunk(0, 'a', 1), textChunk(1, 'b', 3), textChunk(2, 'c', 6),
    ])
  })

  it('rebuilds a reasoning run', () => {
    expect(decode('reasoning-chunks', textData())).toEqual([
      reasoningChunk(0, 'a', 1), reasoningChunk(1, 'b', 2), reasoningChunk(2, 'c', 3),
    ])
  })

  it('rebuilds a tool-call run that named its function', () => {
    const [first] = decode('tool-call-chunks', toolData({ name: 'search' }))
    expect(first?.data).toMatchObject({
      chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'search', argumentsDelta: 'a' },
    })
  })

  it('rebuilds a tool-call run that named none', () => {
    const [first] = decode('tool-call-chunks', toolData())
    expect((first?.data as { chunk: object }).chunk).not.toHaveProperty('name')
  })

  it('refuses a payload above the byte bound before parsing it', () => {
    const oversized = JSON.stringify({
      type: 'text-chunks', seq0: 0, time0: 1, data: textData({ texts: ['x'.repeat(MAX_PACKED_DATA_BYTES), 'b', 'c'] }),
    })
    expect(() => decodeSerializedChunkRow('text-chunks', 0, 1, oversized))
      .toThrow(/data exceeds 1048576 UTF-8 bytes/)
  })

  it.each([
    ['a fractional seq0', 0.5, 1, /seq0 must be non-negative/],
    ['a negative seq0', -1, 1, /seq0 must be non-negative/],
    ['a fractional time0', 0, 1.5, /time0 must be a safe integer/],
  ])('refuses %s in the stored physical columns', (_label, seq0, time0, message) => {
    expect(() => decode('text-chunks', textData(), seq0, time0)).toThrow(message)
  })

  it.each([
    ['a string', '"text"'],
    ['an array', '[1,2,3]'],
    ['null', 'null'],
  ])('refuses stored data that is %s rather than an object', (_label, serialized) => {
    expect(() => decodeSerializedChunkRow('text-chunks', 0, 1, serialized)).toThrow(/data must be an object/)
  })

  it.each([
    ['data carrying an extra field', textData({ extra: 1 }), /invalid text data fields/],
    ['a non-numeric turn', textData({ turn: '1' }), /turn\/step\/index must be numbers/],
    ['a non-numeric step', textData({ step: '1' }), /turn\/step\/index must be numbers/],
    ['a non-numeric index', textData({ index: '0' }), /turn\/step\/index must be numbers/],
    ['a non-array payload', textData({ texts: 'abc' }), /texts must contain 3\.\.1024 strings/],
    ['a payload below the member floor', textData({ texts: ['a', 'b'], dt: [1] }), /texts must contain 3\.\.1024 strings/],
    ['a payload above the member bound', textData({
      texts: Array.from({ length: MAX_PACKED_ROW_MEMBERS + 1 }, () => 'a'),
      dt: Array.from({ length: MAX_PACKED_ROW_MEMBERS }, () => 1),
    }), /texts must contain 3\.\.1024 strings/],
    ['a payload holding a non-string', textData({ texts: ['a', 'b', 3] }), /texts must contain 3\.\.1024 strings/],
    ['a non-array dt', textData({ dt: 'x' }), /dt must be an array of safe integers/],
    ['a fractional dt member', textData({ dt: [1, 1.5] }), /dt must be an array of safe integers/],
    ['a dt length that disagrees with the members', textData({ dt: [1] }), /dt length must match the member count/],
  ])('refuses %s in a text row', (_label, data, message) => {
    expect(() => decode('text-chunks', data)).toThrow(message)
  })

  it.each([
    ['an unusable tool-call field set', toolData({ extra: 1 }), /invalid tool-call data fields/],
    ['a non-string id', toolData({ id: 1 }), /id and optional name must be strings/],
    ['a non-string name', toolData({ name: 1 }), /id and optional name must be strings/],
    ['a non-array args', toolData({ args: 'abc' }), /args must contain 3\.\.1024 strings/],
  ])('refuses %s', (_label, data, message) => {
    expect(() => decode('tool-call-chunks', data)).toThrow(message)
  })

  it('refuses member seqs that leave the safe integer range', () => {
    expect(() => decode('text-chunks', textData(), Number.MAX_SAFE_INTEGER))
      .toThrow(/member seqs exceed safe integers/)
  })

  it('refuses member times that leave the safe integer range', () => {
    expect(() => decode('text-chunks', textData({ dt: [Number.MAX_SAFE_INTEGER, 1] }), 0, 10))
      .toThrow(/member times exceed safe integers/)
  })
})
