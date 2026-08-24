import { isAppendSurfaceEvent, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Request for one chronological display-history page. */
export interface SessionHistoryPageRequest {
  /** Exclusive raw-event upper bound; omitted for the latest page. */
  readonly beforeSeq?: number
  /** Maximum number of append-origin user/assistant messages. */
  readonly maxMessages: number
  /** Stop an initial page at the latest replacement checkpoint transaction. */
  readonly preferLatestCheckpoint?: boolean
}

/**
 * Extra append-origin messages a preferred initial page may scan past its quota
 * while looking for a compaction checkpoint.
 *
 * A checkpoint sits directly above the turns that follow it, so it is found
 * within a few messages of the tail whenever it is relevant to the first
 * screen. An unbounded search instead reverse-decoded the entire artifact of
 * every compaction-free session (measured 16s+ on a 203k-event log, surfacing
 * as an aborted `session.history` request), so the search is bounded in the
 * same unit the page quota uses.
 */
export const CHECKPOINT_SEARCH_MESSAGE_BUDGET = 8

/** One raw-event page from a session's append-origin display history. */
export interface SessionHistoryPage {
  /** Events remain contiguous in raw-log order. */
  readonly events: SessionEvent[]
  /** Whether an earlier raw-event interval exists. */
  readonly hasMore: boolean
}

/**
 * Locate the contiguous transaction prefix required to present one replacement
 * checkpoint without loading the older surface range it superseded.
 * @param event - candidate durable event.
 * @returns first cited seq, which compact checkpoints reserve for transaction start.
 */
export function replacementCheckpointStart(event: SessionEvent): number | undefined {
  if (event.type !== 'user/message' || !isReplacementSurfaceEvent(event)) return undefined
  const source = event.data.source
  if (source.kind !== 'plugin' || source.plugin !== 'compact') return undefined
  const start = event.sourceEventSeqs?.[0]
  return start !== undefined && start < event.seq ? start : undefined
}

/**
 * Paginate a materialized event window at append-origin message boundaries.
 * Replacement copies never consume the display-page quota, and their source
 * range stays attached to the message that caused the cut.
 * @param events - ordered raw events to page.
 * @param request - exclusive upper bound and message quota.
 * @returns one contiguous raw-event page and its continuation state.
 */
export function paginateSessionHistory(
  events: readonly SessionEvent[],
  request: SessionHistoryPageRequest,
): SessionHistoryPage {
  const { beforeSeq, maxMessages } = request
  const preferCheckpoint = beforeSeq === undefined && request.preferLatestCheckpoint === true
  const searchLimit = maxMessages + CHECKPOINT_SEARCH_MESSAGE_BUDGET
  let count = 0
  let cut = 0
  let quotaCut: number | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (beforeSeq !== undefined && event.seq >= beforeSeq) continue
    // A checkpoint cuts the page: everything below it is superseded surface the
    // model no longer sees. The search may pass the page quota by
    // CHECKPOINT_SEARCH_MESSAGE_BUDGET messages, never to the head of the log.
    if (preferCheckpoint && count < searchLimit) {
      const checkpointStart = replacementCheckpointStart(event)
      if (checkpointStart !== undefined) return {
        events: events.filter(candidate => candidate.seq >= checkpointStart),
        hasMore: checkpointStart > 0,
      }
    }
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      if (isAppendSurfaceEvent(event)) {
        count += 1
        const sources = (event as { sourceEventSeqs?: number[] }).sourceEventSeqs
        let groupStart = event.seq
        if (sources !== undefined) {
          for (const source of sources) {
            if (source < groupStart) groupStart = source
          }
        }
        if (count >= maxMessages && quotaCut === undefined) quotaCut = groupStart
      }
    }
    if (quotaCut !== undefined && (!preferCheckpoint || count >= searchLimit)) {
      cut = quotaCut
      break
    }
  }
  // No checkpoint applied: fall back to the ordinary quota cut, which stays
  // undefined only when the log holds fewer than maxMessages messages.
  if (cut === 0 && quotaCut !== undefined) cut = quotaCut
  return {
    events: events.filter(event => event.seq >= cut && (beforeSeq === undefined || event.seq < beforeSeq)),
    hasMore: cut > 0,
  }
}
