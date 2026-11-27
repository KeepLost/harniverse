/**
 * The binding between a harness session and the external agent's session: one
 * log-only event, written when the binding is made and read when a reopened
 * session looks for the external session it was bound to.
 * @module @deepseek-ai/dsh-agent-acp/session
 */

import type { AcpProtocol } from '@deepseek-ai/dsh-acp-client'
import type { Session } from '@deepseek-ai/dsh-session'

/** Payload of the log-only `acp/session` event. */
export interface AcpSessionEventData {
  /** Session id the external agent assigned. */
  readonly sessionId: string
  /** `resumed` when the external session was reattached, `new` when it was opened. */
  readonly reached: 'new' | 'resumed'
  /** The agent as launched: its command and arguments. */
  readonly command: string
  readonly args: readonly string[]
  /** Protocol version the connection speaks. */
  readonly protocol: AcpProtocol
  /** Name the agent reported at the handshake, when it reported one. */
  readonly agentName?: string
  /** Working directory the external session was opened in. */
  readonly cwd: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The external agent session a harness session is bound to. The latest
     * event in the session's own log is the binding a reopened session
     * reattaches to; a fork inherits its parent's events below its seed
     * boundary and so opens an external session of its own. Log-only.
     */
    'acp/session': AcpSessionEventData
  }
}

/**
 * The binding this session made itself. A fork replays its parent's events,
 * so an event below the seed boundary belongs to the parent.
 * @param session - the session whose log to read.
 * @returns the latest binding of the session's own log, or `undefined`.
 */
export function recordedBinding(session: Session): AcpSessionEventData | undefined {
  const own = session.header.seedLength ?? 0
  const event = session.events.findLast(item => item.type === 'acp/session' && item.seq >= own)
  return event?.type === 'acp/session' ? event.data : undefined
}
