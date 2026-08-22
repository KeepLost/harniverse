/** Deterministic, sidecar-cached image versions for model requests. */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import sharp from 'sharp'
import { AttachmentError, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentRef,
  ImageMediaType,
  ImageRequestPolicy,
  RequestImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'

/** Transform version included in every request-image cache identity. */
export const REQUEST_IMAGE_TRANSFORM_VERSION = 'request-image-v1'
const REQUEST_IMAGE_QUALITIES = [85, 80] as const
const inFlight = new Map<string, Promise<EncodedImage>>()

interface EncodedImage {
  data: Uint8Array
  mediaType: ImageMediaType
  width: number
  height: number
}

interface ImageMetadata {
  mediaType: ImageMediaType
  width: number
  height: number
  hasAlpha: boolean
}

const MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function checkedPolicy(policy: ImageRequestPolicy): void {
  if (!Number.isSafeInteger(policy.maxPixels) || policy.maxPixels <= 0
    || !Number.isSafeInteger(policy.maxBytes) || policy.maxBytes <= 0) {
    throw new AttachmentError('Image request policy must contain positive safe integers.', 'INVALID_IMAGE_POLICY')
  }
}

/** Compute aspect-preserving dimensions without enlarging a source image.
 * @param width - source width in pixels.
 * @param height - source height in pixels.
 * @param maxPixels - total pixel budget.
 * @returns bounded dimensions.
 */
export function requestImageDimensions(
  width: number,
  height: number,
  maxPixels: number,
): { width: number; height: number } {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)))
  let nextWidth = Math.max(1, Math.floor(width * scale))
  let nextHeight = Math.max(1, Math.floor(height * scale))
  while (nextWidth * nextHeight > maxPixels) {
    if (nextWidth >= nextHeight && nextWidth > 1) nextWidth -= 1
    else if (nextHeight > 1) nextHeight -= 1
    else break
  }
  return { width: nextWidth, height: nextHeight }
}

function variantDescriptor(ref: ImageAttachmentRef, policy: ImageRequestPolicy): string {
  return JSON.stringify({
    transform: REQUEST_IMAGE_TRANSFORM_VERSION,
    attachmentId: ref.attachmentId,
    maxPixels: policy.maxPixels,
    maxBytes: policy.maxBytes,
    qualities: REQUEST_IMAGE_QUALITIES,
  })
}

/** Return the complete cache identity for one attachment and route policy.
 * @param ref - durable source reference.
 * @param policy - request-image budget.
 * @returns deterministic variant identity.
 */
export function requestImageVariantId(
  ref: ImageAttachmentRef,
  policy: ImageRequestPolicy,
): ImageVariantId {
  return ImageVariantId(`sha256:${digest(variantDescriptor(ref, policy))}`)
}

async function metadata(data: Uint8Array): Promise<ImageMetadata> {
  try {
    const info = await sharp(data, { failOn: 'error', limitInputPixels: false }).metadata()
    const mediaType = MEDIA_TYPES[info.format]
    if (mediaType === undefined) {
      throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE')
    }
    return {
      mediaType,
      width: info.width,
      height: info.height,
      hasAlpha: info.hasAlpha,
    }
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
  }
}

async function encode(
  source: Uint8Array,
  width: number,
  height: number,
  hasAlpha: boolean,
  quality: number,
): Promise<EncodedImage> {
  const image = sharp(source, { failOn: 'error', limitInputPixels: false })
    .toColourspace('srgb')
    .resize({ width, height, fit: 'inside', withoutEnlargement: true })
  const output = hasAlpha
    ? image.webp({ quality })
    : image.jpeg({ quality })
  const { data, info } = await output.toBuffer({ resolveWithObject: true })
  return {
    data: new Uint8Array(data),
    mediaType: hasAlpha ? 'image/webp' : 'image/jpeg',
    width: info.width,
    height: info.height,
  }
}

