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
import { MAX_PACKED_DATA_BYTES, MAX_PACKED_ROW_MEMBERS, packChunkRuns } from '../src/codec.ts'
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
