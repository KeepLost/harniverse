/** Call-local argument prefix read through the session's standard snapshot hook. */
import type { UseConversationSession } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Read one preparing call's raw argument prefix from the session's live
 * partial assistant blocks; the empty string for every other call.
 * @param useSession - the session-scope standard seat from the view's props.
 * @param callId - the preparing call's identity.
 * @returns the accumulated raw prefix.
 */
export function useToolCallArgumentsPartial(useSession: UseConversationSession, callId: string): string {
  return useSession((snapshot) => {
    const block = snapshot.partial?.blocks.find(
      candidate => candidate.kind === 'tool-call' && candidate.callId === callId,
    )
    return block?.kind === 'tool-call' ? block.argsRaw : ''
  })
}
