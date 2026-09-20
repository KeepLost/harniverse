/**
 * Presented-file wire validators for the client fold. The durable contract is
 * the `deliverables/presented` session event, owned Host-side by
 * `dsh-tool-present`; this module only structural-checks the JSON the fold
 * consumes and positions accepted records on the log.
 */
import type { PresentedFile } from '@deepseek-ai/dsh-tool-present/types'

/** A presented declaration positioned on the session log. */
export interface PresentedPath extends PresentedFile {
  /** Seq of the declaring `deliverables/presented` event. */
  readonly seq: number
  /** Position within the declaring event's file list. */
  readonly index: number
}

/**
 * Structural check for one presented-file record.
 * @param value - decoded JSON for one declared file.
 * @returns Whether the record names a non-empty path with an optional string description.
 */
export function isPresentedFile(value: unknown): value is PresentedFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { path, description } = value as Record<string, unknown>
  if (typeof path !== 'string' || path.length === 0) return false
  return description === undefined || typeof description === 'string'
}

/**
 * Structural check for one `deliverables/presented` payload; the client fold
 * admits the event only when every field and file record carries its wire
 * shape, so malformed durable data degrades to an ignored event.
 * @param value - decoded event data.
 * @returns Whether the payload is a coherent delivery declaration.
 */
export function isPresentedData(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const { turn, callId, files } = value as Record<string, unknown>
  if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 1) return false
  if (typeof callId !== 'string' || callId.length === 0) return false
  if (!Array.isArray(files) || files.length === 0) return false
  return files.every(file => isPresentedFile(file))
}
