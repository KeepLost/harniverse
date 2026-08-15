/**
 * Provider-neutral outbound notification protocol and backend Service Definition.
 * @module @deepseek-ai/dsh-notification
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'

declare module '@deepseek-ai/cordis' {
  interface Context {
    notification: NotificationBackend
  }
}

/** Stable identifier shared by every delivery attempt for one logical event. */
export type NotificationEventId = Branded<'NotificationEventId'>

/**
 * Brand a string as a {@link NotificationEventId}.
 * @param id - raw event identifier.
 * @returns the same string carrying the notification-event brand.
 */
export function NotificationEventId(id: string): NotificationEventId {
  return id as NotificationEventId
}

/** JSON scalar accepted by the outbound protocol. */
export type NotificationJsonScalar = string | number | boolean | null

/** JSON value accepted by the outbound protocol. */
export type NotificationJsonValue =
  | NotificationJsonScalar
  | NotificationJsonValue[]
  | { [key: string]: NotificationJsonValue }

/** Session identity shared by all notification event types. */
export interface NotificationSubject {
  sessionId?: SessionId
  parentSessionId?: SessionId
}

/** Stable, privacy-minimized representation of a turn end reason. */
export type NotificationTurnReason =
  | { kind: 'completed' }
  | { kind: 'aborted'; cause: 'user' | 'parent' | 'hook' | 'disposed' | 'legacy' }
  | { kind: 'blocked' }
  | { kind: 'error'; error: { code: string } }
  | { kind: 'max-tokens' }
  | { kind: 'interrupted' }
  | { kind: 'unknown' }

/** Stable error metadata that excludes messages and stack traces. */
export interface NotificationErrorDetail {
  name: string
  code: string
}

/** Payload for a durable turn boundary. */
export interface SessionTurnSettledData {
  turn: number
  seq: number
  reason: NotificationTurnReason
}

/** Payload for an explicit successful session close. */
export type SessionClosedData = Record<string, never>

/** Payload for generic removal from the live session store. */
export type SessionDetachedData = Record<string, never>

/** Payload for a live agent status transition. */
export interface AgentStatusChangedData {
  status: 'running' | 'idle'
}

/** Payload for a durable approval request audit event. */
export interface ApprovalRequestedData {
  approvalId: ApprovalRequestId
  toolName: string
  callId?: CallId
  turn: number
  seq: number
}

/** Payload for a durable approval decision audit event. */
export interface ApprovalDecidedData {
  approvalId: ApprovalRequestId
  outcome: ApprovalOutcome
  turn: number
  seq: number
}

/** Payload for a durable tool-call audit event. */
export interface ToolCalledData {
  callId: CallId
  toolName: string
  turn: number
  step: number
  seq: number
}

/** Payload for a durable tool-result audit event. */
export interface ToolSettledData {
  callId: CallId
  toolName: string
  turn: number
  step: number
  seq: number
  ok: boolean
  error?: NotificationErrorDetail
}

/**
 * Merge-extensible external event vocabulary. Packages may add stable event
 * types without changing the common envelope or backend interface.
 */
export interface NotificationEventMap {
  'session.turn-settled': SessionTurnSettledData
  'session.closed': SessionClosedData
  'session.detached': SessionDetachedData
  'agent.status-changed': AgentStatusChangedData
  'approval.requested': ApprovalRequestedData
  'approval.decided': ApprovalDecidedData
  'tool.called': ToolCalledData
  'tool.settled': ToolSettledData
}

/** Every registered external notification event type. */
export type NotificationEventType = Extract<keyof NotificationEventMap, string>

/** One versioned outbound event after projection and privacy minimization. */
export type NotificationEnvelope<K extends NotificationEventType = NotificationEventType> = {
  [P in K]: {
    specVersion: 1
    eventId: NotificationEventId
    type: P
    occurredAt: string
    subject: NotificationSubject
    data: NotificationEventMap[P]
  }
}[K]

/** Provider-owned enqueue operation after the common JSON snapshot. */
export interface NotificationSink {
  /**
   * Accept one event synchronously. The implementation MUST only enqueue; it
   * must not perform network or storage I/O before returning.
   * @param event - validated snapshot owned by the provider after this call.
   */
  emit(event: NotificationEnvelope): void

  /**
   * Stop admission and reach provider-defined delivery quiescence.
   * @returns resolution after accepted work has reached the provider's shutdown policy.
   */
  shutdown(): Promise<void>
}

/**
 * Loadable notification backend. The final {@link emit} path validates and
 * snapshots every event before provider-specific queueing.
 */
export abstract class NotificationBackend extends Service implements NotificationSink {
  constructor(ctx: Context) {
    super(ctx, 'notification')
  }

  /**
   * Validate and copy one event, then hand it to the provider without I/O.
   * @param event - projected event; caller retains no ownership after return.
   */
  emit(event: NotificationEnvelope): void {
    assertNotificationJson(event)
    this.enqueue(structuredClone(event))
  }

  /**
   * Enqueue one validated snapshot without storage or network I/O.
   * @param event - snapshot owned by this provider.
   */
  protected abstract enqueue(event: NotificationEnvelope): void

  /**
   * Stop admission and reach provider-defined delivery quiescence.
   * @returns resolution after accepted work has reached the provider's shutdown policy.
   */
  abstract shutdown(): Promise<void>
}

export { NotificationCoordinator } from './coordinator.ts'

/** Reject values whose JSON serialization would lose or rewrite information. */
function assertNotificationJson(value: unknown): asserts value is NotificationJsonValue {
  const visiting = new Set<object>()
  const visit = (candidate: unknown): boolean => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return true
    if (typeof candidate === 'number') return Number.isFinite(candidate)
    if (typeof candidate !== 'object') return false
    if (visiting.has(candidate)) return false
    const prototype: unknown = Object.getPrototypeOf(candidate)
    if (!Array.isArray(candidate) && prototype !== Object.prototype && prototype !== null) return false
    if (Reflect.ownKeys(candidate).some(key => typeof key !== 'string')) return false
    visiting.add(candidate)
    const valid = Array.isArray(candidate)
      ? candidate.every(item => visit(item)) && candidate.length === Object.keys(candidate).length
      : Object.values(candidate).every(item => visit(item))
    visiting.delete(candidate)
    return valid
  }
  if (!visit(value)) throw new TypeError('notification event must contain only JSON values')
}

export default NotificationBackend
