/**
 * Context-reset vocabulary: the durable cut-anchor event and the result type.
 * The log-only `reset/checkpoint` immediately precedes the replacement
 * `user/message` marker; its seq is the display checkpoint's cited start.
 * @module @deepseek-ai/dsh-context-reset/types
 */

import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { ResetId } from './brand.ts'

export type { ResetId }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Durable anchor of one context reset — log-only, no surfaceOp. Written
     * immediately before the replacement `user/message` marker so the display
     * checkpoint has a transaction start to cite, the `compaction/start`
     * shape. `turn` is always `null`: a reset claims the idle maintenance
     * phase between turns.
     */
    'reset/checkpoint': {
      resetId: ResetId
      sourceCommandId?: CommandId
      turn: null
    }
  }
}

/** Result of one successful whole-surface context reset. */
export interface ContextResetResult {
  /** Stable identity of this reset checkpoint. */
  readonly resetId: ResetId
  /** Human command that initiated this reset, when it was manual. */
  readonly sourceCommandId?: CommandId
  /** The seq of the appended `reset/checkpoint` anchor. */
  readonly checkpointSeq: number
  /** The seq of the appended reset checkpoint `user/message`. */
  readonly markerSeq: number
  /** The seqs of all shadowed surface nodes, in surface order. */
  readonly shadowedSeqs: readonly number[]
}
