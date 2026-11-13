/**
 * Durable shapes of the session-shell stream.
 * @module @deepseek-ai/dsh-session-shell
 */

/** Payload of one committed `session-shell/change` event. */
export interface SessionShellChange {
  /** The complete post-change shell family. */
  family: 'bash' | 'pwsh'
}

/** Projection value of the `sessionShell` key: the recorded family, or null. */
export type SessionShellProjection = 'bash' | 'pwsh' | null
