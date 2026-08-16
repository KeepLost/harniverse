/** Event projection and lifecycle capture for outbound notifications. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentStatus } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-compaction'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionClosedEvent, SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import {
  NotificationEventId,
  type NotificationBackend,
  type NotificationSubject,
  type NotificationTurnReason,
} from './index.ts'

/** Project selected Harness facts and hand metadata-only envelopes to a backend. */
export class NotificationCoordinator {
  private readonly toolNames = new WeakMap<Session, Map<CallId, string>>()

  /**
   * @param ctx - provider context whose fiber owns every listener and the shutdown effect.
   * @param backend - backend receiving projected events.
   */
  constructor(
    private readonly ctx: Context,
    private readonly backend: NotificationBackend,
  ) {
    ctx.effect(() => async () => {
      try {
        await backend.shutdown()
      } catch (error) {
        ctx.logger.warn(`notification: backend shutdown failed: ${String(error)}`)
      }
    }, 'notification capture')
    ctx.on('session/event', (session, event) => {
      this.contain(() => { this.projectSessionEvent(session, event) })
    })
    ctx.on('session/created', (session) => {
      this.contain(() => { this.projectSeededCompactions(session) })
    }, { global: true })
    ctx.on('session/disposed', (session) => {
      this.contain(() => { this.emitDetached(session) })
    })
    ctx.on('session/closed', (event) => {
      this.contain(() => { this.emitClosed(event) })
    })
    ctx.on('agent/status', ({ agent, status }) => {
      this.contain(() => { this.emitAgentStatus(agent.session, status) })
    })
    for (const session of ctx.sessions.list()) this.contain(() => { this.projectSeededCompactions(session) })
  }

  /** Project compaction settlements restored without `session/event` publication. */
  private projectSeededCompactions(session: Session): void {
    const ownSeedStart = session.header.seedLength ?? 0
    for (let seq = ownSeedStart; seq < session.firstLiveSeq; seq += 1) {
      const event = session.events[seq] as SessionEvent
      if (event.type === 'compaction/end') this.projectSessionEvent(session, event)
    }
  }

  /** Project one supported durable event; unrelated session events remain local. */
  private projectSessionEvent(session: Session, event: SessionEvent): void {
    switch (event.type) {
      case 'turn/end':
        this.backend.emit({
          ...this.ledgerBase(session, event),
          type: 'session.turn-settled',
          data: { turn: event.data.turn, seq: event.seq, reason: turnReason(event.data.reason) },
        })
        return
      case 'approval/asked':
        this.backend.emit({
          ...this.ledgerBase(session, event),
          type: 'approval.requested',
          data: {
            approvalId: event.data.id,
            toolName: event.data.toolName,
            ...(event.data.callId === undefined ? {} : { callId: event.data.callId }),
            turn: enclosingTurn(session, event.seq),
            seq: event.seq,
          },
        })
        return
      case 'approval/decided':
        this.backend.emit({
          ...this.ledgerBase(session, event),
          type: 'approval.decided',
          data: {
            approvalId: event.data.id,
            outcome: event.data.outcome,
            turn: enclosingTurn(session, event.seq),
            seq: event.seq,
          },
        })
        return
      case 'tool/call': {
        this.namesFor(session).set(event.data.callId, event.data.name)
        this.backend.emit({
          ...this.ledgerBase(session, event),
          type: 'tool.called',
          data: {
            callId: event.data.callId,
            toolName: event.data.name,
            turn: event.data.turn,
            step: event.data.step,
            seq: event.seq,
          },
        })
        return
      }
      case 'tool/result': {
        const callId = event.data.message.source.callId
        const names = this.namesFor(session)
        const toolName = names.get(callId) ?? priorToolName(session, event.seq, callId)
        if (toolName === undefined) throw new Error(`tool result "${callId}" has no matching tool call`)
        names.delete(callId)
        this.backend.emit({
          ...this.ledgerBase(session, event),
          type: 'tool.settled',
          data: {
            callId,
            toolName,
            turn: event.data.turn,
            step: event.data.step,
            seq: event.seq,
            ok: event.data.message.content[0].isError !== true,
            ...(event.data.error === undefined ? {} : { error: { ...event.data.error } }),
          },
        })
        return
      }
      case 'compaction/end':
        this.backend.emit({
          ...this.ledgerBase(session, event),
          type: 'compaction.settled',
          data: {
            compactionId: event.data.compactionId,
            turn: event.data.turn,
            seq: event.seq,
            ok: event.data.error === undefined,
            ...(event.data.sourceCommandId === undefined ? {} : { sourceCommandId: event.data.sourceCommandId }),
          },
        })
        return
      default:
        return
    }
  }

