/** Queue contracts derived from the runtime session face and snapshot. */
import type {
  ConversationSnapshot, ObservableSnapshot, SessionFace,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { QueuedMessage } from './input.ts'

/** One address accepted by the runtime session's queue mutation verb. */
export type QueueItemId = Parameters<SessionFace['updateQueue']>[0]

/** One mutation accepted by the runtime session's queue mutation verb. */
export type QueueAction = Parameters<SessionFace['updateQueue']>[1]

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
