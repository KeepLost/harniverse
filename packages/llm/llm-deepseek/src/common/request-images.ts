/** Shared request-image preparation, budget offload, and Files representation selection. */

import { limitRequestImages, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageWireLocation, Message, RequestImageBudgetLimits } from '@deepseek-ai/dsh-llm'
import type {
  AttachmentId,
  AttachmentStore,
  ImageAttachmentRef,
  ImageRequestPolicy,
  RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { DeepSeekCatalogModel, DeepSeekConnectionOptions as Connection } from './types.ts'
import { DeepSeekFileStore } from './file-store.ts'
import type { DeepSeekFilePolicy } from './file-store.ts'
import type { DeepSeekProtocol } from './types.ts'
import { DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET, DEFAULT_REQUEST_IMAGE_MAX_BYTES, DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET } from './defaults.ts'

/**
 * The projection policy one catalog entry projects on this route. Shared with
 * `modelInfo`, so a consumer showing "what the model sees" resolves the exact
 * bytes the request path itself would prepare.
 * @param model - the catalog entry for the requested model, if any.
 * @returns the request-image policy for the route.
 */
export function requestImagePolicyOf(model: DeepSeekCatalogModel | undefined): ImageRequestPolicy {
  const budget = model?.imagePixelBudget === 'low' ? DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET
    : model?.imagePixelBudget ?? DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET
  return { maxPixels: budget, maxBytes: model?.imageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES }
}

/** One request-image version with the exact remote id a model request used. */
export interface UsedFileGeneration {
  variantId: RequestImageAttachment['variantId']
  fileId: string
}

/** Provider representation for one retained request image. */
export type ImageRequestRepresentation =
  | {
    kind: 'file'
    resolveFileId: (
      version: RequestImageAttachment,
      location: ImageWireLocation,
    ) => Promise<string>
    /** Generations this representation resolved so far, in resolution order; exact invalidation reads them. */
    readonly used: readonly UsedFileGeneration[]
  }
  | { kind: 'base64' }

/** Dependencies required when serializing image-bearing messages. */
export interface ImageSerializationOptions {
  representation: ImageRequestRepresentation
  requestImages: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>
  /** Legacy attachment-wide omissions for direct serializer callers. */
  omittedImages?: ReadonlySet<AttachmentId>
  omittedOccurrences?: readonly ImageWireLocation[]
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
  const policy = requestImagePolicyOf(model)
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
 * @param messages - current projection, excluding previously settled occurrences.
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
  messages: readonly Message[],
): ImageSerializationOptions {
  if (prepared.refs.length !== prepared.versions.length) {
    throw new LlmError('DeepSeek image preparation returned mismatched references.', 'INVALID_REQUEST')
  }
  const versions = new Map(prepared.versions.map(version => [version.attachment.attachmentId, version]))
  const pairs: { ref: ImageAttachmentRef; version: RequestImageAttachment; location: ImageWireLocation }[] = []
  for (const [message, entry] of messages.entries()) {
    let image = 0
    const visit = (blocks: readonly ContentBlock[]): void => {
      for (const block of blocks) {
        if (block.type === 'tool-result') visit(block.content)
        else if (block.type === 'image') {
          const version = versions.get(block.attachment.attachmentId)
          if (version === undefined) throw new LlmError('DeepSeek request image was not prepared.', 'INVALID_REQUEST')
          pairs.push({ ref: block.attachment, version, location: { message, image: image++ } })
        }
      }
    }
    visit(entry.content)
  }
  const limits: RequestImageBudgetLimits = {
    maxBytes: representation === 'file' ? connection.maxRequestFilesBytes : connection.maxInlineRequestImageBytes,
    maxCount: connection.maxImagesPerRequest,
    byteQuantum: representation === 'file' ? connection.imageOffloadByteQuantum : connection.inlineImageOffloadByteQuantum,
    countQuantum: connection.imageOffloadCountQuantum,
  }
  const limited = limitRequestImages(pairs, limits)
  const filePolicy: DeepSeekFilePolicy = {
    expiresAfterSeconds: connection.fileExpiresAfterSeconds,
    refreshMarginSeconds: connection.fileRefreshMarginSeconds,
    quotaCleanupBatch: connection.fileQuotaCleanupBatch,
  }
  return {
    requestImages: limited.requestImages,
    omittedOccurrences: limited.omittedOccurrences,
    representation: representation === 'base64'
      ? { kind: 'base64' }
      : (() => {
        const used: UsedFileGeneration[] = []
        return {
          kind: 'file' as const,
          used,
          resolveFileId: async (version: RequestImageAttachment, location: ImageWireLocation) => {
            void location
            const timeout = AbortSignal.timeout(connection.filesApiTimeoutMs)
            const uploadSignal = AbortSignal.any([signal, timeout])
            const file = await files.ensureUploaded(version, { baseURL: connection.baseURL, apiKey, protocol }, filePolicy, uploadSignal)
            used.push({ variantId: version.variantId, fileId: String(file.record.fileId) })
            return String(file.record.fileId)
          },
        }
      })(),
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
