/**
 * Model-facing delivery envelope for settled peer delegations.
 *
 * The delivered message is the one place the settlement reaches the
 * initiating model: content names the target, the terminal status, and the
 * continuation handle, so an agent — including one whose earlier turns were
 * compacted away — can still reason about the outcome without the original
 * tool call.
 *
 * @module @deepseek-ai/dsh-peer-outbox
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { PeerOutboxEntry } from './types.ts'

/** Render one terminal status phrase for the watched turn. */
function describeStatus(endReason: string | undefined): string {
  if (endReason === undefined || endReason === 'completed') return 'completed'
  return `ended ${endReason}`
}

/**
 * Build one settled-delegation message: a bounded envelope around the
 * truncated reply.
 * @param entry - the ledger entry being delivered.
 * @param reply - the truncated settled reply, already bounded by the caller.
 * @returns the plugin-sourced user message carrying envelope and reply.
 */
export function outboxDeliveryMessage(entry: PeerOutboxEntry, reply: string): UserMessage {
  const text = [
    `Delegated task on ${entry.targetDisplayName} (${entry.targetInstanceId}) settled: ${describeStatus(entry.endReason)}.`,
    `Peer session ${entry.peerSessionId}; continue that conversation with the peer tool by passing session ${JSON.stringify(entry.peerSessionId)}.`,
    '',
    reply.length > 0 ? reply : '(the settled turn produced no reply text)',
  ].join('\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'peer',
      entryId: entry.id,
      peerSessionId: entry.peerSessionId,
      targetInstanceId: entry.targetInstanceId,
      ...(entry.endReason === undefined ? {} : { endReason: entry.endReason }),
    },
  })
}
