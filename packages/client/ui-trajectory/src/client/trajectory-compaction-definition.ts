import type { Context } from '@deepseek-ai/cordis'
import type {
  CompactionSummaryNode, ConversationMatch, ConversationNodeDefinition, RequestView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-compaction/types'
import { trajectoryNode } from './trajectory-definition-common.ts'

interface CompactionState {
  readonly start: ConversationMatch
  readonly summary?: ConversationMatch
  readonly end?: ConversationMatch
  readonly checkpoint?: ConversationMatch
}

function checkpointId(
  event: Parameters<ConversationNodeDefinition['match']>[0],
): string | undefined {
  if (event.type !== 'user/message') return undefined
  const source = event.data.source as unknown as {
    readonly kind?: unknown
    readonly plugin?: unknown
    readonly compactionId?: unknown
  }
  return source.kind === 'plugin' && source.plugin === 'compact'
    && typeof source.compactionId === 'string' && source.compactionId !== ''
    ? source.compactionId
    : undefined
}

function eventCompactionId(
  event: Parameters<ConversationNodeDefinition['match']>[0],
): string | undefined {
  if (event.type !== 'compaction/start'
    && event.type !== 'compaction/summary'
    && event.type !== 'compaction/end') return undefined
  const value: unknown = event.data.compactionId
  return typeof value === 'string' && value !== '' ? value : undefined
}

function requestFromState(
  state: CompactionState,
): Extract<RequestView, { purpose: 'compaction' }> | undefined {
  const start = state.start.event
  if (start.type !== 'compaction/start') return undefined
  const summary = state.summary?.event
  const end = state.end?.event
  const checkpoint = state.checkpoint?.event
  return {
    purpose: 'compaction',
    startSeq: start.seq,
    turn: start.data.turn,
    step: 0,
    startedAt: start.time,
    completedAt: end?.type === 'compaction/end' ? end.time : null,
    status: end?.type !== 'compaction/end'
      ? 'running'
      : end.data.error === undefined ? 'complete' : 'error',
    ...(end?.type === 'compaction/end' && end.data.error !== undefined
      ? { error: end.data.error }
      : {}),
    ...(summary?.type !== 'compaction/summary'
      ? {}
      : {
        resultSeq: summary.seq,
        summary: summary.data.summary,
        ...(summary.data.rawOutput === undefined ? {} : { rawOutput: summary.data.rawOutput }),
        provenance: { provider: summary.data.provider, model: summary.data.model },
        requestConfig: {
          provider: summary.data.provider,
          model: summary.data.model,
          purpose: 'compaction',
          ...(summary.data.maxTokens === undefined ? {} : { maxTokens: summary.data.maxTokens }),
        },
        ...(summary.data.usage === undefined ? {} : { usage: summary.data.usage }),
      }),
    ...(checkpoint?.type === 'user/message' ? { replacementSeq: checkpoint.seq } : {}),
  }
}

/**
 * Build the landed marker from the replacement checkpoint and the summary evidence.
 *
 * @param state - the compaction's assembled matches.
 * @returns the marker at the checkpoint's own log position, or undefined before the checkpoint landed.
 */
function compactionMarker(state: CompactionState): CompactionSummaryNode | undefined {
  const checkpoint = state.checkpoint?.event
  if (checkpoint?.type !== 'user/message') return undefined
  const summary = state.summary?.event
  let summaryText: string | null = null
  let shadowedItemCount: number | null = null
  let shadowedTokenCount: number | null = null
  if (summary?.type === 'compaction/summary') {
    const data = summary.data
    if (Array.isArray(data.summary)) {
      const text = data.summary
        .map(block => block.type === 'text' ? block.text : '')
        .join('')
      summaryText = text.trim() === '' ? null : text
    }
    shadowedItemCount = Array.isArray(data.shadowedSeqs)
      && data.shadowedSeqs.every(seq => Number.isSafeInteger(seq) && seq >= 0)
      ? data.shadowedSeqs.length
      : null
    shadowedTokenCount = Number.isSafeInteger(data.shadowedTokenCount)
      && data.shadowedTokenCount >= 0
      ? data.shadowedTokenCount
      : null
  }
  return {
    kind: 'compaction',
    seq: checkpoint.seq,
    time: checkpoint.time,
    summary: summaryText,
    summaryEventSeq: summary?.seq ?? null,
    shadowedItemCount,
    shadowedTokenCount,
  }
}

const trajectoryCompactionDefinition: ConversationNodeDefinition<CompactionState> = {
  kind: 'trajectory-compaction',
  target: 'trajectory',
  match: (event) => {
    const compactId = eventCompactionId(event)
    if (compactId !== undefined) {
      return { id: compactId, role: event.type === 'compaction/start' ? 'start' : 'update' }
    }
    const checkpoint = checkpointId(event)
    return checkpoint === undefined ? null : { id: checkpoint, role: 'update' }
  },
  start: (_context, match) => {
    if (match.event.type !== 'compaction/start') {
      throw new Error('trajectory-compaction start requires compaction/start')
    }
    return { start: match }
  },
  update: (context, match) => {
    if (match.event.type === 'compaction/summary') return { ...context.state, summary: match }
    if (match.event.type === 'compaction/end') return { ...context.state, end: match }
    return checkpointId(match.event) === undefined
      ? context.state
      : { ...context.state, checkpoint: match }
  },
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    const request = requestFromState(context.state)
    if (request === undefined) return null
    const marker = compactionMarker(context.state)
    return trajectoryNode(context, request.startSeq, {
      kind: 'compaction',
      request,
      ...(marker === undefined ? {} : { marker }),
    })
  },
}

interface SessionEndState {
  readonly seq: number
  readonly time: number
}

const trajectorySessionEndDefinition: ConversationNodeDefinition<SessionEndState> = {
  kind: 'trajectory-session-end',
  target: 'trajectory',
  match: event => event.type === 'session/end-seed'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match) => ({ seq: match.event.seq, time: match.event.time }),
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : trajectoryNode(context, context.state.seq, {
      kind: 'session-end',
      seq: context.state.seq,
      time: context.state.time,
    }),
}

/**
 * Register Trajectory compaction requests and session boundaries.
 *
 * @param ctx - Plugin context receiving the Definitions.
 */
export function registerTrajectoryCompactionDefinitions(ctx: Context): void {
  ctx.conversationEvents.register(trajectoryCompactionDefinition)
  ctx.conversationEvents.register(trajectorySessionEndDefinition)
}
