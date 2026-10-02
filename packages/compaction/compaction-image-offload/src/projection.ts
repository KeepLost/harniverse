/**
 * The `image/offload` message projection: validate one durable offload
 * decision and compute the stubbed messages it produces.
 *
 * @module @deepseek-ai/dsh-compaction-image-offload/projection
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionMessageProjection, SessionMessageProjectionContext } from '@deepseek-ai/dsh-session'
import { imageCarrier, stubEventImages } from './project-message.ts'

/** Whether a runtime value is a non-negative safe event sequence or image index. */
function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Validate the durable payload shape of one `image/offload` event.
 * @param data - the raw event payload.
 * @returns the validated targets, each an image index paired with the
 * verbatim stub text that replaces it when the decision minted one.
 * @throws when the payload is not exactly a non-empty targets array of
 * `{messageSeq, imageIndex, stub?}` entries.
 */
function validateTargets(data: unknown): { messageSeq: number; imageIndex: number; stub?: string }[] {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('image/offload: data must be an object')
  }
  const { targets } = data as Record<string, unknown>
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('image/offload: data must contain a nonempty targets array')
  }
  const seen = new Set<string>()
  const parsed: { messageSeq: number; imageIndex: number; stub?: string }[] = []
  for (const target of targets) {
    if (typeof target !== 'object' || target === null || Array.isArray(target)) {
      throw new Error('image/offload: each target must be an object')
    }
    const { messageSeq, imageIndex, stub } = target as Record<string, unknown>
    if (!isIndex(messageSeq) || !isIndex(imageIndex)) {
      throw new Error('image/offload: each target must carry a messageSeq and imageIndex')
    }
    if (stub !== undefined && (typeof stub !== 'string' || stub.length === 0)) {
      throw new Error('image/offload: a target stub must be a nonempty string when present')
    }
    const key = `${messageSeq}:${imageIndex}`
    if (seen.has(key)) throw new Error(`image/offload: duplicate target ${key}`)
    seen.add(key)
    parsed.push(stub === undefined ? { messageSeq, imageIndex } : { messageSeq, imageIndex, stub })
  }
  return parsed
}

/** Group one decision's targets by their carrying event seq, keeping image indexes ascending. */
type TargetEntry = { messageSeq: number; imageIndex: number; stub?: string }
type IndexedEntry = { imageIndex: number; stub?: string }

function groupByMessage(targets: readonly TargetEntry[]): Map<number, IndexedEntry[]> {
  const grouped = new Map<number, { imageIndex: number; stub?: string }[]>()
  for (const { messageSeq, imageIndex, stub } of targets) {
    const indexes = grouped.get(messageSeq)
    const entry: { imageIndex: number; stub?: string } = stub === undefined
      ? { imageIndex }
      : { imageIndex, stub }
    if (indexes === undefined) grouped.set(messageSeq, [entry])
    else indexes.push(entry)
  }
  for (const indexes of grouped.values()) indexes.sort((a, b) => a.imageIndex - b.imageIndex)
  return grouped
}

/**
 * The pure `image/offload` interpreter. Validation is strict — the payload
 * shape, earlier-seq references, image-bearing event kinds, and image-index
 * bounds are all durable facts — while application is shadow-tolerant: a
 * target whose carrying event a later replacement removed from the surface
 * produces no entry, because there is no current message to stub.
 */
export const imageOffloadProjection: SessionMessageProjection<'image/offload'> = {
  type: 'image/offload',
  project(event: SessionEvent<'image/offload'>, context: SessionMessageProjectionContext): ReadonlyMap<number, Message> {
    const data: unknown = event.data
    const targets = validateTargets(data)
    const grouped = groupByMessage(targets)
    const updates = new Map<number, Message>()
    for (const [messageSeq, entries] of grouped) {
      if (messageSeq >= event.seq) {
        throw new Error(`image/offload: target seq ${messageSeq} must reference an earlier event`)
      }
      const source = context.eventAt(messageSeq)
      if (source === undefined) continue
      if (source.type !== 'user/message' && source.type !== 'tool/result') {
        throw new Error(`image/offload: target seq ${messageSeq} must be user/message or tool/result`)
      }
      const carrier = imageCarrier(source)
      const images = carrier?.filter(block => block.type === 'image').length ?? 0
      const indexes: number[] = []
      const texts = new Map<number, string>()
      for (const entry of entries) {
        if (entry.imageIndex >= images) {
          throw new Error(`image/offload: image index ${entry.imageIndex} does not exist on event ${messageSeq}`)
        }
        indexes.push(entry.imageIndex)
        if (entry.stub !== undefined) texts.set(entry.imageIndex, entry.stub)
      }
      const current = context.messages.get(messageSeq)
      if (current === undefined) continue
      updates.set(messageSeq, stubEventImages(source, current, indexes, texts))
    }
    return updates
  },
}
