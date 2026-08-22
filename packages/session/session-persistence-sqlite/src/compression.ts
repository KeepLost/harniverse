/**
 * Schema-owned physical SQLite encoding. Scalar events and packed rows are
 * decoded here before persistence consumers observe the logical event stream.
 * @module @deepseek-ai/dsh-session-persistence-sqlite/compression
 */

import { TextDecoder } from 'node:util'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import type { SessionEvent, SurfaceEventType } from '@deepseek-ai/dsh-session'
import {
  decodeSerializedChunkRow,
  type ChunkRow,
  MAX_PACKED_DATA_BYTES,
  type StorageRecord,
} from './codec.ts'
import type { EventRow } from './schema.ts'

/** One physical row ready for SQLite parameter binding. */
export interface BoundRecord {
  readonly seq: number
  readonly type: string
  readonly time: number
  readonly data: string | Uint8Array
  readonly sourceEventSeqs: Uint8Array | null
  readonly surfaceOp: string | null
  readonly ignorable: number | null
}

/** Small values remain text to avoid per-frame compression overhead. */
export const ZSTD_DATA_THRESHOLD_BYTES = 4_096

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER)
const MAX_ZIGZAG_INTEGER = MAX_SAFE_INTEGER * 2n
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })
const ZSTD_COMPRESSION_LEVEL = 3
const PACKED_ROW_SENTINEL = 0
const CHUNK_TAGS = ['text-chunks', 'reasoning-chunks', 'tool-call-chunks'] as const
type ChunkTag = typeof CHUNK_TAGS[number]

function isChunkTag(value: string): value is ChunkTag {
  return (CHUNK_TAGS as readonly string[]).includes(value)
}

function validatePhysicalRow(row: EventRow): void {
  const value = row as unknown as Record<string, unknown>
  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 0) {
    throw new Error('stored event seq must be a non-negative safe integer')
  }
  if (typeof value.type !== 'string' || value.type.length === 0) {
    throw new Error('stored event type must be a nonempty string')
  }
  if (!Number.isSafeInteger(value.time)) throw new Error('stored event time must be a safe integer')
  if (typeof value.data !== 'string' && !(value.data instanceof Uint8Array)) {
    throw new Error('stored event data must be text or a blob')
  }
  if (value.source_event_seqs !== null && !(value.source_event_seqs instanceof Uint8Array)) {
    throw new Error('stored event source_event_seqs must be a blob or null')
  }
  if (value.surface_op !== null && typeof value.surface_op !== 'string') {
    throw new Error('stored event surface_op must be text or null')
  }
  if (value.ignorable !== null && value.ignorable !== 0 && value.ignorable !== 1) {
    throw new Error('stored event ignorable must be 0, 1, or null')
  }
}

/**
 * Decode one physical SQLite row into its complete logical event span.
 * @param row - scalar or packed physical row.
 * @returns every logical event represented by the row.
 */
export function decodeRow(row: EventRow): SessionEvent[] {
  validatePhysicalRow(row)
  if (row.ignorable !== PACKED_ROW_SENTINEL) return [decodeScalarRowUnchecked(row)]
  if (!isChunkTag(row.type)) {
    throw new Error(`malformed ${row.type} storage row: packed discriminator requires a chunk tag`)
  }
  if (row.source_event_seqs !== null || row.surface_op !== null) {
    throw new Error(`malformed ${row.type} storage row: packed surface fields must be null`)
  }
  return decodeSerializedChunkRow(row.type, row.seq, row.time, decodeData(row.data, MAX_PACKED_DATA_BYTES))
}

/**
 * Convert a scalar or packed record to SQLite columns.
 * @param record - logical scalar event or packed chunk row.
 * @returns values ready for parameter binding.
 */
export function bindRecord(record: StorageRecord): BoundRecord {
  if (isChunkRow(record)) {
    return {
      seq: record.seq0,
      type: record.type,
      time: record.time0,
      data: encodeData(JSON.stringify(record.data)),
      sourceEventSeqs: null,
      surfaceOp: null,
      ignorable: PACKED_ROW_SENTINEL,
    }
  }
  const event = record
  const surface = event as SessionEvent<SurfaceEventType>
  return {
    seq: event.seq,
    type: event.type,
    time: event.time,
    data: encodeData(JSON.stringify(event.data)),
    sourceEventSeqs: surface.sourceEventSeqs === undefined ? null : encodeSourceEventSeqs(surface.sourceEventSeqs),
    surfaceOp: surface.surfaceOp === undefined ? null : JSON.stringify(surface.surfaceOp),
    ignorable: event.ignorable === true ? 1 : null,
  }
}

function encodeData(serialized: string): string | Uint8Array {
  const bytes = Buffer.from(serialized)
  if (bytes.length < ZSTD_DATA_THRESHOLD_BYTES) return serialized
  const compressed = zstdCompressSync(bytes, {
    params: { [constants.ZSTD_c_compressionLevel]: ZSTD_COMPRESSION_LEVEL },
  })
  return compressed.length < bytes.length ? compressed : serialized
}

function decodeData(value: string | Uint8Array, maxOutputLength?: number): string {
  if (typeof value === 'string') return value
  const decoded = maxOutputLength === undefined
    ? zstdDecompressSync(value)
    : zstdDecompressSync(value, { maxOutputLength })
  return UTF8_DECODER.decode(decoded)
}

