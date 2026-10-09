/**
 * Public wire vocabulary of the official-session import Remote: discovered
 * candidates with their import status, the import target, and per-item
 * outcomes the client discriminates on. Types only — no runtime code.
 * @module @deepseek-ai/dsh-host-official-session-import/types
 */

import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** An official DeepSeek Harness session generation this build imports. */
export type OfficialSessionFormat = 'official-v1' | 'official-v2' | 'official-v3' | 'official-v4'

/**
 * Where one candidate stands against this machine's archives:
 * - `new` — no archive of this official session exists;
 * - `imported` — an archive of exactly this content exists;
 * - `updated` — an older version of this official session was imported and
 *   the source has changed since.
 */
export type OfficialSessionStatus = 'new' | 'imported' | 'updated'

/** One importable official session found under a configured root. */
export interface OfficialSessionCandidate {
  /** Opaque identity to pass back to `importSources`. */
  readonly sourceId: string
  /** Absolute path of the newest generation log on the serving machine. */
  readonly path: string
  readonly format: OfficialSessionFormat
  /** The official session's own id. */
  readonly sourceSessionId: string
  /** The official session's working directory, when it recorded one. */
  readonly sourceCwd?: string
  /** The official session's latest title. */
  readonly title?: string
  /** The first human prompt, one line. */
  readonly preview?: string
  /** Turns in the mapped history. */
  readonly turns: number
  /** Official creation time, Unix epoch milliseconds. */
  readonly createdAt: number
  /** Time of the latest official event, Unix epoch milliseconds. */
  readonly updatedAt: number
  /** Size of the log file in bytes. */
  readonly sizeBytes: number
  readonly status: OfficialSessionStatus
  /** The existing archive: of this content when `imported`, of an older version when `updated`. */
  readonly archiveSessionId?: string
}

/** Why a log or directory could not be offered. */
export type OfficialSessionUnreadableReason = 'too-large' | 'invalid' | 'unreadable'

/** One log or directory discovery could not offer. */
export interface OfficialSessionUnreadable {
  /** Absolute path on the serving machine. */
  readonly path: string
  readonly reason: OfficialSessionUnreadableReason
  /** Diagnostic detail. */
  readonly message: string
}

/** One discovery pass over the serving machine's configured roots. */
export interface OfficialSessionScan {
  /** The roots that were searched, in configured order. */
  readonly roots: readonly string[]
  /** Importable candidates, most recently updated first. */
  readonly items: readonly OfficialSessionCandidate[]
  /** Logs and directories that could not be offered. */
  readonly unreadable: readonly OfficialSessionUnreadable[]
  /** The largest log this machine reads or accepts as an upload, in bytes. */
  readonly maxArtifactBytes: number
}

/**
 * Which workspace an import lands in:
 * - `source-cwd` — the workspace at the official session's own working
 *   directory, registered on demand when that directory exists here;
 * - `workspace` — one registered workspace.
 */
export type OfficialImportTarget =
  | { readonly kind: 'source-cwd' }
  | { readonly kind: 'workspace'; readonly workspaceId: WorkspaceId }

/** Why one import did not settle. */
export type OfficialImportFailureReason =
  | 'source-missing'
  | 'too-large'
  | 'invalid'
  | 'workspace-unavailable'
  | 'failed'

/** How one import ended. */
export type OfficialImportOutcome =
  | {
    readonly status: 'imported'
    /** The new archive's session id. */
    readonly sessionId: string
    /** The workspace the archive belongs to. */
    readonly workspaceId: WorkspaceId
    /** Whether the archive joined the workspace's session list. */
    readonly attached: boolean
    readonly title?: string
    /** Official events that mapped into the archive. */
    readonly mappedEvents: number
    /** Official events dropped by the lossy mapping. */
    readonly skippedEvents: number
  }
  | {
    readonly status: 'already-imported'
    /** The existing archive of exactly this content. */
    readonly sessionId: string
  }
  | {
    readonly status: 'failed'
    readonly reason: OfficialImportFailureReason
    /** Diagnostic detail. */
    readonly message: string
  }

/** The outcome for one requested source. */
export interface OfficialImportResult {
  /** The requested source id, or the uploaded file name. */
  readonly source: string
  readonly outcome: OfficialImportOutcome
}
