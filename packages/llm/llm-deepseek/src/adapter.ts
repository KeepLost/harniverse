/**
 * `DeepSeekAdapter`: fetch + SSE against a DeepSeek (OpenAI-compatible)
 * chat-completions endpoint, emitting harness StreamChunks. The adapter is
 * transport-only: connection facts arrive through a thunk resolved once per
 * operation and the bearer token through a per-request resolver, so the
 * registering plugin owns validation, layering, and credential policy.
 *
 * @module dsh-llm-deepseek/adapter
 */

import {
  attributionHeaders,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  wireDiagnosticHeaders,
  wireRequestMetadata,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmFailure,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  LlmWireAttempt,
  LlmWireAttemptOutcome,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { AttachmentId, AttachmentStore, ImageAttachmentRef, ImageRequestPolicy, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { serializeRequest } from './serialize.ts'
import type { ImageSerializationOptions, RequestDefaults } from './serialize.ts'
import { parseSse } from './sse.ts'
import { translate } from './translate.ts'
import type { WireError, WireRequest } from './types.ts'
import { DeepSeekFileStore } from './file-store.ts'
import type { DeepSeekFilePolicy } from './file-store.ts'
import { deepSeekFileScope } from './upload-index.ts'

/** One optional model entry advertised by the direct-fetch adapter. */
export interface DeepSeekCatalogModel {
  /** Wire model id accepted by the configured endpoint. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail for deployments with similar model variants. */
  description?: string
  /** Known combined request/response context capacity; omitted when deployment metadata is unavailable. */
  contextWindow?: number
  /** Per-request output cap for this model; omission falls back to the profile's {@link DeepSeekConnectionOptions.maxTokens}. */
  maxTokens?: number
  /** Input modalities accepted by this exact configured route. */
  inputModalities?: ('text' | 'image')[]
  /** Maximum request-image pixels for image-capable routes. */
  imagePixelBudget?: number
  /** Maximum encoded bytes for one derived request image. */
  imageMaxBytes?: number
  /** Provider hint for low-detail image projection. */
  imageDetail?: 'auto' | 'low'
}

/**
 * Validated connection facts for one operation. The plugin's
 * `resolveAdapterOptions` is the one explicit resolve step producing this
 * shape; the adapter trusts it and re-reads it per operation, which is what
 * makes a configuration change reach the next request without re-registration.
 */
export interface DeepSeekConnectionOptions {
  /** Endpoint base; `/chat/completions` is appended. */
  baseURL: string
  /**
   * Credential reference of this same resolution, resolved per request.
   * Travelling with the endpoint is the point: a request can never pair one
   * generation's URL with another generation's secret. Configuration carries
   * only this name — a literal key is not a configuration value.
   */
  apiKeyEnv: CredentialRef
  /** Request defaults applied to every call (thinking mode, effort). */
  defaults: RequestDefaults
  /** Default per-request output cap; explicit request values win. */
  maxTokens: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly DeepSeekCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
  /** Provider-wide request-image byte budget before older images are omitted. */
  maxRequestFilesBytes: number
  /** Inline request-image byte budget after Files fallback. */
  maxInlineRequestImageBytes: number
  /** Maximum retained images in one provider request. */
  maxImagesPerRequest: number
  /** Raw image-byte offload quantum. */
  imageOffloadByteQuantum: number
  /** Inline image-byte offload quantum. */
  inlineImageOffloadByteQuantum: number
  /** Image-count offload quantum. */
  imageOffloadCountQuantum: number
  /** Files API resolution timeout. */
  filesApiTimeoutMs: number
  /** Requested remote file lifetime. */
  fileExpiresAfterSeconds: number
  /** Minimum remaining lifetime before an upload is refreshed. */
  fileRefreshMarginSeconds: number
  /** Number of old provider files deleted for one quota retry. */
  fileQuotaCleanupBatch: number
}

/** Constructor options for {@link DeepSeekAdapter}: the operation-local resolution hooks the plugin owns. */
export interface DeepSeekAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => DeepSeekConnectionOptions
  /**
   * Resolve the bearer token for the connection facts of one request. The
   * snapshot is passed in — never re-read — so the key can only ever come
   * from the same resolution as the endpoint it is sent to. Throws `LlmError`
   * `MISSING_CREDENTIAL` when no key is available anywhere.
   */
  resolveApiKey: (connection: DeepSeekConnectionOptions) => Promise<string>
  /** Resolve the harness-home anonymous id shared with telemetry and feedback. */
  resolveUserId: () => AnonymousUserId
  /** Resolve durable attachments only for image-bearing requests. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Resolve the provider-local remote file cache. */
  resolveFiles?: () => DeepSeekFileStore
}

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000
/** Default per-request output-token cap. */
export const DEFAULT_MAX_TOKENS = 256_000
/** Default total pixel budget for normal-detail request images. */
export const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 2_048 * 2_048
/** Default total pixel budget for low-detail request images. */
export const DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET = 512 * 512
/** Default encoded bytes for one request image. */
export const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1 * 1024 * 1024
/** Default aggregate bytes represented by Files API references. */
export const DEFAULT_MAX_REQUEST_FILES_BYTES = 128 * 1024 * 1024
/** Default aggregate bytes represented by inline image data. */
export const DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
/** Default maximum retained image count. */
export const DEFAULT_MAX_IMAGES_PER_REQUEST = 600
/** Default byte offload quantum for file representations. */
export const DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM = 64 * 1024 * 1024
/** Default byte offload quantum for inline representations. */
export const DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM = 10 * 1024 * 1024
/** Default image-count offload quantum. */
export const DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM = 20
/** Default deadline for resolving one Files API image. */
export const DEFAULT_FILES_API_TIMEOUT_MS = 60_000
/** Default requested remote file lifetime. */
export const DEFAULT_FILE_EXPIRY_SECONDS = 7 * 24 * 60 * 60
/** Default refresh margin before remote file expiry. */
export const DEFAULT_FILE_REFRESH_MARGIN_SECONDS = 60 * 60
/** Default number of provider files removed during quota recovery. */
export const DEFAULT_FILE_QUOTA_CLEANUP_BATCH = 100
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'
const OFF_REASONING_EFFORT = ReasoningEffortId('off')
const HIGH_REASONING_EFFORT = ReasoningEffortId('high')
const MAX_REASONING_EFFORT = ReasoningEffortId('max')
const REASONING_EFFORTS = [
  { id: OFF_REASONING_EFFORT, name: 'Off' },
  { id: HIGH_REASONING_EFFORT, name: 'High' },
  { id: MAX_REASONING_EFFORT, name: 'Max' },
] as const
const OFF_ONLY_REASONING_EFFORTS = [
  { id: OFF_REASONING_EFFORT, name: 'Off' },
] as const

function modelInfo(provider: string, model: DeepSeekCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: model.inputModalities ?? ['text'],
  }
}

