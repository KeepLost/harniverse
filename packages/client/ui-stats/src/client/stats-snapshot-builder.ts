/**
 * The `stats` view target: a keyed per-Session builder that keeps the latest
 * node set and re-aggregates rows and totals on every transaction. Also the
 * registration seam for the Definitions and the target itself.
 *
 * @module @deepseek-ai/dsh-client-ui-stats/stats-snapshot-builder
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationViewBuilder, ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import { aggregateStats } from './stats-aggregate.ts'
import type { StatsConversationViewNode } from './stats-contract.ts'
import type { StatsSnapshot } from './stats-contract.ts'
import { EMPTY_STATS_SNAPSHOT } from './stats-contract.ts'
import { statsCompactionDefinition } from './stats-compaction-definition.ts'
import { statsPromptDefinition } from './stats-prompt-definition.ts'
import { statsStepDefinition } from './stats-step-definition.ts'
import { statsTurnEndDefinition } from './stats-turn-end-definition.ts'

/** Keyed adapter over the aggregated stats snapshot. */
export class StatsSnapshotBuilder implements ConversationViewBuilder<StatsConversationViewNode, StatsSnapshot> {
  private readonly nodes = new Map<string, StatsConversationViewNode>()
  readonly empty = EMPTY_STATS_SNAPSHOT

  replace(input: {
    readonly nodes: readonly StatsConversationViewNode[]
  }): StatsSnapshot {
    this.nodes.clear()
    for (const node of input.nodes) this.nodes.set(node.key, node)
    return aggregateStats([...this.nodes.values()])
  }

  apply(input: {
    readonly upserts: readonly StatsConversationViewNode[]
  }): StatsSnapshot {
    for (const node of input.upserts) this.nodes.set(node.key, node)
    return aggregateStats([...this.nodes.values()])
  }
}

/** Stats target factory preserving the keyed node model. */
export const statsViewDefinition: ConversationViewDefinition<StatsConversationViewNode, StatsSnapshot> = {
  target: 'stats',
  create: () => new StatsSnapshotBuilder(),
}

/**
 * Register the stats target builder and its Definitions.
 * @param ctx - Plugin context receiving the registrations.
 */
export function registerStatsConversation(ctx: Context): void {
  ctx.conversationEvents.register(statsStepDefinition)
  ctx.conversationEvents.register(statsPromptDefinition)
  ctx.conversationEvents.register(statsTurnEndDefinition)
  ctx.conversationEvents.register(statsCompactionDefinition)
  ctx.conversationViews.register(statsViewDefinition)
}
