/**
 * Durable shapes of the session-shell stream.
 * @module @deepseek-ai/dsh-session-shell
 */

/** Payload of one committed `session-shell/change` event. */
export interface SessionShellChange {
  /** The complete post-change registry entry id. */
  entry: string
}

/**
 * Projection value of the `sessionShell` key: the recorded entry id (legacy
 * family values fold onto the builtin ids at replay), or null.
 */
export type SessionShellProjection = string | null
