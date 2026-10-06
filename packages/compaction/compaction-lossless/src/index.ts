/**
 * Lossless-style summary DAG provider for the Harniverse compaction seam.
 *
 * The raw Session event log remains canonical. This service derives a bounded
 * summary index from durable `compaction/summary` events and the provider below
 * reuses the existing pressure, overflow, locking, and surface transaction.
 * @module @deepseek-ai/dsh-compaction-lossless
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import type { CompactionCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { CompactionSummaryId } from './brand.ts'
import type {
  CompactionHistoryConfig,
  CompactionHistoryLocation,
  CompactionHistoryNodeRef,
  CompactionHistoryNodeSummary,
  CompactionHistorySearchHit,
  CompactionHistorySearchOptions,
  CompactionSummaryExpansion,
  CompactionSummaryExpansionOptions,
  CompactionSummaryEvent,
  CompactionHistoryNode,
  CompactionSummarySource,
} from './types.ts'

import type {} from '@deepseek-ai/dsh-compaction'

export { CompactionSummaryId } from './brand.ts'
export type {
  CompactionHistoryConfig,
  CompactionHistoryLocation,
  CompactionHistoryNodeRef,
  CompactionHistoryNodeSummary,
  CompactionHistorySearchHit,
  CompactionHistorySearchOptions,
  CompactionSummaryHit,
  CompactionSummaryExpansion,
  CompactionSummaryExpansionOptions,
  CompactionHistoryNode,
  CompactionSourceHit,
  CompactionSummarySource,
} from './types.ts'

const DEFAULT_MAX_SEARCH_RESULTS = 20
const DEFAULT_MAX_EXPANSION_DEPTH = 3
const DEFAULT_MAX_EXPANSION_TOKENS = 4_000

/** Full provider configuration, including inherited BasicCompaction policy. */
export interface Config extends BasicCompactionConfig, CompactionHistoryConfig {}

/** Schemastery configuration consumed by Loader and config catalog generation. */
export const Config = z.intersect([
  BasicCompactionEngine.Config,
  z.object({
    maxSearchResults: z.number().step(1).min(1).default(DEFAULT_MAX_SEARCH_RESULTS),
    maxExpansionDepth: z.number().step(1).min(1).default(DEFAULT_MAX_EXPANSION_DEPTH),
    maxExpansionTokens: z.number().step(1).min(1).default(DEFAULT_MAX_EXPANSION_TOKENS),
  }) as unknown as z<CompactionHistoryConfig>,
]) as unknown as z<Config>

interface ResolvedHistoryConfig {
  readonly maxSearchResults: number
  readonly maxExpansionDepth: number
  readonly maxExpansionTokens: number
}

interface SessionIndex {
  readonly session: Session
  readonly byId: Map<string, CompactionHistoryNode>
  readonly byCheckpointSeq: Map<number, CompactionHistoryNode>
  readonly pendingByCompactionId: Map<string, CompactionHistoryNode>
}

