/**
 * Pure aggregation of `stats` view nodes into ordered rows and whole-window
 * totals. Deterministic over the node set alone: turn rows group their steps
 * by the step's own turn coordinates, prompts attach to their resolved turn
 * (or the next step's turn when unresolved), and standalone compactions stay
 * between-turn rows.
 *
 * @module @deepseek-ai/dsh-client-ui-stats/stats-aggregate
 */

import type {
  StatsCompactionFacts, StatsConversationViewNode, StatsRow, StatsSnapshot, StatsStepMetrics,
  StatsTotals, StatsTrigger,
} from './stats-contract.ts'
import { EMPTY_STATS_SNAPSHOT } from './stats-contract.ts'
import type { StatsPromptNodeData } from './stats-prompt-definition.ts'
import type { StatsTurnEndNodeData } from './stats-turn-end-definition.ts'

/** Writeable totals accumulator; frozen into the published snapshot. */
type MutableTotals = { -readonly [Key in keyof StatsTotals]: StatsTotals[Key] }

interface MutableTurnRow {
  kind: 'turn'
  turn: number
  ended: boolean
  closeKind: string | null
  closeTime: number | null
  trigger: StatsTrigger | null
  steps: StatsStepMetrics[]
  compactions: StatsCompactionFacts[]
}

/** Discriminate one step node by kind. */
function isStepNode(node: StatsConversationViewNode): node is StatsConversationViewNode & { data: StatsStepMetrics } {
  return node.kind === 'stats-step'
}

/** Discriminate one prompt node by kind. */
function isPromptNode(node: StatsConversationViewNode): node is StatsConversationViewNode & { data: StatsPromptNodeData } {
  return node.kind === 'stats-prompt'
}

/** Discriminate one turn-close node by kind. */
function isTurnEndNode(node: StatsConversationViewNode): node is StatsConversationViewNode & { data: StatsTurnEndNodeData } {
  return node.kind === 'stats-turn-end'
}

/** Discriminate one compaction node by kind. */
function isCompactionNode(node: StatsConversationViewNode): node is StatsConversationViewNode & { data: StatsCompactionFacts } {
  return node.kind === 'stats-compaction'
}

/**
 * Fold one step's facts into the running totals.
 * @param totals - mutable accumulator.
 * @param step - one step's published metrics.
 */
function addStep(totals: MutableTotals, step: StatsStepMetrics): void {
  totals.steps += 1
  totals.inputTokens += step.usage?.inputTokens ?? 0
  if (step.messageTime !== null && step.startTime !== null) totals.llmMs += step.messageTime - step.startTime
  totals.toolMs += step.toolMs
  if (step.firstTokenTime !== null && step.startTime !== null) {
    totals.ttftMs += step.firstTokenTime - step.startTime
    totals.ttftSteps += 1
  }
  if (step.messageTime !== null && step.firstTokenTime !== null) {
    totals.decodeMs += step.messageTime - step.firstTokenTime
    totals.decodeTokens += step.usage?.outputTokens ?? 0
  }
  totals.outputTokens += step.usage?.outputTokens ?? 0
  totals.cacheReadTokens += step.usage?.cacheReadTokens ?? 0
  totals.cacheWriteTokens += step.usage?.cacheWriteTokens ?? 0
  totals.retries += step.retries
  totals.toolErrors += step.calls.filter(call => call.error).length
}

/**
 * Aggregate the complete node set into the snapshot's rows and totals.
 * @param nodes - every live `stats` node, in any order.
 * @returns the rebuilt snapshot.
 */
export function aggregateStats(nodes: readonly StatsConversationViewNode[]): StatsSnapshot {
  const ordered = [...nodes].sort((left, right) => left.anchorSeq - right.anchorSeq)
  const turns = new Map<number, MutableTurnRow>()
  const totals: MutableTotals = { ...EMPTY_STATS_SNAPSHOT.totals }
  const rowOrder: Array<{ anchorSeq: number; row: StatsRow }> = []
  const pendingPrompts: Array<{ anchorSeq: number; turn: number | null; trigger: StatsTrigger }> = []

  const turnRow = (turn: number, anchorSeq: number): MutableTurnRow => {
    const existing = turns.get(turn)
    if (existing !== undefined) return existing
    const created: MutableTurnRow = {
      kind: 'turn',
      turn,
      ended: false,
      closeKind: null,
      closeTime: null,
      trigger: null,
      steps: [],
      compactions: [],
    }
    turns.set(turn, created)
    totals.turns += 1
    rowOrder.push({ anchorSeq, row: created })
    return created
  }

  for (const node of ordered) {
    if (isStepNode(node)) {
      turnRow(node.data.turn, node.anchorSeq).steps.push(node.data)
      addStep(totals, node.data)
      continue
    }
    if (isPromptNode(node)) {
      pendingPrompts.push({ anchorSeq: node.anchorSeq, turn: node.data.turn, trigger: node.data.trigger })
      continue
    }
    if (isTurnEndNode(node)) {
      const row = turnRow(node.data.turn, node.anchorSeq)
      row.ended = true
      row.closeKind = node.data.closeKind
      row.closeTime = node.data.time
      continue
    }
    /* v8 ignore next 4 -- only this package's four Definitions own the stats target; a foreign kind cannot enter the builder. */
    if (isCompactionNode(node)) {
      const facts = node.data
      if (facts.turn === null) {
        rowOrder.push({ anchorSeq: node.anchorSeq, row: { kind: 'compaction', facts } })
        continue
      }
      turnRow(facts.turn, node.anchorSeq).compactions.push(facts)
    }
  }

  for (const pending of pendingPrompts) {
    if (pending.turn !== null) {
      const row = turns.get(pending.turn)
      if (row !== undefined && row.trigger === null) row.trigger = pending.trigger
      continue
    }
    const host = rowOrder
      .map(entry => entry.row)
      .find((row): row is MutableTurnRow => row.kind === 'turn'
        && row.steps.some(step => step.anchorSeq > pending.anchorSeq))
    if (host !== undefined && host.trigger === null) host.trigger = pending.trigger
  }

  rowOrder.sort((left, right) => left.anchorSeq - right.anchorSeq)
  return {
    rows: rowOrder.map(entry => entry.row),
    totals,
  }
}
