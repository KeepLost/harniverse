import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Request for one chronological display-history page. */
export interface SessionHistoryPageRequest {
  /** Exclusive raw-event upper bound; omitted for the latest page. */
  readonly beforeSeq?: number
  /** Maximum number of append-origin user/assistant messages. */
  readonly maxMessages: number
}

/** One raw-event page from a session's append-origin display history. */
export interface SessionHistoryPage {
  /** Events remain contiguous in raw-log order. */
  readonly events: SessionEvent[]
  /** Whether an earlier raw-event interval exists. */
  readonly hasMore: boolean
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
  let count = 0
  let cut = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (beforeSeq !== undefined && event.seq >= beforeSeq) continue
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    if (!isAppendSurfaceEvent(event)) continue
    count += 1
    const sources = (event as { sourceEventSeqs?: number[] }).sourceEventSeqs
    const groupStart = sources !== undefined && sources.length > 0
      ? Math.min(event.seq, ...sources)
      : event.seq
    if (count >= maxMessages) {
      cut = groupStart
      break
    }
  }
  return {
    events: events.filter(event => event.seq >= cut && (beforeSeq === undefined || event.seq < beforeSeq)),
    hasMore: cut > 0,
  }
}
