/** Native Kagi search adapter for the aggregate `ctx.web` capability seam. */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { KagiError, KagiResult, KagiSearchResponse } from './types.ts'

/** Stable id registered in `ctx.web`. */
export const KAGI_PROVIDER_ID = 'kagi'
/** Public Kagi API base; `/search` is appended. */
export const KAGI_DEFAULT_BASE_URL = 'https://kagi.com/api/v1'

/** Options resolved once at the start of one Kagi search. */
export interface KagiSearchProviderOptions {
  apiKey?: string
  resolveApiKey?: () => Promise<string | undefined>
  apiKeyEnv?: CredentialRef
  baseURL: string
}

/**
 * Map a direct Kagi result object to the portable source shape.
 * @param result - one Kagi result.
 * @returns the normalized source, or undefined for a blank URL.
 */
export function mapKagiResult(result: KagiResult): WebSearchSource | undefined {
  if (result.url.length === 0) return undefined
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    ...result.snippet != null && result.snippet.length > 0 ? { snippet: result.snippet } : {},
    ...result.published != null && result.published.length > 0 ? { publishedAt: result.published } : {},
  }
}

/**
 * Map direct-array and documented Kagi wrapper response variants.
 * @param response - the Kagi search response.
 * @returns the normalized search result.
 */
export function mapKagiResponse(response: KagiSearchResponse): WebSearchResult {
  const sources = extractKagiResults(response)
    .map(mapKagiResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  return { sources, truncated: false }
}

/* jscpd:ignore-start -- provider-local HTTP and credential policy is deliberately explicit. */
/** Kagi-backed search provider. Credential-bearing redirects are rejected. */
export class KagiSearchProvider implements WebSearchProvider {
  readonly id = KAGI_PROVIDER_ID

  constructor(private readonly resolveOptions: () => KagiSearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
      && URL.canParse(options.baseURL)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    const apiKey = await this.apiKey(options, signal)
    throwIfAborted(signal)
    const endpoint = new URL(`${trimTrailingSlashes(options.baseURL)}/search`)
    endpoint.searchParams.set('q', request.query)

    let response: Response
    try {
      response = await fetch(endpoint.toString(), {
        method: 'GET',
        redirect: 'error',
        headers: {
          authorization: `Bot ${apiKey}`,
          accept: 'application/json',
        },
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      throw new WebError(`Kagi search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) throw new WebError(await apiErrorMessage(response, signal), 'WEB_PROVIDER_ERROR')
    try {
      const payload = await response.json() as KagiSearchResponse
      throwIfAborted(signal)
      return mapKagiResponse(payload)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      throw new WebError(`Kagi returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  private async apiKey(options: KagiSearchProviderOptions, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal)
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved: string | undefined
    try {
      resolved = await abortable(Promise.resolve(options.resolveApiKey?.()), signal)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      throw new WebError(`Kagi search credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (resolved !== undefined && resolved.length > 0) return resolved
    const ref = options.apiKeyEnv ?? 'KAGI_API_KEY'
    throw new WebError(
      `Kagi search has no API key for "${ref}"; store it through the credentials service`
        + ' (the web Models page writes it), export it in the launching environment, or set a literal'
        + ' "apiKey" in the web-search-kagi config',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

function extractKagiResults(value: unknown): KagiResult[] {
  if (Array.isArray(value)) return value.map(toKagiResult).filter((result): result is KagiResult => result !== undefined)
  if (!isRecord(value)) return []
  const direct = toKagiResult(value)
  if (direct !== undefined) return [direct]
  for (const key of ['data', 'results', 'items']) {
    const nested = value[key]
    if (Array.isArray(nested)) return nested.map(toKagiResult).filter((result): result is KagiResult => result !== undefined)
    if (isRecord(nested)) {
      const results = extractKagiResults(nested)
      if (results.length > 0) return results
    }
  }
  return []
}

function toKagiResult(value: unknown): KagiResult | undefined {
  if (!isRecord(value) || typeof value.url !== 'string') return undefined
  return {
    url: value.url,
    ...typeof value.title === 'string' ? { title: value.title } : {},
    ...typeof value.snippet === 'string' ? { snippet: value.snippet } : {},
    ...typeof value.published === 'string' ? { published: value.published } : {},
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function apiErrorMessage(response: Response, signal?: AbortSignal): Promise<string> {
  let message = `Kagi API error (HTTP ${response.status})`
  try {
    const parsed = await response.json() as KagiError
    throwIfAborted(signal)
    const detail = parsed.error ?? parsed.message ?? parsed.detail
    if (typeof detail === 'string' && detail.length > 0) message = detail
  } catch (error: unknown) {
    if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
  }
  return message
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, '')
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(aborted(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(aborted(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
      },
    )
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw aborted(signal)
}

function aborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('Kagi search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
/* jscpd:ignore-end */
