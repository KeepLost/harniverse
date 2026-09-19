/**
 * Types for the lossy foreign-session import contract: the foreign
 * format-version vocabulary, the archival `import/record` marker event, and
 * the shape of the default posture an importer applies. Types only — no
 * runtime code.
 *
 * @module @deepseek-ai/dsh-session-import
 */

import type { SupervisionMode } from '@deepseek-ai/dsh-supervision'

/**
 * What a stored session header's `version` says about importability.
 *
 * - `'current'` — this build's own `SESSION_FORMAT_VERSION`; native, not
 *   foreign.
 * - `'official-v1'`/`'official-v2'`/`'official-v3'` — DeepSeek Harness
 *   session generations this contract knows how to name for lossy import.
 * - `'unknown'` — anything else; refuse the import rather than guess.
 */
export type ForeignSessionFormat = 'current' | 'official-v1' | 'official-v2' | 'official-v3' | 'unknown'

/** The source artifact and applied default posture one import records. */
export interface ImportRecordEventData {
  /** The foreign log this session was mapped from. */
  readonly source: {
    /** Foreign format classification of the source header's version field. */
    readonly format: Exclude<ForeignSessionFormat, 'current' | 'unknown'>
    /** Name of the preserved source artifact stored beside the mapped session. */
    readonly artifactName: string
  }
  /** The default posture the importer applied; user-selectable at import time. */
  readonly posture: {
    readonly supervisionMode: SupervisionMode
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Marks this session as imported archival data: the first event of a
     * session mapped lossily from a foreign session log (an official DSH
     * v1/v2/v3 export). The mapped history is displayable, saveable, and
     * searchable, and the preserved source artifact is named by
     * `source.artifactName`. Live machinery must treat a session carrying
     * this marker as settled: never resumed, queued, approved, or steered —
     * the exclusion is enforced through `assertNotResumable`.
     */
    'import/record': ImportRecordEventData
  }
}
