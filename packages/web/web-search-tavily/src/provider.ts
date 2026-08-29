/** Native Tavily search adapter for the aggregate `ctx.web` capability seam. */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { TavilyError, TavilyResult, TavilySearchResponse } from './types.ts'

/** Stable id registered in `ctx.web`. */
export const TAVILY_PROVIDER_ID = 'tavily'
/** Public Tavily API base URL. */
export const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com'

/** Options resolved once at the start of one Tavily search. */
export interface TavilySearchProviderOptions {
  /** Literal key, when configured. */
  apiKey?: string
  /** Per-operation credential lookup. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Reference shown in missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Endpoint base; `/search` is appended. */
  baseURL: string
  /** Whether `include_raw_content: true` is sent. */
  includeRawContent: boolean
  /** Default Tavily `max_results`, if any. */
  maxResults?: number
}

/**
 * Map one Tavily result to the portable web source shape.
 * @param result - one Tavily API result.
 * @returns the normalized source, or undefined for a blank URL.
 */
export function mapTavilyResult(result: TavilyResult): WebSearchSource | undefined {
  if (result.url.length === 0) return undefined
  const snippet = firstNonBlank(result.content, result.raw_content)
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    ...snippet === undefined ? {} : { snippet },
    ...result.published_date != null && result.published_date.length > 0
      ? { publishedAt: result.published_date }
      : {},
  }
}

/**
 * Map Tavily's flat result envelope; Tavily does not return an AI answer.
 * @param response - the Tavily search response.
 * @returns the normalized search result.
 */
export function mapTavilyResponse(response: TavilySearchResponse): WebSearchResult {
  const sources = (response.results ?? [])
    .map(mapTavilyResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  return { sources, truncated: false }
}

/** Tavily-backed search provider. Credential-bearing redirects are rejected. */
export class TavilySearchProvider implements WebSearchProvider {
  readonly id = TAVILY_PROVIDER_ID

  constructor(private readonly resolveOptions: () => TavilySearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
      && URL.canParse(options.baseURL)
      && (options.maxResults === undefined || isPositiveInteger(options.maxResults))
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    const apiKey = await this.apiKey(options, signal)
    throwIfAborted(signal)
    const maxResults = request.maxResults ?? options.maxResults
    let response: Response
    try {
      response = await fetch(`${trimTrailingSlashes(options.baseURL)}/search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          query: request.query,
          include_answer: false,
          ...maxResults === undefined ? {} : { max_results: maxResults },
          ...options.includeRawContent ? { include_raw_content: true } : {},
        }),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      throw new WebError(`Tavily search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const message = await apiErrorMessage(response, signal)
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as TavilySearchResponse
      throwIfAborted(signal)
      return mapTavilyResponse(payload)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      throw new WebError(`Tavily returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  private async apiKey(options: TavilySearchProviderOptions, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal)
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved: string | undefined
    try {
      resolved = await abortable(Promise.resolve(options.resolveApiKey?.()), signal)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      throw new WebError(`Tavily search credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (resolved !== undefined && resolved.length > 0) return resolved
    const ref = options.apiKeyEnv ?? 'TAVILY_API_KEY'
    throw new WebError(
      `Tavily search has no API key for "${ref}"; store it through the credentials service`
        + ' (the web Models page writes it), export it in the launching environment, or set a literal'
        + ' "apiKey" in the web-search-tavily config',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

async function apiErrorMessage(response: Response, signal?: AbortSignal): Promise<string> {
  let message = `Tavily API error (HTTP ${response.status})`
  try {
    const parsed = await response.json() as TavilyError
    throwIfAborted(signal)
    const detail = parsed.error ?? parsed.message ?? parsed.detail
    if (typeof detail === 'string' && detail.length > 0) message = detail
  } catch (error: unknown) {
    if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
  }
  return message
}

function firstNonBlank(...values: (string | null | undefined)[]): string | undefined {
  for (const value of values) {
    if (value != null && value.trim().length > 0) return value
  }
  return undefined
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
  return new WebError('Tavily search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
