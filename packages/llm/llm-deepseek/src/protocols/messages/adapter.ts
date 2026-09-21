/** Direct Messages transport with one cancellable lifecycle per model request. */

import {
  attributionHeaders,
  LlmAdapter,
  LlmError,
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
import { MESSAGES_FILES_BETA, messagesApiRoot } from '../../common/messages-api.ts'
import {
  collectRequestImages,
  imageSerialization,
  projectImageOmissions,
  staleFileDetail,
} from '../../common/request-images.ts'
import type { ImageSerializationOptions } from '../../common/request-images.ts'
import { serialize } from './serialize.ts'
import { parseSse } from './sse.ts'
import { translate } from './translate.ts'
import { providerError } from './transport.ts'
import type { WireRequest } from './types.ts'

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

function wireFailure(error: unknown): LlmFailure {
  if (error instanceof LlmError) return error.failure
  return {
    /* v8 ignore next -- fetch and the SSE parser always throw Errors; the branch keeps the unknown-typed catch total. */
    message: error instanceof Error ? error.message : String(error),
    code: 'TRANSPORT',
  }
}

/** DeepSeek provider using Messages content and native thinking replay. */
export class DeepSeekMessagesAdapter extends LlmAdapter {
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
          `DeepSeek Messages stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('DeepSeek Messages request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`DeepSeek Messages stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('DeepSeek Messages stream consumer stopped')
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
    const onReplayDegrade = (reason: string): void => {
      this.config.onReplayDegrade?.({ provider: options.provider, model: options.model, reason })
    }
    let body: WireRequest
    let images: ImageSerializationOptions | undefined
    const selectImages = (representation: 'file' | 'base64'): void => {
      if (prepared === undefined) return
      images = imageSerialization(prepared, connection, this.files, apiKey, signal, representation, 'messages', options.messages)
      options = projectImageOmissions(options, images)
    }
    if (prepared === undefined) {
      body = await serialize(options, connection, connection.defaults, options.messages, undefined, onReplayDegrade)
    } else {
      selectImages('file')
      try {
        body = await serialize(options, connection, connection.defaults, options.messages, images, onReplayDegrade)
      } catch (error) {
        if (signal.aborted) throw error
        // Files API resolution is an optimization. The same request is retried
        // with one consistent inline representation instead of mixing file ids
        // and base64 sources from two attempts.
        selectImages('base64')
        body = await serialize(options, connection, connection.defaults, options.messages, images, onReplayDegrade)
      }
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
        api: 'messages',
        provider: options.provider,
        model: options.model,
        url: `${messagesApiRoot(connection.baseURL)}/messages`,
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
      const attempt = {
        attempt: ++attemptNumber,
        request: wireRequestMetadata(requestBody),
        startedAt: Date.now(),
      }
      const headers = {
        'content-type': 'application/json',
        'accept': 'text/event-stream',
        ...attributionHeaders(),
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        ...images?.representation.kind === 'file' && requestBody.messages.some(message => message.content.some(block => block.type === 'image' && block.source.type === 'file'))
          ? { 'anthropic-beta': MESSAGES_FILES_BETA }
          : {},
        'x-deepseek-harness-user-id': String(userId),
        ...options.sessionId !== undefined
          ? { 'x-deepseek-harness-session-id': String(options.sessionId) }
          : {},
        ...options.purpose === 'compaction'
          ? { 'x-deepseek-harness-compact': '1' }
          : {},
      }
      try {
        const response = await fetch(`${messagesApiRoot(connection.baseURL)}/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
          signal,
          redirect: 'error',
        })
        return { response, attempt }
      } catch (error: unknown) {
        report(attempt, signal.aborted ? 'aborted' : 'transport-error', undefined, wireFailure(error))
        if (signal.aborted) throw error
        throw new LlmError(
          `DeepSeek Messages request to ${connection.baseURL} failed`,
          'TRANSPORT',
          { cause: error },
        )
      }
    }

    let sent = await send(body)
    let response = sent.response
    if (!response.ok) {
      const text = await response.text()
      let raw: unknown
      try { raw = JSON.parse(text) } catch (_nonJsonGatewayError) {
        // HTTP status is authoritative when a gateway does not return JSON.
      }
      const error = typeof raw === 'object' && raw !== null && 'error' in raw
        ? (raw as { error?: { message?: string; type?: string; code?: string } }).error
        : undefined
      if (prepared !== undefined && staleFileDetail(error)) {
        report(sent.attempt, 'http-error', response, {
          message: error?.message ?? `DeepSeek Messages request failed (HTTP ${response.status})`,
          code: providerError(raw, response.status).code,
          status: response.status,
        })
        await this.files.clear(deepSeekFileScope(connection.baseURL, apiKey, 'messages'))
        selectImages('base64')
        body = await serialize(options, connection, connection.defaults, options.messages, images, onReplayDegrade)
        sent = await send(body)
        response = sent.response
      } else {
        const failure = providerError(raw, response.status, response.headers)
        report(sent.attempt, 'http-error', response, failure.failure)
        throw new LlmError(failure.failure.message, failure.code, {
          status: response.status,
          ...failure.failure.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: failure.failure.providerRetryAfterMs },
          ...failure.failure.requestId === undefined ? {} : { requestId: failure.failure.requestId },
          cause: new Error(text),
        })
      }
    }
    if (!response.body) {
      const failure = new LlmError('DeepSeek Messages returned no response body', 'EMPTY_RESPONSE')
      report(sent.attempt, 'stream-error', response, failure.failure)
      throw failure
    }

    try {
      yield* translate(parseSse(response.body, onComment), options.model)
      report(sent.attempt, 'success', response)
    } catch (error: unknown) {
      report(sent.attempt, signal.aborted ? 'aborted' : 'stream-error', response, wireFailure(error))
      throw error
    }
  }
}