function resolveHistoryConfig(config: CompactionHistoryConfig = {}): ResolvedHistoryConfig {
  const maxSearchResults = config.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS
  const maxExpansionDepth = config.maxExpansionDepth ?? DEFAULT_MAX_EXPANSION_DEPTH
  const maxExpansionTokens = config.maxExpansionTokens ?? DEFAULT_MAX_EXPANSION_TOKENS
  if (!Number.isSafeInteger(maxSearchResults) || maxSearchResults < 1) {
    throw new TypeError('compaction-lossless: maxSearchResults must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxExpansionDepth) || maxExpansionDepth < 1) {
    throw new TypeError('compaction-lossless: maxExpansionDepth must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxExpansionTokens) || maxExpansionTokens < 1) {
    throw new TypeError('compaction-lossless: maxExpansionTokens must be a positive safe integer')
  }
  return { maxSearchResults, maxExpansionDepth, maxExpansionTokens }
}

function contentText(content: readonly ContentBlock[]): string {
  return content.map((block) => {
    if (block.type === 'text') return block.text
    return JSON.stringify(block)
  }).join('\n').trim()
}

function estimateTokens(text: string): number {
  let units = 0
  for (const char of text) units += (char.codePointAt(0) as number) > 0x7f ? 2 : 1
  return Math.ceil(units / 4)
}

/**
 * Truncate history text with the provider's deterministic token estimate.
 * @param text - historical text to bound.
 * @param tokenCap - positive maximum estimated token count.
 * @returns bounded text, its estimated token count, and whether content was omitted.
 */
export function truncateHistoryText(
  text: string,
  tokenCap: number,
): { text: string; tokens: number; truncated: boolean } {
  const unitCap = tokenCap * 4
  let units = 0
  let bounded = ''
  for (const char of text) {
    const charUnits = (char.codePointAt(0) as number) > 0x7f ? 2 : 1
    if (units + charUnits > unitCap) break
    bounded += char
    units += charUnits
  }
  return {
    text: bounded,
    tokens: Math.ceil(units / 4),
    truncated: bounded.length < text.length,
  }
}

function boundedSnippet(text: string, maxChars = 240): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`
}

/**
 * Deterministic deepest-parent chain from one node toward a DAG root,
 * ordered root first. A condensed round with several parents still reports
 * every parent through its descriptor's parent count and node expansion.
 * @param index - session index holding the committed nodes.
 * @param node - node whose ancestry is rendered.
 * @returns ancestor references from the root down to the immediate parent.
 */
function lineageOf(index: SessionIndex, node: CompactionHistoryNode): CompactionHistoryNodeRef[] {
  const chain: CompactionHistoryNodeRef[] = []
  const seen = new Set<string>([node.id])
  for (let current = node; current.parentIds.length > 0; ) {
    let parent: CompactionHistoryNode | undefined
    for (const id of current.parentIds) {
      const candidate = index.byId.get(id)
      /* v8 ignore next -- parents are committed, deduplicated, and strictly earlier by construction */
      if (candidate === undefined || seen.has(candidate.id)) continue
      if (parent === undefined || candidate.depth > parent.depth) parent = candidate
    }
    /* v8 ignore next -- the guard above keeps parent defined whenever any parent resolves */
    if (parent === undefined) break
    seen.add(parent.id)
    chain.push({ id: parent.id, kind: parent.kind, depth: parent.depth })
    current = parent
  }
  return chain.reverse()
}

function messageText(session: Session, seq: number): CompactionSummarySource | undefined {
  const event = session.events[seq]
  if (event === undefined) return undefined
  const message = session.deriveEventMessage(event)
  if (message === null) return undefined
  return {
    eventSeq: seq,
    role: message.role,
    text: contentText(message.content),
  }
}

/** Live in-memory projection of committed summary nodes recorded in each Session log. */
export class CompactionHistory extends Service {
  static inject = ['sessions']

  /** Validated search and expansion limits used by this projection. */
  readonly config: Readonly<Required<CompactionHistoryConfig>>
  private readonly indexes = new Map<SessionId, SessionIndex>()

  constructor(ctx: Context, config: CompactionHistoryConfig = {}) {
    super(ctx, 'compactionHistory')
    this.config = resolveHistoryConfig(config)
    for (const session of ctx.sessions.list()) this.attach(session)
    ctx.on('session/created', (session) => {
      this.attach(session)
    })
    ctx.on('session/disposed', (session) => {
      this.indexes.delete(session.id)
    })
    ctx.on('session/event', (session, event) => {
      const index = this.indexes.get(session.id)
      if (index === undefined || index.session !== session) {
        this.attach(session)
        return
      }
      this.indexEvent(index, event)
    })
  }

  /**
   * List every committed summary node of one live session as a structural
   * descriptor, oldest first.
   * @param sessionId - session whose committed nodes are described.
   * @returns structural descriptors ordered by commit event seq.
   * @throws when the session is not live in this projection.
   */
  list(sessionId: SessionId): CompactionHistoryNodeSummary[] {
    const index = this.requireIndex(sessionId)
    return [...index.byId.values()]
      .sort((a, b) => a.eventSeq - b.eventSeq)
      .map(node => this.describeNode(index, node))
  }

  /**
   * Search summary text and the source messages committed nodes cite.
   * @param sessionId - session whose committed summary DAG is searched.
   * @param query - case-insensitive terms that every matching text contains.
   * @param options - corpus scope, exact depth restriction, and result cap.
   * @returns newest matching hits first, each carrying its DAG coordinates.
   * @throws when the session is not live in this projection.
   */
  search(
    sessionId: SessionId,
    query: string,
    options: CompactionHistorySearchOptions = {},
  ): CompactionHistorySearchHit[] {
    const index = this.requireIndex(sessionId)
    const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)
    if (terms.length === 0) return []
    const max = Math.min(this.config.maxSearchResults, Math.max(1, Math.floor(options.limit ?? this.config.maxSearchResults)))
    const scope = options.scope ?? 'summaries'
    const matches = (text: string): boolean => {
      const lowered = text.toLocaleLowerCase()
      return terms.every(term => lowered.includes(term))
    }
    const nodes = [...index.byId.values()]
      .filter(node => options.depth === undefined || node.depth === options.depth)
      .sort((a, b) => b.eventSeq - a.eventSeq)
    const hits: CompactionHistorySearchHit[] = []
    if (scope !== 'sources') {
      for (const node of nodes) {
        if (!matches(node.text)) continue
        hits.push({
          kind: 'summary',
          id: node.id,
          nodeKind: node.kind,
          depth: node.depth,
          eventSeq: node.eventSeq,
          snippet: boundedSnippet(node.text),
          tokenCount: estimateTokens(node.text),
          shadowedRange: { ...node.shadowedRange },
          lineage: lineageOf(index, node),
        })
      }
    }
    if (scope !== 'summaries') {
      for (const node of nodes) {
        for (const seq of node.sourceEventSeqs) {
          const source = messageText(index.session, seq)
          if (source === undefined || !matches(source.text)) continue
          hits.push({
            kind: 'source',
            eventSeq: seq,
            role: source.role,
            snippet: boundedSnippet(source.text),
            node: {
              id: node.id,
              kind: node.kind,
              depth: node.depth,
              shadowedRange: { ...node.shadowedRange },
            },
          })
        }
      }
    }
    return hits.sort((a, b) => b.eventSeq - a.eventSeq).slice(0, max)
  }

  /**
   * Locate one log event relative to the committed summary DAG.
   * @param sessionId - session whose log the event belongs to.
   * @param eventSeq - exact event seq to locate.
   * @returns live, pending, or shadowed with the covering node's descriptor.
   * @throws when the session is not live or the seq is outside its log.
   */
  locate(sessionId: SessionId, eventSeq: number): CompactionHistoryLocation {
    const index = this.requireIndex(sessionId)
    if (!Number.isSafeInteger(eventSeq) || eventSeq < 0 || eventSeq >= index.session.events.length) {
      throw new Error(`compaction history locate: event seq ${String(eventSeq)} is outside the session log`)
    }
    let covering: CompactionHistoryNode | undefined
    for (const node of index.byId.values()) {
      if (node.shadowedRange.start <= eventSeq && eventSeq <= node.shadowedRange.end) {
        /* v8 ignore next -- committed ranges cannot overlap through valid surface transactions */
        if (covering === undefined || node.shadowedRange.start > covering.shadowedRange.start) {
          covering = node
        }
      }
    }
    if (covering === undefined) {
      for (const pending of index.pendingByCompactionId.values()) {
        if (pending.shadowedRange.start <= eventSeq && eventSeq <= pending.shadowedRange.end) {
          return { status: 'pending' }
        }
      }
      return { status: 'live' }
    }
    const relation = covering.sourceEventSeqs.includes(eventSeq)
      ? 'source'
      : index.byCheckpointSeq.has(eventSeq) ? 'checkpoint' : 'other'
    return { status: 'shadowed', relation, node: this.describeNode(index, covering) }
  }

  /** Render one committed node as a structural descriptor with its ancestry. */
  private describeNode(index: SessionIndex, node: CompactionHistoryNode): CompactionHistoryNodeSummary {
    return {
      id: node.id,
      kind: node.kind,
      depth: node.depth,
      eventSeq: node.eventSeq,
      shadowedRange: { ...node.shadowedRange },
      shadowedTokenCount: node.shadowedTokenCount,
      summaryTokenCount: estimateTokens(node.text),
      parentCount: node.parentIds.length,
      sourceCount: node.sourceEventSeqs.length,
      lineage: lineageOf(index, node),
      provider: node.provider,
      model: node.model,
      createdAt: node.createdAt,
    }
  }

  /**
   * Expand one summary through its parent DAG and optional raw message sources.
   * @param sessionId - session that owns the summary identity.
   * @param summaryId - committed summary node to expand.
   * @param options - requested depth, token estimate, and source inclusion.
   * @returns bounded summary ancestry and source messages.
   * @throws when the session or summary is unavailable.
   */
  expand(
    sessionId: SessionId,
    summaryId: CompactionSummaryId,
    options: CompactionSummaryExpansionOptions = {},
  ): CompactionSummaryExpansion {
    const index = this.requireIndex(sessionId)
    const node = index.byId.get(summaryId)
    if (node === undefined) throw new Error(`compaction summary "${summaryId}" was not found in session "${sessionId}"`)
    const maxDepth = Math.min(this.config.maxExpansionDepth, Math.max(1, Math.floor(options.maxDepth ?? this.config.maxExpansionDepth)))
    const tokenCap = Math.min(this.config.maxExpansionTokens, Math.max(1, Math.floor(options.tokenCap ?? this.config.maxExpansionTokens)))
    return this.expandNode(index, node, maxDepth, tokenCap, options.includeSources === true)
  }

  /**
   * Return projection statistics for one live session.
   * @param sessionId - session whose committed nodes are counted.
   * @returns committed summary count and greatest DAG depth.
   * @throws when the session is not live in this projection.
   */
  stats(sessionId: SessionId): { summaries: number; maxDepth: number } {
    const index = this.requireIndex(sessionId)
    return {
      summaries: index.byId.size,
      maxDepth: [...index.byId.values()].reduce((max, node) => Math.max(max, node.depth), 0),
    }
  }

  private attach(session: Session): void {
    const index: SessionIndex = {
      session,
      byId: new Map(),
      byCheckpointSeq: new Map(),
      pendingByCompactionId: new Map(),
    }
    this.indexes.set(session.id, index)
    for (const event of session.events) this.indexEvent(index, event)
  }

  private indexEvent(index: SessionIndex, event: Session['events'][number]): void {
    if (event.type === 'compaction/summary') {
      this.indexSummary(index, event)
      return
    }
    if (event.type !== 'user/message' || !isCompactCheckpointSource(event.data.source)) return
    const source = event.data.source as CompactionCheckpointSource
    const node = index.pendingByCompactionId.get(source.compactionId)
    if (node !== undefined) {
      index.byId.set(node.id, node)
      index.byCheckpointSeq.set(event.seq, node)
      index.pendingByCompactionId.delete(source.compactionId)
    }
  }

  private indexSummary(index: SessionIndex, event: CompactionSummaryEvent): void {
    const { session } = index
    const id = CompactionSummaryId(`compaction-summary:${session.id}:${event.seq}`)
    const parents = [...new Set(event.data.shadowedSeqs
      .map(seq => index.byCheckpointSeq.get(seq))
      .filter((value): value is CompactionHistoryNode => value !== undefined))]
    const parentIds = parents.map(parent => parent.id)
    const parentDepth = parents.reduce((max, parent) => Math.max(max, parent.depth), -1)
    const node: CompactionHistoryNode = {
      id,
      sessionId: session.id,
      eventSeq: event.seq,
      kind: parentIds.length > 0 ? 'condensed' : 'leaf',
      depth: parentIds.length > 0 ? parentDepth + 1 : 0,
      content: event.data.summary,
      text: contentText(event.data.summary),
      parentIds,
      sourceEventSeqs: event.data.shadowedSeqs.filter(seq => !index.byCheckpointSeq.has(seq)),
      shadowedRange: { ...event.data.shadowedRange },
      shadowedTokenCount: event.data.shadowedTokenCount,
      provider: event.data.provider,
      model: event.data.model,
      createdAt: event.time,
    }
    index.pendingByCompactionId.set(event.data.compactionId, node)
  }

  private expandNode(
    index: SessionIndex,
    node: CompactionHistoryNode,
    depth: number,
    tokenCap: number,
    includeSources: boolean,
  ): CompactionSummaryExpansion {
    let remaining = tokenCap
    const boundedSummary = truncateHistoryText(node.text, remaining)
    let estimatedTokens = boundedSummary.tokens
    remaining -= boundedSummary.tokens
    let truncated = boundedSummary.truncated
    const parents: CompactionSummaryExpansion[] = []
    const sources: CompactionSummarySource[] = []

    if (node.parentIds.length > 0 && depth > 1) {
      for (const parentId of node.parentIds) {
        if (remaining <= 0) {
          truncated = true
          break
        }
        const parent = index.byId.get(parentId) as CompactionHistoryNode
        const expanded = this.expandNode(index, parent, depth - 1, remaining, includeSources)
        parents.push(expanded)
        estimatedTokens += expanded.estimatedTokens
        remaining -= expanded.estimatedTokens
        truncated = truncated || expanded.truncated
      }
    } else if (node.parentIds.length > 0) {
      truncated = true
    }

    if (includeSources) {
      for (const seq of node.sourceEventSeqs) {
        if (remaining <= 0) {
          truncated = true
          break
        }
        const source = messageText(index.session, seq)
        if (source === undefined) continue
        const boundedSource = truncateHistoryText(source.text, remaining)
        sources.push({ ...source, text: boundedSource.text })
        estimatedTokens += boundedSource.tokens
        remaining -= boundedSource.tokens
        if (!boundedSource.truncated) continue
        truncated = true
        break
      }
    }

    return {
      id: node.id,
      kind: node.kind,
      depth: node.depth,
      eventSeq: node.eventSeq,
      text: boundedSummary.text,
      parents,
      sources,
      tokenCap,
      estimatedTokens,
      truncated,
    }
  }

  private requireIndex(sessionId: SessionId): SessionIndex {
    const index = this.indexes.get(sessionId)
    if (index === undefined) throw new Error(`session "${sessionId}" is not live for compaction history`)
    return index
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    compactionHistory: CompactionHistory
  }
}

/** Lossless provider that keeps BasicCompaction's proven transaction policy. */
export class LosslessCompactionEngine extends BasicCompactionEngine {
  static override inject = ['llm', 'tokenMeter', 'sessions', 'compactionHistory']
}

/** Load the history projection and the alternate compaction provider together. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const {
    maxSearchResults,
    maxExpansionDepth,
    maxExpansionTokens,
    ...compactionConfig
  } = config
  await ctx.plugin(CompactionHistory, {
    ...maxSearchResults === undefined ? {} : { maxSearchResults },
    ...maxExpansionDepth === undefined ? {} : { maxExpansionDepth },
    ...maxExpansionTokens === undefined ? {} : { maxExpansionTokens },
  })
  await ctx.plugin(LosslessCompactionEngine, compactionConfig)
}

export const name = 'compaction-lossless'
export const inject = ['llm', 'tokenMeter', 'sessions']
