/**
 * Position-stable application of durable image-offload decisions to derived
 * messages.
 *
 * Image indexes are counted over the ORIGINAL event content (the durable
 * base), never over an already-stubbed message: stubs replace image blocks
 * one-for-one, so content positions never shift and consecutive decisions
 * compose without recounting.
 *
 * @module @deepseek-ai/dsh-compaction-image-offload/project-message
 */

import { deepFreeze } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { OFFLOADED_IMAGE_STUB_TEXT } from '@deepseek-ai/dsh-image-offload-policy'

/**
 * The block list whose image blocks the offload index counts, mirroring the
 * policy's per-kind counting: top-level content for `user/message`, the
 * content of the single tool-result block for `tool/result`.
 * @param event - the surface event carrying the images.
 * @returns the image-carrying block list, or undefined when the event kind
 * carries none (or a malformed tool/result carries no result block).
 */
export function imageCarrier(event: SessionEvent): readonly ContentBlock[] | undefined {
  if (event.type === 'user/message') return event.data.content
  if (event.type === 'tool/result') return event.data.message.content.at(0)?.content
  return undefined
}

/**
 * Resolve the content positions of the requested original image indexes.
 * @param carrier - the base (durable event) block list to count over.
 * @param indexes - strictly increasing original image indexes to locate.
 * @returns ascending carrier positions of those images.
 * @throws when a requested image index does not exist in the base carrier.
 */
function imagePositions(carrier: readonly ContentBlock[], indexes: readonly number[]): number[] {
  const positions: number[] = []
  let imageIndex = 0
  let selected = 0
  for (const [position, block] of carrier.entries()) {
    if (block.type !== 'image') continue
    if (selected < indexes.length && imageIndex === indexes[selected]) {
      positions.push(position)
      selected += 1
    }
    imageIndex += 1
  }
  if (selected !== indexes.length) {
    throw new Error(`image/offload: image index ${String(indexes[selected])} does not exist`)
  }
  return positions
}

/**
 * Replace the blocks at the given positions with the offload stub.
 * @param blocks - the current (possibly already-stubbed) block list.
 * @param positions - ascending positions to replace.
 * @returns the new block list, or the input when nothing changed.
 * @throws when a targeted position does not currently hold an image.
 */
function stubAtPositions(blocks: readonly ContentBlock[], positions: readonly number[]): ContentBlock[] {
  let next: ContentBlock[] | undefined
  let selected = 0
  for (const [position, block] of blocks.entries()) {
    let projected = block
    if (selected < positions.length && position === positions[selected]) {
      if (block.type !== 'image') throw new Error('image/offload: target image was already offloaded')
      projected = { type: 'text', text: OFFLOADED_IMAGE_STUB_TEXT }
      selected += 1
    }
    if (projected !== block) next ??= blocks.slice(0, position)
    next?.push(projected)
  }
  return next ?? blocks as ContentBlock[]
}

/**
 * Apply one decision's image stubs to the current derived message of the
 * event that carries the images.
 * @param event - the image-carrying surface event (the counting base).
 * @param message - the message as currently projected.
 * @param indexes - strictly increasing original image indexes to stub.
 * @returns a new frozen message with the targeted images stubbed.
 */
export function stubEventImages(event: SessionEvent, message: Message, indexes: readonly number[]): Message {
  const carrier = imageCarrier(event)
  if (carrier === undefined) throw new Error(`image/offload: event at seq ${event.seq} carries no image blocks`)
  const positions = imagePositions(carrier, indexes)
  if (event.type === 'user/message') {
    const content = stubAtPositions(message.content, positions)
    return content === message.content ? message : deepFreeze({ ...message, content })
  }
  const [first, ...rest] = message.content
  if (first?.type !== 'tool-result') {
    throw new Error(`image/offload: event at seq ${event.seq} has no tool-result block to stub`)
  }
  const nested = stubAtPositions(first.content, positions)
  if (nested === first.content) return message
  return deepFreeze({ ...message, content: [{ ...first, content: nested }, ...rest] })
}