function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function requestId(headers: Headers): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers.get('x-request-id') ?? headers.get('x-deepseek-request-id')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

function wireFailure(error: unknown): LlmFailure {
  if (error instanceof LlmError) return error.failure
  return {
    message: error instanceof Error ? error.message : String(error),
    code: 'TRANSPORT',
  }
}

function staleFileDetail(error?: WireError['error']): boolean {
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ')
  const stale = new RegExp(
    '(?:file[_ -]?id|file).*(?:expired|deleted|missing|invalid|not found)'
      + '|(?:expired|deleted|missing|invalid|not found).*(?:file[_ -]?id|file)',
    'iu',
  )
  return stale.test(detail)
}

function collectImageRefs(content: readonly import('@deepseek-ai/dsh-llm').ContentBlock[], refs: Map<AttachmentId, ImageAttachmentRef>): void {
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
  const omittedImages = new Set<AttachmentId>()
  const targetCount = refs.length > maxCount && maxCount > countQuantum
    ? maxCount - countQuantum
    : maxCount
  let start = Math.max(0, refs.length - targetCount)
  let total = versions.slice(start).reduce((sum, version) => sum + version.bytes, 0)
  const targetBytes = total > maxBytes && maxBytes > byteQuantum
    ? maxBytes - byteQuantum
    : maxBytes
  while (start < refs.length && total > targetBytes) {
    const ref = refs[start]
    const version = versions[start]
    if (ref === undefined || version === undefined) {
      throw new LlmError('DeepSeek image preparation returned mismatched references.', 'INVALID_REQUEST')
    }
    omittedImages.add(ref.attachmentId)
    total -= version.bytes
    start += 1
  }
  for (let index = 0; index < start; index += 1) {
    const ref = refs[index]
    if (ref !== undefined) omittedImages.add(ref.attachmentId)
  }
  return {
    requestImages: new Map(versions.slice(start).map(version => [version.attachment.attachmentId, version])),
    omittedImages,
  }
}

