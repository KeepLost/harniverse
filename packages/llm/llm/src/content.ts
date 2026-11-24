/** Content-block structure helpers. @module @deepseek-ai/dsh-llm/content */

import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from './types.ts'

/** A stored image's program-readable path resolved for one execution world. */
export interface ImageAttachmentAccess {
  /** Absolute read-only path in the caller's execution world. */
  readonlyPath: string
}

/**
 * Resolve the program-readable path of one stored image, when both the
 * attachment store and a host-path mapping exist.
 * @param attachments - Store that owns the image bytes.
 * @param mapHostPath - Maps a host path into the execution world.
 * @param ref - Durable reference to the stored image.
 * @returns the readable path, or `undefined` when no mapping resolves it.
 */
export function resolveImageAttachmentAccess(
  attachments: AttachmentStore,
  mapHostPath: (hostPath: string) => string | undefined,
  ref: ImageAttachmentRef,
): ImageAttachmentAccess | undefined {
  const hostPath = attachments.imageHostPath(ref)
  if (hostPath === undefined) return undefined
  const readonlyPath = mapHostPath(hostPath)
  return readonlyPath === undefined ? undefined : { readonlyPath }
}

/**
 * True when typed model content contains an image block, walking nested
 * tool-result content. This is the one recursive image walk shared by every
 * image policy (capability gating, text-only serialization, compaction
 * survey), so a consumer cannot silently diverge on nesting depth.
 * @param content - typed model content blocks.
 * @returns whether any nested block is an image.
 */
export function contentHasImage(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type === 'image'
    || (block.type === 'tool-result' && contentHasImage(block.content)))
}
