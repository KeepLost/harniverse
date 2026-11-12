/**
 * The `stats-step` Definition: one Context per `step/start`, folding the
 * step's stream chunks, assembled message, tool call/result pairs, and
 * provider retries into one published {@link StatsStepMetrics} node.
 *
 * @module @deepseek-ai/dsh-client-ui-stats/stats-step-definition
 */

import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import type { StatsConversationViewNode } from './stats-contract.ts'
import { isTokenDelta } from '@deepseek-ai/dsh-client-runtime/client'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the `llm/retry` SessionEventMap merge this fold counts.
import type {} from '@deepseek-ai/dsh-llm-retry'
import type { StatsCall, StatsStepMetrics } from './stats-contract.ts'
import { previewText } from './stats-format.ts'

/** One tool call accumulated inside a step. */
interface CallState {
  readonly name: string
  readonly startedAt: number
  endedAt: number | null
  error: boolean
  chars: number | null
}

/** Fold state of one step Context. */
interface StepState {
  readonly turn: number
  readonly step: number
  readonly startSeq: number
  readonly startTime: number
  closed: boolean
  endTime: number | null
  firstTokenTime: number | null
  messageTime: number | null
  interrupted: boolean
  usage: TokenUsage | null
  retries: number
  answerPreview: string | null
  readonly calls: Map<string, CallState>
}

/** Step-scoped event types that update one open step Context. */
type StepScopedEvent =
  | 'assistant/chunk'
  | 'assistant/message'
  | 'tool/call'
  | 'tool/result'
  | 'llm/retry'
  | 'step/end'

function stepId(turn: number, step: number): string {
  return `${turn}:${step}`
}

function eventStepId(event: SessionEvent<StepScopedEvent>): string {
  return stepId(event.data.turn, event.data.step)
}

/**
 * Sum character length of the model-facing text a content block carries.
 * @param block - one result content block.
 * @returns text length, zero for non-text blocks.
 */
function blockChars(block: ContentBlock): number {
  return block.type === 'text' || block.type === 'reasoning' ? block.text.length : 0
}

/**
 * Extract the joined visible text of an assembled assistant message.
 * @param blocks - assembled assistant content blocks.
 * @returns newline-joined text blocks.
 */
function answerText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Project one provider usage record onto the view's usage shape.
 * @param usage - reported usage, absent when the adapter reported none.
 * @returns the disjoint token counts, or null.
 */
function usageOf(usage: TokenUsage | undefined): StatsStepMetrics['usage'] {
  if (usage === undefined) return null
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
  }
}

/**
 * Measure the non-overlapping union of settled call wall intervals.
 * @param spans - settled calls' start/end pairs.
 * @returns union length, or null when no span settled.
 */
function unionSpan(spans: readonly { startedAt: number; endedAt: number }[]): number | null {
  const sorted = [...spans].sort((left, right) => left.startedAt - right.startedAt)
  const first = sorted[0]
  if (first === undefined) return null
  let total = 0
  let start = first.startedAt
  let end = first.endedAt
  for (const span of sorted.slice(1)) {
    if (span.startedAt > end) {
      total += end - start
      start = span.startedAt
      end = span.endedAt
      continue
    }
    end = Math.max(end, span.endedAt)
  }
  return total + (end - start)
}

/**
 * The step Definition: one Context per `step/start`, folding timing, usage,
 * tool pairs, and retries into one published metrics node.
 */
