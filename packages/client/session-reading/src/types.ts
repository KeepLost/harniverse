/**
 * Client-safe vocabulary of the session-reading capability: the Host record,
 * the Remote result shapes, and the forwarded change signal. This module
 * contains types only, so the Client face and generated Remote clients
 * consume it without importing Host runtime code.
 * @module @deepseek-ai/dsh-client-session-reading/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One session's reading state as the Host keeps it in memory. */
export interface SessionReadingRecord {
  readonly sessionId: SessionId
  /** Number of the latest turn that ended while the Host observed the session. */
  readonly completedTurn: number
  /** The latest completed turn ended with an error. */
  readonly failed: boolean
  /** Number of the latest completed turn the reader has acknowledged. */
  readonly readTurn: number
  /** The reader marked the session unread by hand; only a `read` mark lowers it. */
  readonly manualUnread: boolean
}

/** The reader action one `mark` call applies to a session. */
export type SessionReadingAction = 'read' | 'unread'

/** Every record the Host currently holds. */
export interface SessionReadingListValue {
  readonly records: readonly SessionReadingRecord[]
}

/** Result of one `mark` call. */
export interface SessionReadingMarkValue {
  /**
   * The stored record after the action applied. Absent when the session holds
   * no record and the action was `read`: there was nothing to acknowledge.
   */
  readonly record: SessionReadingRecord | null
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A reading record was added or changed. The payload is empty: consumers
     * refetch `sessionReading.list`, which stays the authoritative ledger.
     * @mode emit
     */
    'sessionReading/changed'(): void
  }
}
