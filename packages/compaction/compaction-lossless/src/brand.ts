import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable identity of one summary node in a session's compaction DAG. */
export type CompactionSummaryId = Branded<'CompactionSummaryId'>

/**
 * Brand a durable summary identity derived from its owning session event.
 * @param value - stable identity text.
 * @returns the branded summary identity.
 */
export function CompactionSummaryId(value: string): CompactionSummaryId {
  return value as CompactionSummaryId
}
