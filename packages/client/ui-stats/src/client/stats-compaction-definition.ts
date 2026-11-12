/**
 * The `stats-compaction` Definition: one Context per compaction transaction
 * (`compaction/start` → optional `compaction/summary` → `compaction/end`),
 * publishing its wall time, provider/model facts, usage, shadowed token
 * count, and error. Standalone transactions (turn null) render as
 * between-turn rows; numbered ones attach to their owning turn.
 *
 * @module @deepseek-ai/dsh-client-ui-stats/stats-compaction-definition
 */

import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import type { StatsConversationViewNode } from './stats-contract.ts'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the `compaction/*` SessionEventMap merge this fold reads.
import type {} from '@deepseek-ai/dsh-compaction'
import type { StatsCompactionFacts } from './stats-contract.ts'

/** Fold state of one compaction Context. */
interface CompactionState {
  readonly compactionId: string
  readonly seq: number
  readonly turn: number | null
  readonly startedAt: number
  endedAt: number | null
  provider: string | null
  model: string | null
  usage: TokenUsage | null
  shadowedTokenCount: number | null
  error: string | null
}

export const statsCompactionDefinition: ConversationNodeDefinition<CompactionState> = {
  kind: 'stats-compaction',
  target: 'stats',
  match: (event: SessionEvent) => {
    if (event.type === 'compaction/start') {
      return { id: String(event.data.compactionId), role: 'start' }
    }
    if (event.type === 'compaction/summary' || event.type === 'compaction/end') {
      return { id: String(event.data.compactionId), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    /* v8 ignore next 3 -- the engine routes start matches only from match(), which returns them for compaction/start alone. */
    if (match.event.type !== 'compaction/start') {
      throw new Error('stats-compaction start requires compaction/start')
    }
    const event = match.event
    return {
      compactionId: String(event.data.compactionId),
      seq: event.seq,
      turn: event.data.turn,
      startedAt: event.time,
      endedAt: null,
      provider: null,
      model: null,
      usage: null,
      shadowedTokenCount: null,
      error: null,
    }
  },
  update: (context, match) => {
    const state = context.state
    if (match.event.type === 'compaction/summary') {
      return {
        ...state,
        provider: match.event.data.provider,
        model: match.event.data.model,
        usage: match.event.data.usage ?? null,
        shadowedTokenCount: match.event.data.shadowedTokenCount,
      }
    }
    if (match.event.type === 'compaction/end') {
      return {
        ...state,
        endedAt: match.event.time,
        ...(match.event.data.error === undefined ? {} : { error: match.event.data.error }),
      }
    }
    /* v8 ignore next 2 -- match() routes only summary/end updates; compaction/start always opens a Context instead. */
    return state
  },
  publication: () => 'none',
  buildViewNode: (context) => {
    const state = context.state
    /* v8 ignore next 2 -- the engine materializes nodes only from Contexts whose start produced state. */
    if (state === undefined) return null
    const node: StatsConversationViewNode = {
      key: context.key,
      kind: context.kind,
      id: context.id,
      target: 'stats',
      anchorSeq: state.seq,
      data: {
        anchorSeq: state.seq,
        turn: state.turn,
        startedAt: state.startedAt,
        endedAt: state.endedAt,
        provider: state.provider,
        model: state.model,
        usage: state.usage === null ? null : {
          inputTokens: state.usage.inputTokens,
          outputTokens: state.usage.outputTokens,
          ...(state.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: state.usage.cacheReadTokens }),
          ...(state.usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: state.usage.cacheWriteTokens }),
        },
        shadowedTokenCount: state.shadowedTokenCount,
        error: state.error,
      } satisfies StatsCompactionFacts,
    }
    return node
  },
}
