/**
 * OpenAI-compatible cloud speech provider. Registers the
 * `'openai-compatible'` recognizer into `ctx.speech`; transcription POSTs a
 * multipart `/audio/transcriptions` request to the first healthy endpoint in
 * the configured ordered chain, falling through on transport failures and
 * retriable HTTP statuses.
 * @module @deepseek-ai/dsh-speech-openai
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  SpeechPreparation, SpeechRecognizer, SpeechTranscribeInput, SpeechTranscribeResult,
} from '@deepseek-ai/dsh-speech'
import type { FetchLike } from './types.ts'

export type { FetchLike } from './types.ts'

/** Ordered endpoint chain; the official API leads, deployment overlays append compatible gateways. */
export const DEFAULT_ENDPOINTS: readonly string[] = ['https://api.openai.com/v1']

/** Cloud transcription deployment configuration. */
export interface Config {
  /** Ordered base URLs tried for every request; each must serve `/audio/transcriptions`. */
  readonly endpoints: string[]
  /** Transcription model id sent with every request. */
  readonly model: string
  /** Per-endpoint request timeout. */
  readonly timeoutMs: number
}

/** Validate deployment-varying cloud choices at plugin activation. */
export const Config: z<Partial<Config>, Config> = z.object({
  endpoints: z.array(z.string().pattern(/^https?:\/\/[^/\s?#@]+/)).min(1).default([...DEFAULT_ENDPOINTS]),
  model: z.string().min(1).default('whisper-1'),
  timeoutMs: z.natural().min(1).default(120_000),
})

/** Resolved user preferences this provider reads. */
export interface OpenAiPreferences {
  /** Cloud API key; absent fails the request with setup guidance. */
  readonly apiKey?: string
  /** Default language hint when the request carries none. */
  readonly language?: string
}

/** One cloud attempt failed in a way the next endpoint may still serve. */
class EndpointUnavailableError extends Error {
  constructor(readonly endpoint: string, readonly status: number | undefined, detail: string) {
    super(`endpoint ${endpoint} unavailable: ${detail}`)
  }
}

function isRetriable(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600)
}

/**
 * Send one transcription request, trying each endpoint in order. Transport
 * failures, timeouts, and retriable statuses fall through to the next
 * endpoint; a definitive 4xx answer from any endpoint fails immediately.
 * @param input - WAV bytes and optional language hint.
 * @param config - endpoint chain, model, and timeout.
 * @param preferences - API key and default language.
 * @param signal - caller cancellation.
 * @param fetchImpl - injectable fetch; defaults to the global fetch.
 * @returns recognized text; empty when no speech was recognized.
 */
export async function transcribeThroughChain(
  input: SpeechTranscribeInput,
  config: Config,
  preferences: OpenAiPreferences,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<SpeechTranscribeResult> {
  if (preferences.apiKey === undefined || preferences.apiKey === '') {
    throw new Error('the cloud recognizer has no API key; set one in Settings → Voice input')
  }
  const language = input.language ?? preferences.language
  let lastUnavailable: Error | undefined
  for (const endpoint of config.endpoints) {
    const form = new FormData()
    form.append('file', new Blob([input.wav.slice()], { type: 'audio/wav' }), 'recording.wav')
    form.append('model', config.model)
    if (language !== undefined && language !== '') form.append('language', language)
    const timeout = new AbortController()
    const timer = setTimeout(() => { timeout.abort() }, config.timeoutMs)
    const combined = signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal])
    try {
      const response = await fetchImpl(`${endpoint}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${preferences.apiKey}` },
        body: form,
        signal: combined,
      })
      if (response.ok) {
        const payload = await response.json() as { text?: unknown }
        return { text: typeof payload.text === 'string' ? payload.text.trim() : '' }
      }
      await response.body?.cancel()
      if (isRetriable(response.status)) {
        lastUnavailable = new EndpointUnavailableError(endpoint, response.status, `HTTP ${String(response.status)}`)
        continue
      }
      // A definitive 4xx answer carries provider semantics (bad key, bad
      // request) the remaining gateways would repeat; fail the chain with it.
      throw new Error(`the cloud recognizer rejected the request: ${endpoint} answered HTTP ${String(response.status)}`)
    } catch (error) {
      /* v8 ignore next 3 -- minted only in this loop and thrown at exhaustion; nothing rethrows it into this catch. */
      if (error instanceof EndpointUnavailableError) {
        lastUnavailable = error
        continue
      }
      if (signal?.aborted === true) throw error
      if (error instanceof TypeError) {
        // fetch rejects transport failures (DNS, TLS, refused) as TypeError.
        lastUnavailable = new EndpointUnavailableError(endpoint, undefined, error.message)
        continue
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastUnavailable ?? new Error('every configured endpoint failed')
}

/**
 * Build the cloud recognizer.
 * @param config - validated deployment configuration.
 * @param preferences - resolved-preferences reader.
 * @param fetchImpl - injectable fetch for suites.
 * @returns the recognizer registered as `'openai-compatible'`.
 */
export function createOpenAiRecognizer(
  config: Config,
  preferences: () => OpenAiPreferences,
  fetchImpl: FetchLike = fetch,
): SpeechRecognizer {
  return {
    id: 'openai-compatible',
    label: 'OpenAI-compatible cloud',
    location: 'cloud',
    inspect: (): Promise<SpeechPreparation> => Promise.resolve({
      status: preferences().apiKey === undefined || preferences().apiKey === '' ? 'unprepared' : 'ready',
    }),
    transcribe: (input: SpeechTranscribeInput, signal?: AbortSignal) =>
      transcribeThroughChain(input, config, preferences(), signal, fetchImpl),
  }
}

/** Cordis plugin name. */
export const name = 'speech-openai'
/** The recognizer registry this provider registers into. */
export const inject = ['speech']

/**
 * Register the cloud recognizer.
 * @param ctx - host context carrying `ctx.speech`.
 * @param config - validated deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.speech.registerRecognizer('openai-compatible', createOpenAiRecognizer(
    config,
    () => ctx.speech.currentPreferences(),
  ))
}
