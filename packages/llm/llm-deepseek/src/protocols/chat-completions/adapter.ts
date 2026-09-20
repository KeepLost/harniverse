/**
 * `ChatCompletionsAdapter`: fetch + SSE against a DeepSeek (OpenAI-compatible)
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
  wireDiagnosticHeaders,
  wireRequestMetadata,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmFailure,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  LlmWireAttempt,
  LlmWireAttemptOutcome,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { DeepSeekAdapterOptions, DeepSeekConnectionOptions as Connection } from '../../common/types.ts'
import { catalogModelInfo, modelInfo } from '../../common/model-info.ts'
import type { DeepSeekFileStore } from '../../common/file-store.ts'
import { deepSeekFileScope } from '../../common/upload-index.ts'
import {
  collectRequestImages,
  imageSerialization,
  staleFileDetail,
} from '../../common/request-images.ts'
import { serializeRequest } from './serialize.ts'
import { parseSse } from './sse.ts'
import { translate } from './translate.ts'
import type { WireError, WireRequest } from './types.ts'

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

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
    /* v8 ignore next -- fetch and the SSE parser always throw Errors; the branch keeps the unknown-typed catch total. */
    message: error instanceof Error ? error.message : String(error),
    code: 'TRANSPORT',
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
 * The chat-completions wire implementation. One instance serves every model
 * name it was registered under (the harness model name IS the wire model name).
 *
 * One stable signal reaches both initial fetch and body reads. Caller aborts
 * map to `ABORTED`; the configured per-read idle watchdog maps to `TIMEOUT`.
 */
export class ChatCompletionsAdapter extends LlmAdapter {
  constructor(
    private readonly config: DeepSeekAdapterOptions,
    private readonly files: DeepSeekFileStore,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'DeepSeek' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string) {
    return Promise.resolve(this.config.options().models.map(model => catalogModelInfo(provider, model)))
  }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return Promise.resolve(modelInfo(this.config.options(), provider, model))
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.generate(options, this.config.options())
  }

  private async * generate(options: GenerateOptions, connection: Connection): AsyncGenerator<StreamChunk> {
    // One resolution per stream call: connection facts and the credential
    // freeze here and hold for this whole request, so an in-flight stream
    // never observes a configuration change and the next call re-resolves.
    // The key resolves *from this snapshot*, so an endpoint and the secret
    // sent to it can never come from different configuration generations.
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
    connection: Connection,
    apiKey: string,
    userId: AnonymousUserId,
    onComment: () => void,
  ): AsyncIterable<StreamChunk> {
    const prepared = await collectRequestImages(options, connection, this.config.resolveAttachments, signal)
    let body: WireRequest
    if (prepared === undefined) {
      body = serializeRequest(options, connection.defaults)
    } else {
      try {
        body = await serializeRequest(
          options,
          connection.defaults,
          imageSerialization(prepared, connection, this.files, apiKey, signal, 'file', 'chat-completions'),
        )
      } catch (error) {
        if (signal.aborted) throw error
        // Files API resolution is an optimization. The same request is retried
        // with one consistent inline representation instead of mixing ids and
        // data URLs from two attempts.
        body = await serializeRequest(
          options,
          connection.defaults,
          imageSerialization(prepared, connection, this.files, apiKey, signal, 'base64', 'chat-completions'),
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
      let responseInfo: LlmWireAttempt['response']
      if (response !== undefined) {
        const responseHeaders: Record<string, string> = {}
        response.headers.forEach((value, key) => { responseHeaders[key] = value })
        const diagnosticHeaders = wireDiagnosticHeaders(responseHeaders)
        /* v8 ignore next -- every HTTP reply carries content-type or date, both diagnostic, so a reply never projects an empty set. */
        responseInfo = { status: response.status, ...diagnosticHeaders === undefined ? {} : { headers: diagnosticHeaders } }
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
        await this.files.clear(deepSeekFileScope(connection.baseURL, apiKey, 'chat-completions'))
        body = await serializeRequest(
          options,
          connection.defaults,
          imageSerialization(prepared, connection, this.files, apiKey, signal, 'base64', 'chat-completions'),
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
