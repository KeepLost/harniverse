/** Immutable session-to-profile identity resolution. */

import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

/** The minimum a caller must supply to resolve a session's preset. */
export interface PresetBearingSession {
  /** The session's creation header. */
  readonly header: SessionHeader
  /** The session's event log, oldest first. */
  readonly events: readonly SessionEvent[]
}

/**
 * The profile a session runs. The immutable header is the sole authority.
 * @param session - the session's header and event log.
 * @returns the preset id, or `undefined` when the deployment composes none.
 */
export function resolveSessionProfile(session: PresetBearingSession): string | undefined {
  return session.header.agentProfile
}
