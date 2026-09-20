/**
 * Foreign session-log parsing: split an official v1/v2/v3 JSONL export into
 * its header and raw event records without assuming that generation's event
 * vocabulary. Tolerant by design — classification and lossy mapping decide
 * what the records mean.
 *
 * @module @deepseek-ai/dsh-session-import
 */

/** A foreign log that cannot be split into a header and event records. */
export class ForeignLogError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ForeignLogError'
  }
}

/** The header fields an import reads from a foreign log's first line. */
export interface ForeignSessionHeader {
  /** The stored format version, unvalidated until classification. */
  readonly version: unknown
  /** Unix epoch milliseconds when present as a safe integer. */
  readonly createdAt: number | undefined
  /** Absolute working directory when present as an absolute path string. */
  readonly cwd: string | undefined
}

/** One foreign event record: type and data stay raw until lossy mapping. */
export interface ForeignRawEvent {
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
 * object carrying a `version`; every further non-empty line must be a JSON
 * object and becomes one raw event record. Blank lines are ignored.
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
  const headerRecord = headerJson as { version?: unknown; createdAt?: unknown; cwd?: unknown }
  const header: ForeignSessionHeader = {
    version: headerRecord.version,
    createdAt: safeTime(headerRecord.createdAt),
    cwd: typeof headerRecord.cwd === 'string' && headerRecord.cwd.startsWith('/') ? headerRecord.cwd : undefined,
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
    const record = eventJson as { type?: unknown; time?: unknown; data?: unknown }
    events.push({ type: record.type, time: record.time, data: record.data })
  }
  return { header, events }
}
