/**
 * The `stats-turn-end` Definition: one Context per `turn/end`, publishing the
 * close marker (reason kind and time) the aggregation uses to close an
 * interrupted tail and to render the turn's outcome.
 *
 * @module @deepseek-ai/dsh-client-ui-stats/stats-turn-end-definition
 */

import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import type { StatsConversationViewNode } from './stats-contract.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

/** Fold state of one turn-close Context. */
interface TurnEndState {
  readonly turn: number
  readonly seq: number
  readonly time: number
  readonly closeKind: string
}

/** Published turn-close node data. */
export interface StatsTurnEndNodeData {
  readonly turn: number
  readonly time: number
  readonly closeKind: string
}

/**
 * The turn-close Definition: one Context per `turn/end`, publishing the close
 * marker the aggregation uses for interrupted tails and outcome badges.
 */
export const statsTurnEndDefinition: ConversationNodeDefinition<TurnEndState> = {
  kind: 'stats-turn-end',
  target: 'stats',
  match: (event: SessionEvent) => event.type === 'turn/end'
    ? { id: String(event.data.turn), role: 'start' }
    : null,
  start: (_context, match) => {
    /* v8 ignore next 3 -- the engine routes start matches only from match(), which returns them for turn/end alone. */
    if (match.event.type !== 'turn/end') {
      throw new Error('stats-turn-end start requires turn/end')
    }
    const event = match.event
    return {
      turn: event.data.turn,
      seq: event.seq,
      time: event.time,
      closeKind: event.data.reason.kind,
    }
  },
  update: context => context.state,
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
        turn: state.turn,
        time: state.time,
        closeKind: state.closeKind,
      } satisfies StatsTurnEndNodeData,
    }
    return node
  },
}
