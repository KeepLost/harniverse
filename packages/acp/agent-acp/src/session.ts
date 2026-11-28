/**
 * What the driver records beside the session log's model-loop-shaped events
 * and reads back when the session continues: the binding to the external
 * session, the title the agent gave, and the agent's context accounting.
 * @module @deepseek-ai/dsh-agent-acp/session
 */

import type { AcpProtocol } from '@deepseek-ai/dsh-acp-client'
import type { AgentContextEventData } from '@deepseek-ai/dsh-agent'
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

/** Payload of the log-only `acp/title` event. */
export interface AcpTitleEventData {
  /** The title as the title service accepted it. */
  readonly title: string
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
    /**
     * A title the external agent gave the session, written right after the
     * rename that applied it. The latest event in the session's own log names
     * the standing title that is the agent's rather than the person's.
     * Log-only.
     */
    'acp/title': AcpTitleEventData
  }
}

/**
 * The binding this session made itself. A fork replays its parent's events,
 * so an event below the seed boundary belongs to the parent.
 * @param session - the session whose log to read.
 * @param accepts - narrows the search to the bindings of one agent; every binding when omitted.
 * @returns the latest binding of the session's own log that was accepted, or `undefined`.
 */
export function recordedBinding(
  session: Session,
  accepts: (data: AcpSessionEventData) => boolean = () => true,
): AcpSessionEventData | undefined {
  const own = session.header.seedLength ?? 0
  const event = session.events.findLast(item => item.type === 'acp/session' && item.seq >= own && accepts(item.data))
  return event?.type === 'acp/session' ? event.data : undefined
}

/**
 * The title the agent applied last, which a later report of its own may replace.
 * @param session - the session whose log to read.
 * @returns the latest title this session's own log records the agent applying, or `undefined`.
 */
export function appliedTitle(session: Session): string | undefined {
  const own = session.header.seedLength ?? 0
  const event = session.events.findLast(item => item.type === 'acp/title' && item.seq >= own)
  return event?.type === 'acp/title' ? event.data.title : undefined
}

/**
 * The latest context accounting this session's own log records.
 * @param session - the session whose log to read.
 * @returns the latest context report, or `undefined` before one.
 */
export function recordedContext(session: Session): AgentContextEventData | undefined {
  const own = session.header.seedLength ?? 0
  const event = session.events.findLast(item => item.type === 'agent/context' && item.seq >= own)
  return event?.type === 'agent/context' ? event.data : undefined
}
