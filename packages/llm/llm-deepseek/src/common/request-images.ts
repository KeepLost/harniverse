/** Shared request-image preparation, budget offload, and Files representation selection. */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {
  AttachmentId,
  AttachmentStore,
  ImageAttachmentRef,
  ImageRequestPolicy,
  RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { DeepSeekConnectionOptions as Connection } from './types.ts'
import { DeepSeekFileStore } from './file-store.ts'
import type { DeepSeekFilePolicy } from './file-store.ts'
import type { DeepSeekProtocol } from './types.ts'
import { DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET, DEFAULT_REQUEST_IMAGE_MAX_BYTES, DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET } from './defaults.ts'

/** Provider representation for one retained request image. */
export type ImageRequestRepresentation =
  | {
    kind: 'file'
    resolveFileId: (
      version: RequestImageAttachment,
      location: ImageWireLocation,
    ) => Promise<string>
  }
  | { kind: 'base64' }

/** Dependencies required when serializing image-bearing messages. */
export interface ImageSerializationOptions {
  representation: ImageRequestRepresentation
  requestImages: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>
  omittedImages?: ReadonlySet<AttachmentId>
}

/** Position of an image in the original harness message sequence. */
export interface ImageWireLocation {
  message: number
  image: number
}

/** Collected references and their prepared request versions. */
export interface PreparedRequestImages {
  refs: readonly ImageAttachmentRef[]
  versions: readonly RequestImageAttachment[]
}

function collectImageRefs(content: readonly ContentBlock[], refs: Map<AttachmentId, ImageAttachmentRef>): void {
  for (const block of content) {
    if (block.type === 'image') refs.set(block.attachment.attachmentId, block.attachment)
    else if (block.type === 'tool-result') collectImageRefs(block.content, refs)
  }
}

function limitRequestImages(
  refs: readonly ImageAttachmentRef[],
  versions: readonly RequestImageAttachment[],
  maxBytes: number,
  maxCount: number,
  byteQuantum: number,
  countQuantum: number,
): { requestImages: Map<AttachmentId, RequestImageAttachment>; omittedImages: Set<AttachmentId> } {
  /* v8 ignore next 3 -- collectRequestImages pushes one version per reference,
     so the lists cannot diverge; this keeps the pairing total for any other caller. */
  if (refs.length !== versions.length) {
    throw new LlmError('DeepSeek image preparation returned mismatched references.', 'INVALID_REQUEST')
  }
  // Pairing at construction keeps every later index total, so omission reads
  // one reference beside the exact version prepared for it.
  const pairs = refs.map((ref, index) => ({ ref, version: versions[index] as RequestImageAttachment }))
  const omittedImages = new Set<AttachmentId>()
  const targetCount = pairs.length > maxCount && maxCount > countQuantum
    ? maxCount - countQuantum
    : maxCount
  let start = Math.max(0, pairs.length - targetCount)
  let total = pairs.slice(start).reduce((sum, pair) => sum + pair.version.bytes, 0)
  const targetBytes = total > maxBytes && maxBytes > byteQuantum
    ? maxBytes - byteQuantum
    : maxBytes
  while (start < pairs.length && total > targetBytes) {
    const pair = pairs[start] as (typeof pairs)[number]
    omittedImages.add(pair.ref.attachmentId)
    total -= pair.version.bytes
    start += 1
  }
  for (const pair of pairs.slice(0, start)) omittedImages.add(pair.ref.attachmentId)
  return {
    requestImages: new Map(pairs.slice(start).map(pair => [pair.version.attachment.attachmentId, pair.version])),
    omittedImages,
  }
}

/**
 * Collect durable image references and prepare bounded request versions.
 * @param options - generation request and message history.
 * @param connection - validated connection facts with image budgets.
 * @param resolveAttachments - plugin-owned attachment service resolver.
 * @param signal - request cancellation.
 * @returns references with prepared versions, or undefined for text-only requests.
 */
export async function collectRequestImages(
  options: GenerateOptions,
  connection: Connection,
  resolveAttachments: (() => AttachmentStore | undefined) | undefined,
  signal: AbortSignal,
): Promise<PreparedRequestImages | undefined> {
  const refsById = new Map<AttachmentId, ImageAttachmentRef>()
  for (const message of options.messages) collectImageRefs(message.content, refsById)
  const refs = [...refsById.values()]
  if (refs.length === 0) return undefined
  const model = connection.models.find(entry => entry.id === options.model)
  if (!model?.inputModalities?.includes('image')) {
    throw new LlmError(`DeepSeek model "${options.model}" does not support image input`, 'UNSUPPORTED_CONTENT')
  }
  const attachments = resolveAttachments?.()
  if (attachments === undefined) {
    throw new LlmError('DeepSeek image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
  }
  const budget = model.imagePixelBudget === 'low' ? DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET
    : model.imagePixelBudget ?? DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET
  const policy: ImageRequestPolicy = {
    maxPixels: budget,
    maxBytes: model.imageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  }
  const versions: RequestImageAttachment[] = []
  for (const ref of refs) versions.push(await attachments.readImageRequest(ref, policy, signal))
  return { refs, versions }
}

/**
 * Select the serialized image set and its provider representation.
 * @param prepared - collected references and prepared versions.
 * @param connection - validated connection facts with image budgets.
 * @param files - process-wide upload reuse store.
 * @param apiKey - request credential snapshot.
 * @param signal - request cancellation.
 * @param representation - file references or inline base64.
 * @param protocol - wire protocol owning the Files endpoint flavor.
 * @returns serialization options for either protocol.
 */
export function imageSerialization(
  prepared: PreparedRequestImages,
  connection: Connection,
  files: DeepSeekFileStore,
  apiKey: string,
  signal: AbortSignal,
  representation: 'file' | 'base64',
  protocol: DeepSeekProtocol,
): ImageSerializationOptions {
  const limited = limitRequestImages(
    prepared.refs,
    prepared.versions,
    representation === 'file' ? connection.maxRequestFilesBytes : connection.maxInlineRequestImageBytes,
    connection.maxImagesPerRequest,
    representation === 'file' ? connection.imageOffloadByteQuantum : connection.inlineImageOffloadByteQuantum,
    connection.imageOffloadCountQuantum,
  )
  const filePolicy: DeepSeekFilePolicy = {
    expiresAfterSeconds: connection.fileExpiresAfterSeconds,
    refreshMarginSeconds: connection.fileRefreshMarginSeconds,
    quotaCleanupBatch: connection.fileQuotaCleanupBatch,
  }
  return {
    requestImages: limited.requestImages,
    omittedImages: limited.omittedImages,
    representation: representation === 'base64'
      ? { kind: 'base64' }
      : {
        kind: 'file',
        resolveFileId: async (version, location) => {
          void location
          const timeout = AbortSignal.timeout(connection.filesApiTimeoutMs)
          const uploadSignal = AbortSignal.any([signal, timeout])
          const file = await files.ensureUploaded(version, { baseURL: connection.baseURL, apiKey, protocol }, filePolicy, uploadSignal)
          return String(file.record.fileId)
        },
      },
  }
}

/** Whether a provider error reports an unusable cached file id.
 * @param error - parsed provider error body, when available.
 * @returns whether the failure describes a stale, deleted, or missing file id.
 */
export function staleFileDetail(error?: { message?: string; type?: string; code?: string }): boolean {
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ')
  const stale = new RegExp(
    '(?:file[_ -]?id|file).*(?:expired|deleted|missing|invalid|not found)'
      + '|(?:expired|deleted|missing|invalid|not found).*(?:file[_ -]?id|file)',
    'iu',
  )
  return stale.test(detail)
}
