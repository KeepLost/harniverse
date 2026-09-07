/** Durable attachment storage seam (`ctx.attachments`). @module @deepseek-ai/dsh-attachment */

import { Context, Service } from '@deepseek-ai/cordis'
import { AttachmentError } from './error.ts'
import type {
  FileAttachmentLimits,
  FileAttachmentRef,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageRequestPolicy,
  RequestImageAttachment,
  SaveFileAttachment,
  SaveImageAttachment,
  StoredFileAttachment,
  StoredImageAttachment,
} from './types.ts'

export { AttachmentId, ImageVariantId } from './brand.ts'
export { AttachmentError } from './error.ts'
export { admitEncodedImages } from './admission.ts'
export { fileHandleText } from './file-handle.ts'
export type {
  AttachmentId as AttachmentIdType,
  EncodedImageAttachment,
  FileAttachmentLimits,
  FileAttachmentRef,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageRequestPolicy,
  ImageMediaType,
  SaveFileAttachment,
  SaveImageAttachment,
  StoredFileAttachment,
  StoredImageAttachment,
  RequestImageAttachment,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    attachments: AttachmentStore
  }
}

/** Immutable binary attachment service. Implementations validate bytes before publishing a reference. */
export abstract class AttachmentStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'attachments')
  }

  /** Deployment-resolved image policy used by authoritative and fast-path validation. */
  abstract readonly imageLimits: ImageAttachmentLimits

  /**
   * Deployment-resolved generic-file policy; providers that do not accept
   * generic files leave this undefined and keep the default refusals.
   */
  readonly fileLimits?: FileAttachmentLimits

  /**
   * Validate one image without persisting it.
   * Batch callers validate every member before saving any member.
   * @param input - encoded bytes, declared media type, and optional display name.
   * @returns completion after the encoded raster has been fully decoded.
   */
  abstract validateImage(input: SaveImageAttachment): Promise<void>

  /**
   * Validate batch-wide limits before any durable write.
   * @param inputs - decoded images in submission order.
   */
  protected validateImageBatch(inputs: readonly SaveImageAttachment[]): void {
    const { maxImagesPerMessage, maxMessageImageBytes, mediaTypes } = this.imageLimits
    if (inputs.length > maxImagesPerMessage) {
      throw new AttachmentError('Image batch exceeds the configured image-count limit.', 'TOO_MANY_IMAGES')
    }
    const totalBytes = inputs.reduce((sum, input) => sum + input.data.byteLength, 0)
    if (totalBytes > maxMessageImageBytes) {
      throw new AttachmentError('Image batch exceeds the configured aggregate image-byte limit.', 'IMAGES_TOO_LARGE')
    }
    for (const input of inputs) {
      if (!mediaTypes.includes(input.mediaType)) {
        throw new AttachmentError(
          `Image type ${input.mediaType} is not accepted by this deployment.`,
          'UNSUPPORTED_IMAGE_TYPE',
        )
      }
    }
  }

  /**
   * Validate every member before committing an ordered image batch.
   * @param inputs - decoded images in submission order.
   * @returns durable references in the same order.
   */
  async saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]> {
    this.validateImageBatch(inputs)
    for (const input of inputs) await this.validateImage(input)
    const refs: ImageAttachmentRef[] = []
    for (const input of inputs) refs.push(await this.saveImage(input))
    return refs
  }

  /**
   * Validate and durably commit one image before its owning session event is appended.
   * @param input - encoded bytes, declared media type, and optional display name.
   * @returns a durable content-addressed reference.
   */
  abstract saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>

  /**
   * Read one image and verify that bytes still match the recorded reference.
   * @param ref - durable reference from the session log.
   * @param signal - optional cancellation for backend read and verification work.
   * @returns the verified bytes and canonical reference.
   * @throws the signal reason when aborted, or a storage error when verification fails.
   */
  abstract readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>

  /**
   * Derive a bounded model-request image without changing the durable object.
   * Providers that do not implement projection retain their existing behavior.
   * @param ref - durable image reference.
   * @param policy - pixel and encoded-byte limits for the transient version.
   * @param signal - optional cancellation signal.
   * @returns the transient request image version.
   */
  readImageRequest(
    ref: ImageAttachmentRef,
    policy: ImageRequestPolicy,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    signal?.throwIfAborted()
    void ref
    void policy
    return Promise.reject(new AttachmentError(
      'The mounted attachment provider cannot derive model-request images.',
      'ATTACHMENT_PROJECTION_UNSUPPORTED',
    ))
  }

  /**
   * Durably commit one generic file, bytes verbatim (no sniffing, no
   * normalization). Default refusal keeps existing implementations valid.
   * @param input - raw bytes, optional declared media type, optional display name.
   * @returns a durable content-addressed reference.
   */
  saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef> {
    void input
    return Promise.reject(new AttachmentError(
      'The mounted attachment provider does not accept generic files.',
      'FILE_UPLOAD_UNSUPPORTED',
    ))
  }

  /**
   * Read one generic file and verify its bytes against the reference digest.
   * Default refusal keeps existing implementations valid.
   * @param ref - durable reference from the session log.
   * @param signal - optional cancellation for backend read and verification work.
   * @returns the verified bytes and canonical reference.
   */
  readFile(ref: FileAttachmentRef, signal?: AbortSignal): Promise<StoredFileAttachment> {
    signal?.throwIfAborted()
    void ref
    return Promise.reject(new AttachmentError(
      'The mounted attachment provider does not expose generic files.',
      'FILE_UPLOAD_UNSUPPORTED',
    ))
  }

  /**
   * Publish (idempotently) the read-only hard-link handle path a model reads
   * a stored file through. Default refusal keeps existing implementations valid.
   * @param ref - durable reference from the session log.
   * @returns the absolute read-only path.
   */
  publishFileHandle(ref: FileAttachmentRef): Promise<string> {
    void ref
    return Promise.reject(new AttachmentError(
      'The mounted attachment provider does not expose file handles.',
      'FILE_UPLOAD_UNSUPPORTED',
    ))
  }
}

export default AttachmentStore
