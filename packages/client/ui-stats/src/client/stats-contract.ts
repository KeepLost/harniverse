/**
 * Published per-step facts model: step metrics folded from the session
 * window, turn rows aggregated from them, and whole-window totals. Pure data
 * shapes shared by the Definitions, the snapshot builder, and the view.
 *
 * @module @deepseek-ai/dsh-client-ui-stats/stats-contract
 */

/** Token usage counts one assistant message reported (disjoint: input excludes cached). */
export interface StatsUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

/** One paired tool call of a step with its measured facts. */
export interface StatsCall {
  readonly callId: string
  readonly name: string
  /** Wall-clock start of the call from its `tool/call` event. */
  readonly startedAt: number
  /** Wall-clock end from the paired `tool/result`, or null while open. */
  readonly endedAt: number | null
  /** Measured duration, or null while the result is missing. */
  readonly ms: number | null
  readonly error: boolean
  /** Character length of the model-facing result text, when assembled. */
  readonly chars: number | null
}

/** Per-step metrics published as one `stats` view node. */
export interface StatsStepMetrics {
  readonly turn: number
  readonly step: number
  readonly anchorSeq: number
  readonly startTime: number | null
  readonly endTime: number | null
  /** Closed when `step/end` landed in the window. */
  readonly closed: boolean
  /** Step carries a recorded first stream token. */
  readonly firstTokenTime: number | null
  /** Assembled-message time, or null while the step streams or was cut before assembly. */
  readonly messageTime: number | null
  /** The assembled message was the visible prefix finalized by cancellation. */
  readonly interrupted: boolean
  readonly usage: StatsUsage | null
  readonly retries: number
  readonly calls: readonly StatsCall[]
  /** Sum of paired call durations (parallel calls each count in full). */
  readonly toolMs: number
  /** Union of paired call wall intervals; null when no call settled. */
  readonly toolWall: number | null
  /** Count of calls whose result is still missing. */
  readonly toolOpen: number
  readonly answer: string | null
}

/** Trigger facts of one waking user message of a turn. */
export interface StatsTrigger {
  readonly sourceKind: string
  /** Producer plugin name for `plugin`-source injections. */
  readonly plugin: string | null
  /** Declared context form of an injection, when one was declared. */
  readonly form: string | null
  /** One-line account of a `notice`-form injection. */
  readonly summary: string | null
  readonly preview: string | null
  readonly files: number
  readonly images: number
}

/** One compaction transaction's facts. */
export interface StatsCompactionFacts {
  readonly anchorSeq: number
  readonly turn: number | null
  readonly startedAt: number
  readonly endedAt: number | null
  readonly provider: string | null
  readonly model: string | null
  readonly usage: StatsUsage | null
  readonly shadowedTokenCount: number | null
  readonly error: string | null
}

/** One aggregated turn row. */
export interface StatsTurnRow {
  readonly kind: 'turn'
  readonly turn: number
  /** `turn/end` landed for this turn. */
  readonly ended: boolean
  /** Close reason kind recorded by `turn/end`, when one landed. */
  readonly closeKind: string | null
  readonly closeTime: number | null
  readonly trigger: StatsTrigger | null
  readonly steps: readonly StatsStepMetrics[]
  /** Numbered compactions that ran inside this turn. */
  readonly compactions: readonly StatsCompactionFacts[]
}

/** Standalone (between-turns) compaction row. */
export interface StatsCompactionRow {
  readonly kind: 'compaction'
  readonly facts: StatsCompactionFacts
}

/** Ordered row union rendered by the view. */
export type StatsRow = StatsTurnRow | StatsCompactionRow

/** Whole-loaded-window figures for the totals header. */
export interface StatsTotals {
  readonly turns: number
  readonly steps: number
  /** Summed uncached input tokens over usage-reporting steps. */
  readonly inputTokens: number
  readonly llmMs: number
  readonly toolMs: number
  readonly ttftMs: number
  readonly ttftSteps: number
  readonly decodeMs: number
  readonly decodeTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly retries: number
  readonly toolErrors: number
}

/** Immutable `stats` view snapshot: ordered rows plus window totals. */
export interface StatsSnapshot {
  readonly rows: readonly StatsRow[]
  readonly totals: StatsTotals
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationViewSnapshotMap {
    /** Independently aggregated per-step facts consumed by the stats view. */
    stats: StatsSnapshot
  }
}

/** One `stats` view node: the target envelope plus its ordering anchor. */
export interface StatsConversationViewNode {
  readonly key: string
  readonly kind: string
  readonly id: string
  readonly target: 'stats'
  /** Sequence of the node's opening event, ordering rows in the view. */
  readonly anchorSeq: number
  readonly data: unknown
}

/** Stable empty snapshot used before a Session assembled any stats node. */
export const EMPTY_STATS_SNAPSHOT: StatsSnapshot = {
  rows: [],
  totals: {
    turns: 0,
    steps: 0,
    inputTokens: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    retries: 0,
    toolErrors: 0,
  },
}
