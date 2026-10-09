/**
 * Types-only face of the archival projection: the importable official
 * generations and the `sessionImport` projection value every reader of an
 * archive's provenance consumes. Free of host value imports so client code
 * can read it through `./client`.
 *
 * @module @deepseek-ai/dsh-session-import/projection
 */

/** An official DeepSeek Harness session generation this build imports lossily. */
export type ImportedSessionFormat = 'official-v1' | 'official-v2' | 'official-v3' | 'official-v4'

/** Provenance of one imported archival session, folded from its `import/record` marker. */
export interface SessionImportProjection {
  /** The official generation the archive was mapped from. */
  readonly format: ImportedSessionFormat
  /** The official session's own id, when the marker records it. */
  readonly sourceSessionId?: string
  /** The official session's working directory, kept as provenance only. */
  readonly sourceCwd?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * Archival provenance: the marker's source facts on an imported archive,
     * `null` on every other session. A non-null value means the session never
     * runs and can only be continued into a new session.
     */
    sessionImport: SessionImportProjection | null
  }
}
