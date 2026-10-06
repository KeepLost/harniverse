/** Queue contracts derived from the runtime session face and snapshot. */
import type {
  ConversationSnapshot, ObservableSnapshot, SessionFace,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionWorkStatus } from '@deepseek-ai/dsh-client-connection/client'
import type { QueuedMessage } from './input.ts'

/** One address accepted by the runtime session's queue mutation verb. */
export type QueueItemId = Parameters<SessionFace['updateQueue']>[0]

/** One mutation accepted by the runtime session's queue mutation verb. */
export type QueueAction = Parameters<SessionFace['updateQueue']>[1]

/** Locale key reporting one recall refusal, selected by the durable lifecycle. */
export type QueueRecallFailureKey =
  | 'queue.recallFailure.read'
  | 'queue.recallFailure.discarded'
  | 'queue.recallFailure.unknown'

/**
 * Select the recall-failure copy for a `queue-item-not-found` lifecycle: a
 * claimed or settled batch was already read by the model, a discarded
 * occurrence was already recalled, and anything unresolved keeps the generic
 * may-have-started-sending wording.
 * @param status - the durable lifecycle the Host reported, when it resolved one.
 * @returns the locale key for the failure notice.
 */
export function queueRecallFailureKey(status: SessionWorkStatus | undefined): QueueRecallFailureKey {
  if (status === undefined) return 'queue.recallFailure.unknown'
  if (status.state === 'claimed' || status.state === 'settled') return 'queue.recallFailure.read'
  if (status.state === 'discarded') return 'queue.recallFailure.discarded'
  return 'queue.recallFailure.unknown'
}

/** One row projected by the runtime session's authoritative queue snapshot. */
export type QueueRow = ConversationSnapshot['queue'][number]

/**
 * Project a session's transient inbox rows as a bare observable (subscribe/getSnapshot).
 * The wiring layer overlays this onto InputState.queue; the runtime
 * QueuedMessage and the input-contract QueuedMessage are structurally
 * identical.
 * @param session - the resident session face.
 * @returns the queue read face (snapshot reference stable while the queue is unchanged).
 */
export function queueReadFaceOf(session: SessionFace): ObservableSnapshot<readonly QueuedMessage[]> {
  return {
    getSnapshot: () => session.getSnapshot().queue,
    subscribe: fn => session.subscribe(fn),
  }
}
