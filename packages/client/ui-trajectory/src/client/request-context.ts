/** Model-visible context composition for one request, derived from the
 * assembled conversation nodes. Each segment links back to the trajectory row
 * that produced it via its source seq. */

import type { ConversationNode } from '@deepseek-ai/dsh-client-runtime/client'

/** One model-visible context entry: a live surface item or a compaction summary. */
export interface RequestContextSegment {
  /** 'message' = one live surface item; 'summary' = a compaction replacement. */
  kind: 'message' | 'summary'
  /** Source seq for trajectory navigation: the item's seq or the marker's seq. */
  seq: number
  /** Surface role label: user / assistant / tool / context / compaction. */
  role: string
  /** Items replaced by this summary; summary segments only. */
  shadowedItemCount?: number
  /** Estimated token price of the replaced items; summary segments only. */
  shadowedTokenCount?: number
}

/** Node kinds that carry model-visible surface content. */
function surfaceRole(node: ConversationNode): string | null {
  switch (node.kind) {
    case 'user': return 'user'
    case 'assistant': return 'assistant'
    case 'tool-result': return 'tool'
    case 'steering': return 'user'
    case 'context': return 'context'
    default: return null
  }
}

/**
 * Derive the model-visible context composition for the request anchored at
 * `startSeq`: surface nodes before it, with each landed compaction absorbing
 * the live items it replaced into one summary segment. `undefined` startSeq
 * (the currently streaming request) takes every node.
 * @param nodes - Assembled conversation nodes in log order.
 * @param startSeq - Anchor event seq of the request, or undefined for streaming.
 * @returns Segments in model-visible order.
 */
export function deriveRequestContext(
  nodes: readonly ConversationNode[],
  startSeq: number | undefined,
): RequestContextSegment[] {
  const segments: RequestContextSegment[] = []
  /** Output length after the last landed summary; its live items get absorbed. */
  let liveBase = 0
  for (const node of nodes) {
    if (startSeq !== undefined && node.seq >= startSeq) continue
    if (node.kind === 'compaction') {
      segments.length = liveBase
      segments.push({
        kind: 'summary',
        seq: node.seq,
        role: 'compaction',
        ...(node.shadowedItemCount === null ? {} : { shadowedItemCount: node.shadowedItemCount }),
        ...(node.shadowedTokenCount === null ? {} : { shadowedTokenCount: node.shadowedTokenCount }),
      })
      liveBase = segments.length
      continue
    }
    const role = surfaceRole(node)
    if (role === null) continue
    segments.push({ kind: 'message', seq: node.seq, role })
  }
  return segments
}