/**
 * Map an HTTP status to a stable LlmError code.
 * @param status - status of a non-2xx provider response.
 * @param error - parsed provider error body, when available.
 * @returns the normalized harness error code.
 */
export function httpErrorCode(status: number, error?: WireError['error']): string {
  if (status === 401 || status === 403) return 'AUTH'
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * The first real `LlmAdapter`. One instance serves every model name it was
 * registered under (the harness model name IS the wire model name).
 *
 * One stable signal reaches both initial fetch and body reads. Caller aborts
 * map to `ABORTED`; the configured per-read idle watchdog maps to `TIMEOUT`.
 */
export class DeepSeekAdapter extends LlmAdapter {
  private readonly files: DeepSeekFileStore

  constructor(private readonly config: DeepSeekAdapterOptions) {
    super()
    this.files = config.resolveFiles?.() ?? new DeepSeekFileStore()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'DeepSeek' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.options().models.map(model => modelInfo(provider, model)))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const configured = connection.models.find(entry => entry.id === model)
    const contextWindow = configured?.contextWindow
      ?? connection.defaultContextWindow
    return Promise.resolve({
      // Unknown models remain text-only because the adapter has no modality
      // evidence for an uncatalogued route.
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : modelInfo(provider, configured),
      context: { contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      ...connection.defaults.thinking === 'disabled'
        ? {
          reasoning: {
            efforts: OFF_ONLY_REASONING_EFFORTS,
            defaultEffort: OFF_REASONING_EFFORT,
          },
        }
        : {
          reasoning: {
            efforts: REASONING_EFFORTS,
            defaultEffort: connection.defaults.reasoningEffort === 'off'
              ? OFF_REASONING_EFFORT
              : connection.defaults.reasoningEffort === 'max'
                ? MAX_REASONING_EFFORT
                : HIGH_REASONING_EFFORT,
          },
        },
    })
  }

  private async prepareImages(
    options: GenerateOptions,
    connection: DeepSeekConnectionOptions,
    signal: AbortSignal,
  ): Promise<{ versions: readonly RequestImageAttachment[]; refs: readonly ImageAttachmentRef[] } | undefined> {
    const refsById = new Map<AttachmentId, ImageAttachmentRef>()
    for (const message of options.messages) collectImageRefs(message.content, refsById)
    const refs = [...refsById.values()]
    if (refs.length === 0) return undefined
    const model = connection.models.find(entry => entry.id === options.model)
    if (!model?.inputModalities?.includes('image')) {
      throw new LlmError(`DeepSeek model "${options.model}" does not support image input`, 'UNSUPPORTED_CONTENT')
    }
    const attachments = this.config.resolveAttachments?.()
    if (attachments === undefined) {
      throw new LlmError('DeepSeek image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    const policy: ImageRequestPolicy = {
      maxPixels: model.imagePixelBudget
        ?? (model.imageDetail === 'low' ? DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET : DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET),
      maxBytes: model.imageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES,
    }
    const versions: RequestImageAttachment[] = []
    for (const ref of refs) versions.push(await attachments.readImageRequest(ref, policy, signal))
    return { refs, versions }
  }

  private imageSerialization(
    prepared: { versions: readonly RequestImageAttachment[]; refs: readonly ImageAttachmentRef[] },
    connection: DeepSeekConnectionOptions,
    apiKey: string,
    signal: AbortSignal,
    representation: 'file' | 'base64',
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
            const file = await this.files.ensureUploaded(version, { baseURL: connection.baseURL, apiKey }, filePolicy, uploadSignal)
            return String(file.record.fileId)
          },
        },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // One resolution per stream call: connection facts and the credential
    // freeze here and hold for this whole request, so an in-flight stream
    // never observes a configuration change and the next call re-resolves.
    // The key resolves *from this snapshot*, so an endpoint and the secret
    // sent to it can never come from different configuration generations.
    const connection = this.config.options()
    const apiKey = await this.config.resolveApiKey(connection)
    const userId = this.config.resolveUserId()
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(
      options,
      watchdog.signal,
      connection,
      apiKey,
      userId,
      () => { watchdog.pulse() },
    )[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `DeepSeek stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('DeepSeek request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`DeepSeek API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('DeepSeek stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
        }
      }
    }
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: DeepSeekConnectionOptions,
    apiKey: string,
    userId: AnonymousUserId,
    onComment: () => void,
  ): AsyncIterable<StreamChunk> {
    const prepared = await this.prepareImages(options, connection, signal)
    let body: WireRequest
    if (prepared === undefined) {
      body = serializeRequest(options, connection.defaults)
    } else {
      try {
        body = await serializeRequest(
          options,
          connection.defaults,
          this.imageSerialization(prepared, connection, apiKey, signal, 'file'),
        )
      } catch (error) {
        if (signal.aborted) throw error
        // Files API resolution is an optimization. The same request is retried
        // with one consistent inline representation instead of mixing ids and
        // data URLs from two attempts.
        body = await serializeRequest(
          options,
          connection.defaults,
          this.imageSerialization(prepared, connection, apiKey, signal, 'base64'),
        )
      }
    }
    // Prepared outside the try so the TRANSPORT label below covers exactly the
    // transport boundary, never a serialization failure.
    const headers = {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
      'x-deepseek-harness-user-id': String(userId),
      ...options.sessionId !== undefined
        ? { 'x-deepseek-harness-session-id': String(options.sessionId) }
        : {},
      ...options.purpose === 'compaction'
        ? { 'x-deepseek-harness-compact': '1' }
        : {},
    }

    const exchangeId = options.wireExchangeId ?? crypto.randomUUID()
    let attemptNumber = 0
    const report = (
      attempt: {
        readonly attempt: number
        readonly request: ReturnType<typeof wireRequestMetadata>
        readonly startedAt: number
      },
      outcome: LlmWireAttemptOutcome,
      response?: Response,
      failure?: LlmFailure,
    ): void => {
      if (options.onWireAttempt === undefined) return
      const responseHeaders: Record<string, string> = {}
      response?.headers.forEach((value, key) => { responseHeaders[key] = value })
      const diagnosticHeaders = wireDiagnosticHeaders(responseHeaders)
      const responseInfo = response === undefined
        ? undefined
        : {
          status: response.status,
          ...diagnosticHeaders === undefined ? {} : { headers: diagnosticHeaders },
        }
      const record: LlmWireAttempt = {
        exchangeId,
        attempt: attempt.attempt,
        api: 'openai-completions',
        provider: options.provider,
        model: options.model,
        url: `${connection.baseURL}/chat/completions`,
        method: 'POST',
        request: attempt.request,
        ...responseInfo === undefined ? {} : { response: responseInfo },
        ...failure === undefined ? {} : { failure },
        outcome,
        durationMs: Math.max(0, Date.now() - attempt.startedAt),
      }
      options.onWireAttempt(record)
    }

    const send = async (requestBody: WireRequest): Promise<{
      readonly response: Response
      readonly attempt: { readonly attempt: number; readonly request: ReturnType<typeof wireRequestMetadata>; readonly startedAt: number }
    }> => {
      // TODO(http): adopt the Cordis HTTP service when shared transport configuration
      // outweighs its additional runtime dependencies.
      const attempt = {
        attempt: ++attemptNumber,
        request: wireRequestMetadata(requestBody),
        startedAt: Date.now(),
      }
      try {
        const response = await fetch(`${connection.baseURL}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
          signal,
        })
        return { response, attempt }
      } catch (error: unknown) {
        // The outer stream distinguishes caller cancellation and watchdog expiry.
        report(attempt, signal.aborted ? 'aborted' : 'transport-error', undefined, wireFailure(error))
        if (signal.aborted) throw error
        // fetch wraps every transport failure (DNS, refused connection, TLS,
        // proxy) in a bare `TypeError: fetch failed` whose actionable detail
        // lives on `cause`. Wrapping with the endpoint and chaining the cause
        // lets `errorChain` render the full diagnosis at every reporting boundary.
        throw new LlmError(
          `DeepSeek API request to ${connection.baseURL} failed`,
          'TRANSPORT',
          { cause: error },
        )
      }
    }

    let sent = await send(body)
    let response = sent.response
    let parsedError: WireError['error']
    if (!response.ok) {
      try { parsedError = (await response.json() as WireError).error } catch { /* status remains authoritative */ }
      if (prepared !== undefined && staleFileDetail(parsedError)) {
        report(sent.attempt, 'http-error', response, {
          message: parsedError?.message ?? `DeepSeek API error (HTTP ${response.status})`,
          code: httpErrorCode(response.status, parsedError),
          status: response.status,
        })
        await this.files.clear(deepSeekFileScope(connection.baseURL, apiKey))
        body = await serializeRequest(
          options,
          connection.defaults,
          this.imageSerialization(prepared, connection, apiKey, signal, 'base64'),
        )
        sent = await send(body)
        response = sent.response
        parsedError = undefined
      }
    }

    if (!response.ok) {
      let message = `DeepSeek API error (HTTP ${response.status})`
      let providerError = parsedError
      try {
        if (providerError === undefined) providerError = (await response.json() as WireError).error
        if (providerError?.message) message = providerError.message
      } catch {
        // Only swallow error-body parsing: the HTTP status still identifies the
        // failure, so malformed gateway JSON must not mask it.
      }
      const delay = providerRetryAfterMs(response.headers.get('retry-after'))
      const id = requestId(response.headers)
      const failure: LlmFailure = {
        message,
        code: httpErrorCode(response.status, providerError),
        status: response.status,
        ...delay === undefined ? {} : { providerRetryAfterMs: delay },
        ...id === undefined ? {} : { requestId: id },
      }
      report(sent.attempt, 'http-error', response, failure)
      throw new LlmError(message, failure.code, {
        status: response.status,
        ...failure.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: failure.providerRetryAfterMs },
        ...failure.requestId === undefined ? {} : { requestId: failure.requestId },
      })
    }
    if (!response.body) {
      const failure = new LlmError('DeepSeek API returned no response body', 'EMPTY_RESPONSE')
      report(sent.attempt, 'stream-error', response, failure.failure)
      throw failure
    }

    try {
      yield* translate(parseSse(response.body, onComment))
      report(sent.attempt, 'success', response)
    } catch (error: unknown) {
      report(sent.attempt, signal.aborted ? 'aborted' : 'stream-error', response, wireFailure(error))
      throw error
    }
  }
}
