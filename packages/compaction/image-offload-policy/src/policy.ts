/**
 * Pure decision rules for age-based image offload: parse the global setting,
 * age every image occurrence by later user-message turns, and choose the
 * occurrences to unload at one request-assembly point.
 *
 * @module @deepseek-ai/dsh-image-offload-policy
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ImageOffloadDecision, ImageOffloadSetting, ImageOffloadTarget } from './types.ts'

/**
 * The canonical model-visible stub rendered in place of an offloaded image.
 * Truthful by contract: it states the image is absent from the current
 * request and must not be treated as visible.
 */
export const OFFLOADED_IMAGE_STUB_TEXT =
  '[image offloaded: the original attachment is retained outside this request; do not treat the image as visible]'

/**
 * Parse the stored `imageOffloadAfterUserTurns` value. `'unlimited'` and
 * positive safe integers pass through; `0`, negatives, non-integers, and any
 * other shape are refused so the settings schema never carries an ambiguous
 * age limit (`0` must not be overloaded to mean unlimited).
 * @param input - the raw stored value.
 * @returns the validated setting.
 * @throws `TypeError` when the value is not `'unlimited'` or a positive safe integer.
 */
export function parseImageOffloadSetting(input: unknown): ImageOffloadSetting {
  if (input === 'unlimited') return input
  if (typeof input === 'number' && Number.isSafeInteger(input) && input > 0) return input
  throw new TypeError(`imageOffloadAfterUserTurns must be 'unlimited' or a positive integer, got ${JSON.stringify(input)}`)
}

/** Count the image blocks carried by one surface event, 0 for events that carry none. */
function imageCount(event: SessionEvent): number {
  if (event.type === 'user/message') return countImages(event.data.content)
  if (event.type === 'tool/result') return countImages(event.data.message.content[0].content)
  return 0
}

function countImages(blocks: readonly ContentBlock[]): number {
  let count = 0
  for (const block of blocks) {
    if (block.type === 'image') count += 1
  }
  return count
}

/** One tracked image occurrence during the log walk. */
interface Occurrence {
  readonly target: ImageOffloadTarget
  /** Later user-message turns appended after the carrying event. */
  age: number
  /** False once a prior offload or a compaction replacement settled this occurrence. */
  active: boolean
}

/** Options for one offload decision point. */
export interface ImageOffloadOptions {
  /** The parsed global setting; `parseImageOffloadSetting` validates stored values. */
  readonly setting: ImageOffloadSetting
  /**
   * Number of images the provider says must unload now (its pressure
   * demand). Defaults to 0 — no pressure-driven offload.
   */
  readonly pressureCount?: number
}

/**
 * Choose the image occurrences to offload at one request-assembly point,
 * given the durable log so far.
 *
 * Aging counts later `user/message` events (direct prompts, injected context,
 * and continuation rounds alike); assistant messages, tool traffic, and
 * context snapshots never increment it. A finite setting unloads each active
 * occurrence whose age has reached the limit — immediately, not at the next
 * compaction boundary — and `pressureCount` additionally takes the oldest
 * still-active occurrences. An occurrence already named by a prior
 * `image/offload`, or whose carrying event was shadowed by a compaction
 * replacement (an event whose `sourceEventSeqs` cites it), is finished and is
 * never chosen again. Compaction replaces without `sourceEventSeqs` cite
 * nothing and settle no occurrences.
 * @param events - the durable session log, in seq order.
 * @param options - the setting and optional pressure demand for this decision.
 * @returns the decisions to append as one `image/offload` event, oldest
 * (smallest message seq, then image index) first; empty when nothing unloads.
 */
export function resolveImageOffloadDecisions(
  events: readonly SessionEvent[],
  options: ImageOffloadOptions,
): ImageOffloadDecision[] {
  const occurrences: Occurrence[] = []
  const pressureCount = options.pressureCount ?? 0
  for (const event of events) {
    if (event.type === 'user/message') {
      for (const occurrence of occurrences) {
        occurrence.age += 1
      }
    }
    if (event.type === 'image/offload') {
      for (const target of event.data.targets) {
        const settled = occurrences.find(candidate =>
          candidate.target.messageSeq === target.messageSeq && candidate.target.imageIndex === target.imageIndex)
        if (settled !== undefined) settled.active = false
      }
      continue
    }
    const shadowed = event.type === 'user/message' || event.type === 'tool/result' || event.type === 'assistant/message'
      ? event.sourceEventSeqs
      : undefined
    if (shadowed !== undefined) {
      for (const occurrence of occurrences) {
        if (shadowed.includes(occurrence.target.messageSeq)) occurrence.active = false
      }
    }
    const images = imageCount(event)
    for (let imageIndex = 0; imageIndex < images; imageIndex += 1) {
      occurrences.push({ target: { messageSeq: event.seq, imageIndex }, age: 0, active: true })
    }
  }
  const active = occurrences.filter(occurrence => occurrence.active)
  const decisions: ImageOffloadDecision[] = []
  const limit = options.setting === 'unlimited' ? Number.POSITIVE_INFINITY : options.setting
  for (const occurrence of active) {
    if (occurrence.age >= limit) decisions.push({ target: occurrence.target, reason: 'age' })
  }
  if (pressureCount > 0) {
    const remaining = active
      .filter(occurrence => !decisions.some(decision => decision.target === occurrence.target))
      .sort((a, b) => a.target.messageSeq - b.target.messageSeq || a.target.imageIndex - b.target.imageIndex)
    for (const occurrence of remaining.slice(0, pressureCount)) {
      decisions.push({ target: occurrence.target, reason: 'pressure' })
    }
  }
  return decisions.sort((a, b) => a.target.messageSeq - b.target.messageSeq || a.target.imageIndex - b.target.imageIndex)
}
