/**
 * Aggregate request-image budget selection and omission projection shared by
 * adapters that inline prepared request images: oldest occurrences drop first
 * until the retained set fits the configured byte and count budgets, and the
 * surviving wire coordinates feed the caller's durable settlement hook.
 * @module
 */

import type { AttachmentId, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, GenerateOptions } from './types.ts'
import { freezeMessage } from './message.ts'

/** Position of one image occurrence in the request's message sequence. */
export interface ImageWireLocation {
  message: number
  image: number
}

/** One retained image occurrence: attachment reference, prepared request version, and wire position. */
export interface RequestImageOccurrence {
  readonly ref: ImageAttachmentRef
  readonly version: RequestImageAttachment
  readonly location: ImageWireLocation
}

/** Aggregate request-image budgets with the oldest-first removal quanta. */
export interface RequestImageBudgetLimits {
  /** Maximum combined encoded bytes of the retained request versions. */
  readonly maxBytes: number
  /** Maximum retained image occurrences per request. */
  readonly maxCount: number
  /** Byte headroom removed with each overflow, so a saturated route rewrites its prefix once per quantum. */
  readonly byteQuantum: number
  /** Occurrences removed with each count overflow, so the prefix does not shrink once per new image. */
  readonly countQuantum: number
}

/** Retained request-image selection for one serialization attempt. */
export interface LimitedRequestImages {
  /** Prepared version per retained attachment id. */
  readonly requestImages: ReadonlyMap<AttachmentId, RequestImageAttachment>
  /** Oldest occurrences dropped to fit the budgets, in wire order. */
  readonly omittedOccurrences: readonly ImageWireLocation[]
}

/**
 * Select the request images one serialization attempt may carry. Occurrences
 * drop oldest-first — smallest message position, then smallest image ordinal —
 * until the retained set fits both budgets; an exceeded budget that can absorb
 * one quantum targets the budget minus the quantum, so a route near its limit
 * does not rewrite its request prefix on every new image. Repeated references
 * to one attachment share the single prepared version.
 * @param pairs - every occurrence in wire order with its prepared version.
 * @param limits - aggregate byte and count budgets with removal quanta.
 * @returns the retained versions and the dropped occurrences.
 */
export function limitRequestImages(
  pairs: readonly RequestImageOccurrence[],
  limits: RequestImageBudgetLimits,
): LimitedRequestImages {
  const targetCount = pairs.length > limits.maxCount && limits.maxCount > limits.countQuantum
    ? limits.maxCount - limits.countQuantum
    : limits.maxCount
  let start = Math.max(0, pairs.length - targetCount)
  let total = pairs.slice(start).reduce((sum, pair) => sum + pair.version.bytes, 0)
  const targetBytes = total > limits.maxBytes && limits.maxBytes > limits.byteQuantum
    ? limits.maxBytes - limits.byteQuantum
    : limits.maxBytes
  while (start < pairs.length && total > targetBytes) {
    const pair = pairs[start] as RequestImageOccurrence
    total -= pair.version.bytes
    start += 1
  }
  return {
    requestImages: new Map(pairs.slice(start).map(pair => [pair.version.attachment.attachmentId, pair.version])),
    omittedOccurrences: pairs.slice(0, start).map(pair => pair.location),
  }
}

/**
 * Commit the dropped occurrences before serialization: the request owner's
 * `onImagesOmitted` hook projects them durably when mounted; without one the
 * dropped occurrences become local omission stubs naming their attachments.
 * @param options - the current request projection.
 * @param targets - dropped occurrences in wire coordinates.
 * @returns the request with the omissions applied.
 */
export function projectImageOmissions(options: GenerateOptions, targets: readonly ImageWireLocation[]): GenerateOptions {
  if (targets.length === 0) return options
  if (options.onImagesOmitted !== undefined) return { ...options, messages: options.onImagesOmitted(targets) }
  const omitted = new Set(targets.map(target => `${target.message}:${target.image}`))
  const messages = options.messages.map((entry, message) => {
    let image = 0
    const visit = (blocks: readonly ContentBlock[]): ContentBlock[] => blocks.map((block) => {
      if (block.type === 'tool-result') return { ...block, content: visit(block.content) }
      if (block.type === 'image' && omitted.has(`${message}:${image++}`)) {
        return { type: 'text', text: `[image omitted: ${block.attachment.attachmentId}]` }
      }
      return block
    })
    return freezeMessage({ ...entry, content: visit(entry.content) })
  })
  return { ...options, messages }
}
