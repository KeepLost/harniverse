/**
 * The lossy foreign-session import contract: foreign format classification,
 * the archival `import/record` marker, the default import posture, and the
 * resume exclusion guard. Pure contract — reading foreign artifacts, mapping
 * their history into v0 events, and persistence/search integration compose
 * this package in the import runtime.
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
export type { ForeignSessionFormat, ImportRecordEventData } from './types.ts'
