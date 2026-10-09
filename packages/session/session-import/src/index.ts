/**
 * The lossy foreign-session import contract and runtime: foreign format
 * classification, the archival `import/record` marker, the default import
 * posture, the resume exclusion guard, content-derived archive identities,
 * the persistence-backed importer that retains the source artifact beside
 * the mapped session, and the seed a live continuation of an archive starts
 * from.
 *
 * @module @deepseek-ai/dsh-session-import
 */

export {
  ArchivalSessionError,
  assertNotResumable,
  classifyForeignSessionFormatVersion,
  DEFAULT_IMPORT_SUPERVISION_MODE,
  importRecordOf,
  isArchivalSession,
  parseImportPosture,
} from './contract.ts'
export { continuationSeedOf } from './continuation.ts'
export { ForeignLogError, parseForeignSessionLog } from './foreign.ts'
export { mapForeignSessionEvents, scheduleImportEvents } from './map.ts'
export { ImportConflictError, SessionImport, default } from './importer.ts'
export type {
  ForeignSessionFormat, ImportedSessionFormat, ImportRecordEventData, SessionImportProjection,
} from './types.ts'
export type { ForeignSessionHeader, ForeignSessionLog, ForeignRawEvent } from './foreign.ts'
export type { ForeignMapping, PendingImportEvent } from './map.ts'
export type { ForeignArtifactSummary, ImportForeignSessionOptions, ImportedSession } from './importer.ts'
