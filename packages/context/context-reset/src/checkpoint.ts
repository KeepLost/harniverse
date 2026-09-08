/**
 * Context-reset checkpoint provenance: the correlated source constructor, the
 * verbatim marker content, and the predicate that recognizes persisted reset
 * checkpoints.
 *
 * This module is a pure type/value/predicate outlet (no cordis imports, no
 * module augmentation) so client and wire programs can name the reset
 * checkpoint source without loading the host plugin's Context merges — the
 * `dsh-compaction/checkpoint` shape.
 *
 * @module @deepseek-ai/dsh-context-reset/checkpoint
 */

import type { MessageSource } from '@deepseek-ai/dsh-llm/message'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { ResetId } from './brand.ts'

const RESET_CHECKPOINT_MARKER = Object.freeze({ kind: 'plugin', plugin: 'reset' } as const)

/** Message provenance carried by a concrete context-reset checkpoint. */
export type ResetCheckpointSource = typeof RESET_CHECKPOINT_MARKER & {
  readonly resetId: ResetId
  readonly sourceCommandId?: CommandId
}

const RESET_MARKER_TEXT =
  'This is an automatically generated context reset. All prior conversation history has been removed from your context; you have no memory of anything before this marker. The retained log stays searchable, but do not assume knowledge of it. Treat the messages that follow as the beginning of a fresh context and continue the task directly, without acknowledging this marker.'

/**
 * The verbatim model-visible content of one context-reset checkpoint marker.
 * @returns one-block marker content.
 */
export function resetCheckpointContent(): ContentBlock[] {
  return [{ type: 'text', text: RESET_MARKER_TEXT }]
}

/**
 * Create checkpoint provenance correlated with one reset transaction.
 * @param resetId - owning reset identity.
 * @param sourceCommandId - initiating manual command, when present.
 * @returns immutable checkpoint source.
 */
export function resetCheckpointSource(
  resetId: ResetId,
  sourceCommandId?: CommandId,
): ResetCheckpointSource {
  return Object.freeze({
    ...RESET_CHECKPOINT_MARKER,
    resetId,
    ...sourceCommandId === undefined ? {} : { sourceCommandId },
  })
}

/**
 * Test whether a persisted message source identifies a context-reset checkpoint.
 * @param source - source restored from a surface user message.
 * @returns whether the source carries the reset checkpoint marker.
 */
export function isResetCheckpointSource(source: MessageSource): source is ResetCheckpointSource {
  return source.kind === 'plugin' && source.plugin === RESET_CHECKPOINT_MARKER.plugin
}
