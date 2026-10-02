/**
 * Pending tool-result recovery shared by failed live steps and interrupted
 * logs. Tail repair preserves closed steps and supplies only missing tool
 * results and lifecycle boundaries.
 * @module @deepseek-ai/dsh-session/repair
 */

import { MessageId, freezeMessage, type CallId } from '@deepseek-ai/dsh-llm'
import type { ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from './types.ts'

/** Recovery code for an assistant tool request that never reached a recorded call start. */
export const TOOL_NOT_STARTED = 'TOOL_NOT_STARTED'

/** Recovery code for a recorded tool call whose completed outcome was not durably recorded. */
export const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'

/** Model-visible wording of a synthetic result for a call that was recorded as started. */
const STARTED_RESULT_TEXT = 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.'

/** Model-visible wording of a synthetic result for a call that never reached a recorded start. */
const NOT_STARTED_RESULT_TEXT = 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.'

/**
 * Return deterministic synthetic events that close an open tail turn. Unmatched
 * calls receive error results first, followed by an open `step/end` and an
 * interrupted `turn/end`; sequences continue the log and timestamps reuse the
 * last real event. A balanced or empty log returns no events.
 *
 * @param events - the loaded durable log to scan (a valid committed prefix, possibly with a crash tail).
 * @returns the synthetic closer events to append after `events`, in order; empty when the log is already balanced.
 */
export function interruptedTurnClosers(events: readonly SessionEvent[]): SessionEvent[] {
  let openTurn: number | null = null
  let openStep: number | null = null
  const recovery = new ToolCallRecovery()
  for (const event of events) {
    recovery.observe(event)
    switch (event.type) {
      case 'turn/start':
        openTurn = event.data.turn
        openStep = null
        break
      case 'turn/end':
        openTurn = null
        openStep = null
        break
      case 'step/start':
        openStep = event.data.step
        break
      case 'step/end':
        openStep = null
        break
      // Other event types do not move the turn/step boundary cursor.
      default:
        break
    }
  }

  // Balanced log (no crash mid-turn): nothing to close. An open turn implies
  // `events` is non-empty (its turn/start was logged), so `last` exists.
  const last = events.at(-1)
  if (openTurn === null || last === undefined) return []

  const closers: SessionEvent[] = recovery.results()
  let seq = last.seq + closers.length + 1
  const time = last.time

  // Close an open step next — a turn/end while a step is open is an invariant
  // violation, so the step's boundary must be synthesized before the turn's.
  if (openStep !== null) {
    closers.push({ type: 'step/end', seq: seq++, time, data: { turn: openTurn, step: openStep } })
  }
  closers.push({ type: 'turn/end', seq: seq++, time, data: { turn: openTurn, reason: { kind: 'interrupted' } } })
  return closers
}

/**
 * Track unanswered assistant tool requests from one Session's committed events.
 * Observe from the start of the owned step or replay prefix, and recover before
 * its step closes. This state retains pending identities, not event history.
 */
export class ToolCallRecovery {
  private readonly pendingCalls = new Map<CallId, { turn: number; step: number; callSeq?: number }>()
  private last: Pick<SessionEvent, 'seq' | 'time'> | undefined

  /**
   * Consume the next committed event; closed steps and turn boundaries discard pending requests.
   * @param event - the next event from the same Session, in sequence order.
   */
  observe(event: SessionEvent): void {
    this.last = { seq: event.seq, time: event.time }
    switch (event.type) {
      case 'turn/start':
      case 'turn/end':
      case 'step/end':
        this.pendingCalls.clear()
        break
      case 'assistant/message':
        // The assistant message carries the tool-call blocks; each is pending
        // until a matching tool/result event is logged.
        for (const block of event.data.message.content) {
          if (block.type === 'tool-call') {
            this.pendingCalls.set(block.id, { turn: event.data.turn, step: event.data.step })
          }
        }
        break
      case 'tool/call': {
        // Cite the `tool/call` seq from a synthetic result for the started call.
        const entry = this.pendingCalls.get(event.data.callId)
        if (entry) entry.callSeq = event.seq
        break
      }
      case 'tool/result': {
        const callId = event.data.message.source.callId
        const entry = this.pendingCalls.get(callId)
        // A pending entry is required before the turn and step comparison: a
        // result whose callId never registered carries no comparable facts.
        if (entry?.turn === event.data.turn && entry.step === event.data.step) {
          this.pendingCalls.delete(callId)
        }
        break
      }
      // SessionEvent is merge-extensible; unrelated events retain pending requests.
      default:
        break
    }
  }

  /**
   * Build conservative error results in assistant order without changing tracked state.
   * Sequences follow the latest observed event and timestamps reuse its time.
   * Callers commit the results and observe those commits before recovering again.
   * @returns pending tool-result events, empty when no request remains unanswered.
   */
  results(): SessionEvent<'tool/result'>[] {
    if (this.last === undefined) return []
    let seq = this.last.seq + 1
    const time = this.last.time
    const results: SessionEvent<'tool/result'>[] = []
    for (const [callId, { turn, step, callSeq }] of this.pendingCalls) {
      const started = callSeq !== undefined
      const message: ToolResultMessage = freezeMessage({
        id: MessageId(`interrupted-tool-result-${callId}-${seq}`),
        role: 'user',
        source: { kind: 'tool', callId },
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          isError: true,
          content: [{
            type: 'text',
            text: started ? STARTED_RESULT_TEXT : NOT_STARTED_RESULT_TEXT,
          }],
        }],
      })
      results.push({
        type: 'tool/result',
        seq: seq++,
        time,
        data: {
          turn,
          step,
          message,
          error: started
            ? { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN }
            : { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED },
        },
        surfaceOp: 'append',
        ...started ? { sourceEventSeqs: [callSeq] } : {},
      })
    }
    return results
  }
}
