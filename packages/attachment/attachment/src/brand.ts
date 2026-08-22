/** Attachment identifier brand. @module @deepseek-ai/dsh-attachment/brand */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque content-addressed identifier for one immutable attachment object. */
export type AttachmentId = Branded<'AttachmentId'>

/** Opaque identity for one deterministic model-request image variant. */
export type ImageVariantId = Branded<'ImageVariantId'>

/**
 * Brand a validated storage identifier.
 * @param value - backend-produced opaque identifier.
 * @returns the branded identifier.
 */
export function AttachmentId(value: string): AttachmentId {
  return value as AttachmentId
}

/** Brand a validated request-image variant identifier.
 * @param value - backend-produced opaque variant identifier.
 * @returns the branded variant identifier.
 */
export function ImageVariantId(value: string): ImageVariantId {
  return value as ImageVariantId
}
