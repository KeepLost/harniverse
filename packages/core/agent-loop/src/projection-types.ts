/**
 * Pure turn-boundary projection vocabulary for the agent loop.
 *
 * @module @deepseek-ai/dsh-agent-loop/projection-types
 */

/** Host projection of agent turn and step boundaries. */
export interface TurnBoundaryProjection {
  /** Seq of the open turn's `turn/start`, or null between turns. */
  readonly openTurnStartSeq: number | null
  /** Seq of the latest `step/start` event, or null before the first step. */
  readonly lastStepStartSeq: number | null
  /** The latest step boundary (`step/start` or `step/end`) and its seq, or null before the first step boundary. */
  readonly lastStepBoundary: { readonly kind: 'start' | 'end'; readonly seq: number } | null
  /** Turn number of the latest `turn/start`; 0 before the first turn. */
  readonly lastTurn: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Turn and step boundaries folded from the session log by the agent loop. */
    turnBoundary: TurnBoundaryProjection
  }
}
