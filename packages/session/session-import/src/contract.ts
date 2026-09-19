/**
 * Pure contract rules for lossy foreign-session import: classify a foreign
 * header's version, recognize an archival session, and refuse live use of
 * imported history.
 *
 * @module @deepseek-ai/dsh-session-import
 */

import { SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SUPERVISION_MODES, type SupervisionMode } from '@deepseek-ai/dsh-supervision'
import type { ForeignSessionFormat, ImportRecordEventData } from './types.ts'

/**
 * Classify one stored session header's `version` for import. Pure and total;
 * the official v1/v2/v3 generations name their lossy import classes, this
 * build's own version names `'current'`, and everything else is `'unknown'`
 * and must be refused rather than guessed.
 * @param version - the `version` field read from a stored foreign header, unvalidated.
 * @returns the foreign format classification; never `undefined`.
 */
export function classifyForeignSessionFormatVersion(version: unknown): ForeignSessionFormat {
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) return 'unknown'
  if (version === SESSION_FORMAT_VERSION) return 'current'
  if (version === 1 || version === 2 || version === 3) return `official-v${version}`
  return 'unknown'
}

/** Default posture applied when the importer is given no explicit choice. */
export const DEFAULT_IMPORT_SUPERVISION_MODE: SupervisionMode = 'supervised'

/**
 * Validate raw import posture input, refusing unknown supervision modes.
 * @param input - the raw posture value, or undefined for the default.
 * @returns the validated posture.
 * @throws `TypeError` when `supervisionMode` is present but not a known mode.
 */
export function parseImportPosture(input: unknown): { supervisionMode: SupervisionMode } {
  const mode = (input as { supervisionMode?: unknown } | null | undefined)?.supervisionMode
  if (mode === undefined) return { supervisionMode: DEFAULT_IMPORT_SUPERVISION_MODE }
  if (typeof mode === 'string' && SUPERVISION_MODES.includes(mode as SupervisionMode)) {
    return { supervisionMode: mode as SupervisionMode }
  }
  throw new TypeError(`import posture supervisionMode must be one of ${SUPERVISION_MODES.join(', ')}, got ${JSON.stringify(mode)}`)
}

/**
 * Whether this event log belongs to an imported archival session: its first
 * event is the `import/record` marker. Sessions whose marker appears anywhere
 * else violate the package invariant and are not archival by this face.
 * @param events - the durable session log, in seq order.
 * @returns whether the log opens with the archival marker.
 */
export function isArchivalSession(events: readonly SessionEvent[]): boolean {
  return events[0]?.type === 'import/record'
}

/** Live machinery asked to resume, queue, approve, or steer imported archival history. */
export class ArchivalSessionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchivalSessionError'
  }
}

/**
 * The exclusion guard every live entry point (resume, work queue admission,
 * approval, steering) applies before adopting a session: imported archival
 * sessions are settled data — saveable, searchable, displayable — and never
 * execute.
 * @param events - the durable session log, in seq order.
 * @throws {@link ArchivalSessionError} when the session carries the archival marker.
 */
export function assertNotResumable(events: readonly SessionEvent[]): void {
  if (isArchivalSession(events)) {
    throw new ArchivalSessionError('imported archival sessions never resume, queue, approve, or steer')
  }
}

/**
 * Type-safe read of the marker's payload on the first event, or undefined.
 * @param events - the durable session log, in seq order.
 * @returns the marker's payload on an archival session, else undefined.
 */
export function importRecordOf(events: readonly SessionEvent[]): ImportRecordEventData | undefined {
  const first = events[0]
  return first !== undefined && first.type === 'import/record' ? first.data : undefined
}