export const statsStepDefinition: ConversationNodeDefinition<StepState> = {
  kind: 'stats-step',
  target: 'stats',
  match: (event: SessionEvent) => {
    if (event.type === 'step/start') {
      return { id: stepId(event.data.turn, event.data.step), role: 'start' }
    }
    switch (event.type) {
      case 'assistant/chunk':
      case 'assistant/message':
      case 'tool/call':
      case 'tool/result':
      case 'llm/retry':
      case 'step/end':
        return { id: eventStepId(event), role: 'update' }
      default:
        return null
    }
  },
  start: (_context, match) => {
    /* v8 ignore next 3 -- the engine routes start matches only from match(), which returns them for step/start alone. */
    if (match.event.type !== 'step/start') {
      throw new Error('stats-step start requires step/start')
    }
    const event = match.event
    return {
      turn: event.data.turn,
      step: event.data.step,
      startSeq: event.seq,
      startTime: event.time,
      closed: false,
      endTime: null,
      firstTokenTime: null,
      messageTime: null,
      interrupted: false,
      usage: null,
      retries: 0,
      answerPreview: null,
      calls: new Map(),
    }
  },
  update: (context, match) => {
    const state = context.state
    const event = match.event
    switch (event.type) {
      case 'assistant/chunk': {
        if (state.firstTokenTime !== null || !isTokenDelta(event.data.chunk)) return state
        return { ...state, firstTokenTime: event.time }
      }
      case 'assistant/message': {
        const preview = previewText(answerText(event.data.message.content))
        return {
          ...state,
          messageTime: event.time,
          interrupted: event.data.interrupted === true,
          usage: event.data.usage ?? null,
          answerPreview: preview,
        }
      }
      case 'tool/call': {
        state.calls.set(String(event.data.callId), {
          name: event.data.name,
          startedAt: event.time,
          endedAt: null,
          error: false,
          chars: null,
        })
        return { ...state }
      }
      case 'tool/result': {
        const callId = String(event.data.message.source.callId)
        const call = state.calls.get(callId)
        if (call === undefined) return state
        const block = event.data.message.content[0]
        state.calls.set(callId, {
          ...call,
          endedAt: event.time,
          error: block.isError === true,
          chars: block.content.reduce((sum, part) => sum + blockChars(part), 0),
        })
        return { ...state }
      }
      case 'llm/retry':
        return { ...state, retries: state.retries + 1 }
      case 'step/end':
        return { ...state, closed: true, endTime: event.time }
      /* v8 ignore next 2 -- match() routes only the six cased update types; no other event reaches update. */
      default:
        return state
    }
  },
  publication: match => match.event.type === 'assistant/chunk' ? 'animation-frame' : 'immediate',
  buildViewNode: (context) => {
    const state = context.state
    /* v8 ignore next 2 -- the engine materializes nodes only from Contexts whose start produced state. */
    if (state === undefined) return null
    const calls: StatsCall[] = [...state.calls.entries()]
      .map(([callId, call]) => ({
        callId,
        name: call.name,
        startedAt: call.startedAt,
        endedAt: call.endedAt,
        ms: call.endedAt === null ? null : call.endedAt - call.startedAt,
        error: call.error,
        chars: call.chars,
      }))
      .sort((left, right) => left.startedAt - right.startedAt || left.callId.localeCompare(right.callId))
    let toolMs = 0
    let toolOpen = 0
    const spans: Array<{ startedAt: number; endedAt: number }> = []
    for (const call of calls) {
      if (call.ms === null || call.endedAt === null) {
        toolOpen += 1
        continue
      }
      toolMs += call.ms
      spans.push({ startedAt: call.startedAt, endedAt: call.endedAt })
    }
    const node: StatsConversationViewNode = {
      key: context.key,
      kind: context.kind,
      id: context.id,
      target: 'stats',
      anchorSeq: state.startSeq,
      data: {
        turn: state.turn,
        step: state.step,
        anchorSeq: state.startSeq,
        startTime: state.startTime,
        endTime: state.endTime,
        closed: state.closed,
        firstTokenTime: state.firstTokenTime,
        messageTime: state.messageTime,
        interrupted: state.interrupted,
        usage: usageOf(state.usage === null ? undefined : state.usage),
        retries: state.retries,
        calls,
        toolMs,
        toolWall: unionSpan(spans),
        toolOpen,
        answer: state.answerPreview,
      } satisfies StatsStepMetrics,
    }
    return node
  },
}
