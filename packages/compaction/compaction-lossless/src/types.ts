import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { CompactionSummaryId } from './brand.ts'

/** One persisted summary node projected from a `compaction/summary` event. */
export interface CompactionHistoryNode {
  readonly id: CompactionSummaryId
  readonly sessionId: SessionId
  readonly eventSeq: number
  readonly kind: 'leaf' | 'condensed'
  readonly depth: number
  readonly content: ContentBlock[]
  readonly text: string
  readonly parentIds: CompactionSummaryId[]
  readonly sourceEventSeqs: number[]
  readonly shadowedRange: { readonly start: number; readonly end: number }
  readonly shadowedTokenCount: number
  readonly provider: string
  readonly model: string
  readonly createdAt: number
}

/** One committed node referenced by id, kind, and depth inside a lineage chain. */
export interface CompactionHistoryNodeRef {
  readonly id: CompactionSummaryId
  readonly kind: CompactionHistoryNode['kind']
  readonly depth: number
}

/** Structural descriptor of one committed summary node for inspection surfaces. */
export interface CompactionHistoryNodeSummary {
  readonly id: CompactionSummaryId
  readonly kind: CompactionHistoryNode['kind']
  readonly depth: number
  readonly eventSeq: number
  readonly shadowedRange: { readonly start: number; readonly end: number }
  readonly shadowedTokenCount: number
  readonly summaryTokenCount: number
  readonly parentCount: number
  readonly sourceCount: number
  readonly lineage: readonly CompactionHistoryNodeRef[]
  readonly provider: string
  readonly model: string
  readonly createdAt: number
}

/** One summary-text hit carrying its DAG coordinates. */
export interface CompactionSummaryHit {
  readonly kind: 'summary'
  readonly id: CompactionSummaryId
  readonly nodeKind: CompactionHistoryNode['kind']
  readonly depth: number
  readonly eventSeq: number
  readonly snippet: string
  readonly tokenCount: number
  readonly shadowedRange: { readonly start: number; readonly end: number }
  readonly lineage: readonly CompactionHistoryNodeRef[]
}

/** One source-message hit positioned by the committed node that covers it. */
export interface CompactionSourceHit {
  readonly kind: 'source'
  readonly eventSeq: number
  readonly role: string
  readonly snippet: string
  readonly node: CompactionHistoryNodeRef & {
    readonly shadowedRange: { readonly start: number; readonly end: number }
  }
}

/** One bounded search hit over the current session's summary DAG. */
export type CompactionHistorySearchHit = CompactionSummaryHit | CompactionSourceHit

/** Caller-selected corpus and bounds for one summary-DAG search. */
export interface CompactionHistorySearchOptions {
  /** Exact DAG depth to restrict the scan to; omit for all levels. */
  readonly depth?: number
  /** Text corpus to scan: summaries, their cited source messages, or both. */
  readonly scope?: 'summaries' | 'sources' | 'both'
  /** Requested result count across both corpora, capped by provider configuration. */
  readonly limit?: number
}

/** Where one log event sits relative to the committed summary DAG. */
export type CompactionHistoryLocation =
  | { readonly status: 'live' }
  | { readonly status: 'pending' }
  | {
    readonly status: 'shadowed'
    readonly relation: 'source' | 'checkpoint' | 'other'
    readonly node: CompactionHistoryNodeSummary
  }

/** A source message recovered from a leaf summary. */
export interface CompactionSummarySource {
  readonly eventSeq: number
  readonly role: string
  readonly text: string
}

/** Bounded recursive expansion result. */
export interface CompactionSummaryExpansion {
  readonly id: CompactionSummaryId
  readonly kind: CompactionHistoryNode['kind']
  readonly depth: number
  readonly eventSeq: number
  readonly text: string
  readonly parents: CompactionSummaryExpansion[]
  readonly sources: CompactionSummarySource[]
  readonly tokenCap: number
  readonly estimatedTokens: number
  readonly truncated: boolean
}

/** Caller-selected bounds for one summary-DAG expansion. */
export interface CompactionSummaryExpansionOptions {
  /** Maximum number of summary levels to return. */
  readonly maxDepth?: number
  /** Maximum deterministic estimated tokens across returned history payloads. */
  readonly tokenCap?: number
  /** Whether to include raw message sources cited directly by expanded nodes. */
  readonly includeSources?: boolean
}

/** Summary-DAG search and expansion service configuration. */
export interface CompactionHistoryConfig {
  /** Maximum summary hits returned by one search. Defaults to 20. */
  readonly maxSearchResults?: number
  /** Maximum summary levels returned by one expansion. Defaults to 3. */
  readonly maxExpansionDepth?: number
  /** Maximum deterministic estimated tokens returned by one expansion. Defaults to 4000. */
  readonly maxExpansionTokens?: number
}

/** The event shape consumed by the history index. */
export type CompactionSummaryEvent = SessionEvent<'compaction/summary'>
