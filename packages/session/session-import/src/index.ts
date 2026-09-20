/**
 * The lossy foreign-session import contract and runtime: foreign format
 * classification, the archival `import/record` marker, the default import
 * posture, the resume exclusion guard, and the persistence-backed importer
 * that retains the source artifact beside the mapped session.
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
export { ForeignLogError, parseForeignSessionLog } from './foreign.ts'
export { mapForeignSessionEvents, scheduleImportEvents } from './map.ts'
export { SessionImport, default } from './importer.ts'
export type { ForeignSessionFormat, ImportRecordEventData } from './types.ts'
export type { ForeignSessionHeader, ForeignSessionLog, ForeignRawEvent } from './foreign.ts'
export type { ForeignMapping, PendingImportEvent } from './map.ts'
export type { ImportForeignSessionOptions, ImportedSession } from './importer.ts'