function encodeSourceEventSeqs(values: readonly number[]): Uint8Array {
  const bytes: number[] = []
  let previous = 0n
  for (let index = 0; index < values.length; index += 1) {
    const sourceSeq = values[index] as number
    if (!Number.isSafeInteger(sourceSeq) || sourceSeq < 0) {
      throw new TypeError('sourceEventSeqs must contain non-negative safe integers')
    }
    const value = BigInt(sourceSeq)
    const encoded = index === 0
      ? value
      : value >= previous ? (value - previous) * 2n : ((previous - value) * 2n) - 1n
    appendVarint(bytes, encoded)
    previous = value
  }
  return Buffer.from(bytes)
}

function appendVarint(bytes: number[], value: bigint): void {
  let remaining = value
  while (remaining >= 0x80n) {
    bytes.push(Number(remaining & 0x7fn) | 0x80)
    remaining >>= 7n
  }
  bytes.push(Number(remaining))
}

function decodeSourceEventSeqs(bytes: Uint8Array): number[] {
  const values: number[] = []
  let previous = 0n
  let offset = 0
  while (offset < bytes.length) {
    const first = values.length === 0
    const decoded = readVarint(bytes, offset, first ? MAX_SAFE_INTEGER : MAX_ZIGZAG_INTEGER)
    offset = decoded.offset
    const delta = first
      ? decoded.value
      : (decoded.value & 1n) === 0n ? decoded.value / 2n : -((decoded.value + 1n) / 2n)
    const value = first ? delta : previous + delta
    if (value < 0n || value > MAX_SAFE_INTEGER) {
      throw new Error('malformed source_event_seqs storage value: decoded seq is out of range')
    }
    values.push(Number(value))
    previous = value
  }
  return values
}

function readVarint(
  bytes: Uint8Array,
  offset: number,
  limit: bigint,
): { readonly value: bigint; readonly offset: number } {
  let value = 0n
  let shift = 0n
  while (offset < bytes.length) {
    const byte = bytes[offset] as number
    offset += 1
    value |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) {
      if (shift > 0n && (byte & 0x7f) === 0) throw new Error('malformed source_event_seqs storage value: non-canonical varint')
      if (value > limit) throw new Error('malformed source_event_seqs storage value: varint is out of range')
      return { value, offset }
    }
    shift += 7n
    if (shift > 56n) throw new Error('malformed source_event_seqs storage value: varint is out of range')
  }
  throw new Error('malformed source_event_seqs storage value: truncated varint')
}

function isChunkRow(record: StorageRecord): record is ChunkRow {
  return isChunkTag(record.type) && 'seq0' in record && !('seq' in record)
}

/**
 * Decode one scalar physical row without accepting a packed discriminator.
 * @param row - scalar physical row.
 * @returns the reconstructed logical event.
 */
export function decodeScalarRow(row: EventRow): SessionEvent {
  validatePhysicalRow(row)
  return decodeScalarRowUnchecked(row)
}

function decodeScalarRowUnchecked(row: EventRow): SessionEvent {
  const surfaceFields = {
    ...row.source_event_seqs === null ? {} : { sourceEventSeqs: decodeSourceEventSeqs(row.source_event_seqs) },
    ...row.surface_op === null ? {} : { surfaceOp: JSON.parse(row.surface_op) as SessionEvent<SurfaceEventType>['surfaceOp'] },
  }
  return {
    type: row.type as SessionEvent['type'],
    seq: row.seq,
    time: row.time,
    data: JSON.parse(decodeData(row.data)) as SessionEvent['data'],
    ...surfaceFields,
    ...row.ignorable === 1 ? { ignorable: true as const } : {},
  } as SessionEvent
}

/**
 * Validate physical rows and return their contiguous logical prefix.
 * @param rows - ordered scalar or packed physical rows.
 * @param base - expected sequence of the first logical member.
 * @returns preserved logical events and an optional torn physical-row marker.
 */
export function scanRows(
  rows: readonly EventRow[],
  base = 0,
): { preserved: SessionEvent[]; tornFrom?: number } {
  let lastTurnEndRow = -1
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    try {
      if (decodeRow(rows[index] as EventRow).some(event => event.type === 'turn/end')) {
        lastTurnEndRow = index
        break
      }
    } catch {
      // A malformed row cannot prove that an earlier physical prefix committed.
    }
  }

  const preserved: SessionEvent[] = []
  let expected = base
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const physical = rows[rowIndex] as EventRow
    let logicalEvents: SessionEvent[] | undefined
    try {
      logicalEvents = decodeRow(physical)
    } catch {
      // The committed-prefix rule below owns whether this invalid row is fatal.
    }
    if (logicalEvents === undefined) {
      if (rowIndex <= lastTurnEndRow) throw new Error(`corrupt session log: invalid committed physical row at seq ${physical.seq}`)
      return { preserved, tornFrom: physical.seq }
    }
    let contiguous = true
    for (const event of logicalEvents) {
      if (event.seq !== expected) {
        contiguous = false
        break
      }
      expected += 1
    }
    if (!contiguous) {
      if (rowIndex <= lastTurnEndRow) throw new Error(`corrupt session log: invalid committed physical row at seq ${physical.seq}`)
      return { preserved, tornFrom: physical.seq }
    }
    preserved.push(...logicalEvents)
  }
  return { preserved }
}
