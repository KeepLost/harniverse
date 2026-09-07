/** Local durable attachment backend rooted below `DSH_HOME`. @module @deepseek-ai/dsh-attachment-local */

import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  FileAttachmentLimits,
  FileAttachmentRef,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveFileAttachment,
  SaveImageAttachment,
  StoredFileAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { readImageFile, saveImageFile, validateImageFile } from './store.ts'
import { publishFileHandle, readFileObject, saveFileObject } from './files.ts'
import { readRequestImageFile } from './request-image.ts'
import type { ImageRequestPolicy, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'

export { detectImage } from './image.ts'
export { readImageFile, saveImageFile, validateImageFile } from './store.ts'
export { publishFileHandle, readFileObject, saveFileObject } from './files.ts'
export { readRequestImageFile, requestImageDimensions, requestImageVariantId } from './request-image.ts'

/** Default maximum encoded bytes for one image. */
export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** Default maximum images in one prompt. */
export const DEFAULT_MAX_IMAGES_PER_MESSAGE = 20
/** Default maximum aggregate image bytes in one prompt. */
export const DEFAULT_MAX_MESSAGE_IMAGE_BYTES = 100 * 1024 * 1024
/** Default maximum intrinsic pixels for one image. */
export const DEFAULT_MAX_IMAGE_PIXELS = 40_000_000
/** Default maximum bytes for one uploaded generic file. */
export const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024

/** Local attachment backend configuration. */
export interface Config {
  /** Explicit harness home; omitted follows `DSH_HOME`, then `~/.dsh`. */
  dshHome?: string
  /** Maximum encoded bytes accepted for one image. */
  maxImageBytes?: number
  /** Maximum image count accepted in one submitted message. */
  maxImagesPerMessage?: number
  /** Maximum aggregate encoded image bytes accepted in one submitted message. */
  maxMessageImageBytes?: number
  /** Maximum intrinsic width multiplied by height accepted for one image. */
  maxImagePixels?: number
  /** Maximum bytes accepted for one uploaded generic file. */
  maxFileBytes?: number
}

/** Persistent content-addressed local attachment store. */
export class LocalAttachmentStore extends AttachmentStore {
  static Config: z<Config> = z.object({
    dshHome: z.string(),
    maxImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_BYTES),
    maxImagesPerMessage: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGES_PER_MESSAGE),
    maxMessageImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_IMAGE_BYTES),
    maxImagePixels: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_PIXELS),
    maxFileBytes: z.number().step(1).min(1).default(DEFAULT_MAX_FILE_BYTES),
  })

  /** Absolute versioned storage root. */
  readonly root: string
  readonly imageLimits: ImageAttachmentLimits
  override readonly fileLimits: FileAttachmentLimits

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.root = resolve(join(resolveDshHome(config.dshHome), 'attachments', 'v1'))
    this.imageLimits = Object.freeze({
      maxImageBytes: config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
      maxImagesPerMessage: config.maxImagesPerMessage ?? DEFAULT_MAX_IMAGES_PER_MESSAGE,
      maxMessageImageBytes: config.maxMessageImageBytes ?? DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
      maxImagePixels: config.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS,
      mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const),
    })
    this.fileLimits = Object.freeze({
      maxFileBytes: config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    })
  }

  async validateImage(input: SaveImageAttachment): Promise<void> {
    await validateImageFile(input, this.imageLimits)
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return saveImageFile(this.root, input, this.imageLimits)
  }

  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    return readImageFile(this.root, ref, signal)
  }

  override async saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef> {
    return saveFileObject(this.root, input, this.fileLimits)
  }

  override async readFile(ref: FileAttachmentRef, signal?: AbortSignal): Promise<StoredFileAttachment> {
    return readFileObject(this.root, ref, signal)
  }

  override async publishFileHandle(ref: FileAttachmentRef): Promise<string> {
    return publishFileHandle(this.root, ref)
  }

  override async readImageRequest(
    ref: ImageAttachmentRef,
    policy: ImageRequestPolicy,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    const stored = await this.readImage(ref, signal)
    return readRequestImageFile(this.root, stored, policy, signal)
  }
}

export default LocalAttachmentStore