async function createRequestImage(
  stored: StoredImageAttachment,
  policy: ImageRequestPolicy,
  source: ImageMetadata,
): Promise<EncodedImage> {
  const dimensions = requestImageDimensions(source.width, source.height, policy.maxPixels)
  const canPassThrough = source.mediaType !== 'image/gif'
    && dimensions.width === source.width
    && dimensions.height === source.height
    && stored.data.byteLength <= policy.maxBytes
  if (canPassThrough) {
    return {
      data: stored.data,
      mediaType: source.mediaType,
      width: source.width,
      height: source.height,
    }
  }

  let current = dimensions
  for (;;) {
    for (const quality of REQUEST_IMAGE_QUALITIES) {
      const candidate = await encode(stored.data, current.width, current.height, source.hasAlpha, quality)
      if (candidate.data.byteLength <= policy.maxBytes) return candidate
    }
    if (current.width === 1 && current.height === 1) break
    current = {
      width: Math.max(1, Math.floor(current.width * 0.9)),
      height: Math.max(1, Math.floor(current.height * 0.9)),
    }
  }
  throw new AttachmentError('Image cannot be encoded within the model-request byte budget.', 'IMAGE_TOO_LARGE')
}

function cachePath(root: string, variantId: ImageVariantId): string {
  const hash = String(variantId).slice('sha256:'.length)
  return join(root, 'request-images', hash.slice(0, 2), hash)
}

async function readCache(
  path: string,
  source: ImageMetadata,
  policy: ImageRequestPolicy,
  signal?: AbortSignal,
): Promise<EncodedImage | undefined> {
  try {
    const data = new Uint8Array(await readFile(path, { signal }))
    const cached = await metadata(data)
    const dimensions = requestImageDimensions(source.width, source.height, policy.maxPixels)
    if (data.byteLength > policy.maxBytes || cached.width > dimensions.width || cached.height > dimensions.height) {
      return undefined
    }
    return { data, mediaType: cached.mediaType, width: cached.width, height: cached.height }
  } catch (error) {
    signal?.throwIfAborted()
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    return undefined
  }
}

async function writeCache(path: string, data: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: 'wx' })
    try {
      await rename(temporary, path)
    } catch (error) {
      // Another process may have published this immutable variant first.
      if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw error
    }
  } finally {
    await rm(temporary, { force: true })
  }
}

async function waitForImage(
  operation: Promise<EncodedImage>,
  signal?: AbortSignal,
): Promise<EncodedImage> {
  signal?.throwIfAborted()
  if (signal === undefined) return operation
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      reject(signal.reason instanceof Error
        ? signal.reason
        : new Error('Request image projection aborted', { cause: signal.reason }))
    }
    signal.addEventListener('abort', abort, { once: true })
    void operation.then((value) => {
      signal.removeEventListener('abort', abort)
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort)
      reject(error instanceof Error ? error : new Error('Request image projection failed', { cause: error }))
    })
  })
}

/** Generate or reuse one request image without changing the durable object.
 * @param root - local attachment storage root.
 * @param stored - verified durable source.
 * @param policy - request-image budget.
 * @param signal - optional cancellation signal.
 * @returns transient request image version.
 */
export async function readRequestImageFile(
  root: string,
  stored: StoredImageAttachment,
  policy: ImageRequestPolicy,
  signal?: AbortSignal,
): Promise<RequestImageAttachment> {
  signal?.throwIfAborted()
  checkedPolicy(policy)
  const source = await metadata(stored.data)
  const variantId = requestImageVariantId(stored.ref, policy)
  const path = cachePath(root, variantId)
  const cached = await readCache(path, source, policy, signal)
  let image = cached
  if (image === undefined) {
    let operation = inFlight.get(path)
    if (operation === undefined) {
      operation = createRequestImage(stored, policy, source).then(async (generated) => {
        if (generated.data !== stored.data) await writeCache(path, generated.data)
        return generated
      })
      inFlight.set(path, operation)
      void operation.finally(() => {
        if (inFlight.get(path) === operation) inFlight.delete(path)
      }).catch(() => {})
    }
    image = await waitForImage(operation, signal)
  }
  signal?.throwIfAborted()
  return {
    variantId,
    attachment: stored.ref,
    data: image.data,
    mediaType: image.mediaType,
    bytes: image.data.byteLength,
    width: image.width,
    height: image.height,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: source.hasAlpha,
  }
}