  /** Common identity for one durable session-log projection. */
  private ledgerBase(session: Session, event: SessionEvent) {
    return {
      specVersion: 1 as const,
      eventId: NotificationEventId(`${session.id}:${event.seq}`),
      occurredAt: new Date(event.time).toISOString(),
      subject: subjectOf(session),
    }
  }

  /** Project a generic live-store detach without assigning a close cause. */
  private emitDetached(session: Session): void {
    this.backend.emit({
      ...this.operationalBase(subjectOf(session)),
      type: 'session.detached',
      data: {},
    })
  }

  /** Project the canonical explicit-close event produced after successful teardown. */
  private emitClosed(event: SessionClosedEvent): void {
    this.backend.emit({
      ...this.operationalBase({
        sessionId: event.sessionId,
        ...(event.parentSessionId === undefined ? {} : { parentSessionId: event.parentSessionId }),
      }),
      type: 'session.closed',
      data: {},
    })
  }

  /** Project one live agent status transition. */
  private emitAgentStatus(session: Session, status: AgentStatus): void {
    this.backend.emit({
      ...this.operationalBase(subjectOf(session)),
      type: 'agent.status-changed',
      data: { status },
    })
  }

  /** Common identity for a non-ledger event. */
  private operationalBase(subject: NotificationSubject) {
    return {
      specVersion: 1 as const,
      eventId: NotificationEventId(randomUUID()),
      occurredAt: new Date().toISOString(),
      subject,
    }
  }

  /** Lazily create a per-session call-id correlation table. */
  private namesFor(session: Session): Map<CallId, string> {
    let names = this.toolNames.get(session)
    if (names === undefined) this.toolNames.set(session, names = new Map<CallId, string>())
    return names
  }

  /** Keep projection and backend failures outside core lifecycle dispatch. */
  private contain(step: () => void): void {
    try {
      step()
    } catch (error) {
      this.ctx.logger.warn(`notification: capture step failed: ${String(error)}`)
    }
  }
}

/** Build the external subject from immutable session header fields. */
function subjectOf(session: Session): NotificationSubject {
  return {
    sessionId: session.id,
    ...(session.header.parentSession === undefined ? {} : { parentSessionId: session.header.parentSession }),
  }
}

/** Find the open turn enclosing one audit event. */
function enclosingTurn(session: Session, seq: number): number {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const candidate = session.events[index] as SessionEvent
    if (candidate.seq >= seq) continue
    if (candidate.type === 'turn/start') return candidate.data.turn
    if (candidate.type === 'turn/end') break
  }
  throw new Error(`session "${session.id}" event ${seq} is not enclosed by a turn`)
}

/** Find the matching call metadata already recorded in the same session log. */
function priorToolName(session: Session, seq: number, callId: CallId): string | undefined {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const candidate = session.events[index] as SessionEvent
    if (candidate.seq >= seq || candidate.type !== 'tool/call') continue
    if (candidate.data.callId === callId) return candidate.data.name
  }
  return undefined
}

/** Remove provider and human-readable detail from the merge-extensible turn reason. */
function turnReason(reason: TurnEndReason): NotificationTurnReason {
  switch (reason.kind) {
    case 'completed':
    case 'blocked':
    case 'max-tokens':
    case 'interrupted':
      return { kind: reason.kind }
    case 'aborted':
      return { kind: 'aborted', cause: reason.reason.kind }
    case 'error':
      return { kind: 'error', error: { code: reason.error.code } }
    default:
      return { kind: 'unknown' }
  }
}
