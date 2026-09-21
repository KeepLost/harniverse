/**
 * Foreign session-log parsing: split an official v1/v2/v3 JSONL export into
 * its header and raw event records without assuming that generation's event
 * vocabulary. Physical framing is validated before lossy payload mapping.
 *
 * @module @deepseek-ai/dsh-session-import
 */

import { decodeStorageRecord } from '@deepseek-ai/dsh-session'

/** A foreign log that cannot be split into a header and event records. */
export class ForeignLogError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ForeignLogError'
  }
}

/** The header fields an import reads from a foreign log's first line. */
export interface ForeignSessionHeader {
  readonly id: string
  /** The stored format version, unvalidated until classification. */
  readonly version: unknown
  /** Unix epoch milliseconds from the validated foreign header. */
  readonly createdAt: number
  /** Foreign working directory, retained as provenance rather than authority. */
  readonly cwd: string | undefined
}

/** One foreign event record: type and data stay raw until lossy mapping. */
export interface ForeignRawEvent {
  readonly seq: number
  readonly surfaceOp?: 'append' | { op: 'replace'; start: number; end: number }
  /** The foreign event's `type` field, unvalidated. */
  readonly type: unknown
  /** The foreign event's `time` field, unvalidated. */
  readonly time: unknown
  /** The foreign event's `data` field, unvalidated. */
  readonly data: unknown
}

/** A parsed foreign log: header line plus the remaining event lines. */
export interface ForeignSessionLog {
  readonly header: ForeignSessionHeader
  readonly events: readonly ForeignRawEvent[]
}

function safeTime(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Parse one foreign session export. The first non-empty line must be a JSON
 * released header; remaining records have contiguous sequence numbers and
 * valid envelopes. Official v1 packed chunk runs are expanded. Blank lines
 * are ignored in the parsed view; the importer retains the original bytes.
 * @param text - the foreign artifact's full text.
 * @returns the split log; classification refuses unusable versions.
 * @throws {@link ForeignLogError} when the text has no header, the header is
 * not an object, or any event line is not a JSON object.
 */
export function parseForeignSessionLog(text: string): ForeignSessionLog {
  const lines = text.split('\n')
  let headerLine: string | undefined
  const eventLines: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (headerLine === undefined) {
      headerLine = trimmed
      continue
    }
    eventLines.push(trimmed)
  }
  if (headerLine === undefined) throw new ForeignLogError('foreign session log is empty (no header line)')

  let headerJson: unknown
  try {
    headerJson = JSON.parse(headerLine)
  } catch (error) {
    throw new ForeignLogError(`foreign session header is not valid JSON: ${String(error)}`)
  }
  if (typeof headerJson !== 'object' || headerJson === null || Array.isArray(headerJson)) {
    throw new ForeignLogError('foreign session header must be a JSON object')
  }
  const headerRecord = headerJson as Record<string, unknown>
  const createdAt = safeTime(headerRecord.createdAt)
  if (headerRecord.type !== 'session' || typeof headerRecord.id !== 'string' || headerRecord.id.length === 0
    || createdAt === undefined || safeTime(headerRecord.delegationDepth) === undefined
    || (headerRecord.cwd !== undefined && typeof headerRecord.cwd !== 'string')
    || ((headerRecord.version === 2 || headerRecord.version === 3) && typeof headerRecord.isSeeded !== 'boolean')) {
    throw new ForeignLogError('invalid foreign session header')
  }
  const header: ForeignSessionHeader = {
    id: headerRecord.id,
    version: headerRecord.version,
    createdAt,
    cwd: typeof headerRecord.cwd === 'string' ? headerRecord.cwd : undefined,
  }

  const events: ForeignRawEvent[] = []
  for (const [index, line] of eventLines.entries()) {
    let eventJson: unknown
    try {
      eventJson = JSON.parse(line)
    } catch (error) {
      throw new ForeignLogError(`foreign session event line ${index + 2} is not valid JSON: ${String(error)}`)
    }
    if (typeof eventJson !== 'object' || eventJson === null || Array.isArray(eventJson)) {
      throw new ForeignLogError(`foreign session event line ${index + 2} must be a JSON object`)
    }
    const record = eventJson as Record<string, unknown>
    // Released v1 uses the same packed chunk framing as native v0.
    const packed = ['text-chunks', 'reasoning-chunks', 'tool-call-chunks'].includes(String(record.type))
    let rows: readonly unknown[] = [record]
    if (packed) {
      if (header.version !== 1) throw new ForeignLogError('packed chunk rows require official v1')
      try { rows = decodeStorageRecord(record) } catch (error) {
        throw new ForeignLogError(`invalid packed row: ${String(error)}`)
      }
    }
    for (const row of rows) {
      const event = row as Record<string, unknown>
      const seq = event.seq
      const time = event.time
      if (seq !== events.length || typeof event.type !== 'string' || event.type.length === 0
        || typeof time !== 'number' || !Number.isSafeInteger(time)
        || typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) {
        throw new ForeignLogError(`invalid foreign event envelope at seq ${events.length}`)
      }
      let surfaceOp: ForeignRawEvent['surfaceOp']
      if (event.surfaceOp === 'append') surfaceOp = 'append'
      else if (event.surfaceOp !== undefined) {
        if (typeof event.surfaceOp !== 'object' || event.surfaceOp === null || Array.isArray(event.surfaceOp)) {
          throw new ForeignLogError('invalid foreign surface replacement')
        }
        const op = event.surfaceOp as Record<string, unknown>
        const start = header.version === 3 ? op.startSeq : op.start
        const end = header.version === 3 ? op.endSeq : op.end
        if (op.op !== 'replace' || safeTime(start) === undefined || safeTime(end) === undefined
          || (start as number) > (end as number) || (end as number) >= events.length) {
          throw new ForeignLogError('invalid foreign surface replacement')
        }
        surfaceOp = { op: 'replace', start: start as number, end: end as number }
      }
      if (['user/message', 'assistant/message', 'tool/result', 'system/message'].includes(event.type)
        && surfaceOp === undefined) throw new ForeignLogError('foreign message requires surfaceOp')
      if (event.sourceEventSeqs !== undefined) {
        if (!Array.isArray(event.sourceEventSeqs) || event.sourceEventSeqs.some((ref: unknown) => {
          const range = Array.isArray(ref) ? ref : [ref, ref]
          return range.length !== 2 || safeTime(range[0]) === undefined || safeTime(range[1]) === undefined
            || range[0] > range[1] || range[1] >= events.length
        })) throw new ForeignLogError('invalid foreign sourceEventSeqs')
      }
      events.push({ seq: events.length, type: event.type, time, data: event.data,
        ...(surfaceOp === undefined ? {} : { surfaceOp }) })
    }
  }
  return { header, events }
}
