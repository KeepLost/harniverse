/**
 * Durable agent session-event vocabulary shared with type-only consumers.
 *
 * @module @deepseek-ai/dsh-agent/types
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm/types'

/** One of the two ordered pending-message lists owned by an agent. */
export type InboxTarget = 'next-turn' | 'next-step'

/** Cumulative session cost a driver reported, in the unit it named. */
export interface AgentContextCost {
  readonly amount: number
  /** ISO code for money, or the driver's own unit, such as `credits`. */
  readonly currency: string
}

/**
 * Context-window accounting a step driver reported for a context the harness
 * does not assemble: the driver's own, counted by whoever holds it. A model
 * loop reports its accounting on its `assistant/message` instead and writes
 * no `agent/context`.
 */
export interface AgentContextEventData {
  /** Tokens the driver's context holds now; a non-negative safe integer. */
  readonly used: number
  /** Size in tokens of the window the driver budgets against; a positive safe integer once known. */
  readonly size?: number
  /** Session cost so far; absent until the driver reports one. */
  readonly cost?: AgentContextCost
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One normalized mutation of an agent's durable pending-message lists.
     * Live dispatch precedes projection mutation, so synchronous observers may
     * read the pre-splice inbox to recover the removed messages.
     */
    'agent/inbox/spliced': {
      target: InboxTarget
      start: number
      removedCount?: number
      inserted: UserMessage[]
      outcome?: 'canceled'
    }
    /**
     * The latest context-window accounting a step driver reported for its own
     * context. Whole-value record, latest wins on replay. The token meter's
     * occupancy reading and a person reading the log consume it; nothing
     * derives model-visible history from it. Log-only.
     */
    'agent/context': AgentContextEventData
  }
}
