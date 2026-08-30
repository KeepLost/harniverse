/** Native Firecrawl v2 search and scrape adapters for the aggregate `ctx.web` seam. */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  FirecrawlMetadata,
  FirecrawlScrapeResponse,
  FirecrawlSearchResponse,
  FirecrawlSearchResult,
} from './types.ts'

/** Stable id shared by Firecrawl's search and fetch capabilities. */
export const FIRECRAWL_PROVIDER_ID = 'firecrawl'
/** Public Firecrawl API base; v2 operation paths are appended. */
export const FIRECRAWL_DEFAULT_BASE_URL = 'https://api.firecrawl.dev'
/** Default bound for optional per-result search content. */
export const FIRECRAWL_DEFAULT_SEARCH_CONTENT_MAX_CHARS = 10_000
/** Default bound for fetched markdown. */
export const FIRECRAWL_DEFAULT_MAX_CHARS = 100_000

/** Options shared by the Firecrawl search and scrape adapters. */
export interface FirecrawlProviderOptions {
  apiKey?: string
  resolveApiKey?: () => Promise<string | undefined>
  apiKeyEnv?: CredentialRef
  baseURL: string
  includeSearchContent: boolean
  searchContentMaxChars: number
  maxChars: number
}

/** Search-specific alias for consumers that construct the adapter directly. */
export type FirecrawlSearchProviderOptions = FirecrawlProviderOptions
/** Fetch-specific alias for consumers that construct the adapter directly. */
export type FirecrawlFetchProviderOptions = FirecrawlProviderOptions

/**
 * Map one Firecrawl search result to a portable source.
 * @param result - one Firecrawl search result.
 * @param includeSearchContent - whether to include bounded processed content.
 * @param searchContentMaxChars - maximum processed content characters.
 * @returns the normalized source, or undefined when no URL is present.
 */
export function mapFirecrawlSearchResult(
  result: FirecrawlSearchResult,
  includeSearchContent = false,
  searchContentMaxChars = FIRECRAWL_DEFAULT_SEARCH_CONTENT_MAX_CHARS,
): WebSearchSource | undefined {
  const url = firstNonBlank(result.url, result.metadata?.sourceURL)
  if (url === undefined) return undefined
  const title = firstNonBlank(result.title, result.metadata?.title)
  const description = firstNonBlank(result.description)
  const content = includeSearchContent
    ? bounded(firstNonBlank(result.markdown, result.content), searchContentMaxChars)
    : undefined
  const snippet = description === undefined
    ? content
    : content === undefined
      ? description
      : `${description}\n\n${content}`
  return {
    url,
    ...title === undefined ? {} : { title },
    ...snippet === undefined ? {} : { snippet },
  }
}

/**
 * Map Firecrawl Search's `results[]`, `data[]`, or `data.web[]` response without an AI answer.
 * @param response - the Firecrawl search response.
 * @param includeSearchContent - whether to include bounded processed content.
 * @param searchContentMaxChars - maximum processed content characters.
 * @returns the normalized search result.
 */
export function mapFirecrawlSearchResponse(
  response: FirecrawlSearchResponse,
  includeSearchContent = false,
  searchContentMaxChars = FIRECRAWL_DEFAULT_SEARCH_CONTENT_MAX_CHARS,
): WebSearchResult {
  const sources = extractSearchResults(response)
    .map(result => mapFirecrawlSearchResult(result, includeSearchContent, searchContentMaxChars))
    .filter((source): source is WebSearchSource => source !== undefined)
  return { sources, truncated: false }
}

/**
 * Map Firecrawl Scrape's markdown response. `undefined` means that no target
 * body was present; an empty string is a valid target body and is preserved.
 * @param response - the Firecrawl scrape response.
 * @param requestedUrl - URL submitted to Firecrawl.
 * @param maxChars - maximum returned body characters.
 * @param fallbackStatusCode - API status used when target status is absent.
 * @returns the normalized fetch result, or undefined when no body is present.
 */
export function mapFirecrawlScrapeResponse(
  response: FirecrawlScrapeResponse,
  requestedUrl: string,
  maxChars: number,
  fallbackStatusCode = 200,
): WebFetchResult | undefined {
  const data = isRecord(response.data) ? response.data : undefined
  const metadata = data !== undefined && isRecord(data.metadata)
    ? data.metadata as FirecrawlMetadata
    : isRecord(response.metadata) ? response.metadata : undefined
  const content = firstString(
    data?.markdown,
    data?.content,
    response.markdown,
    response.content,
  )
  if (content === undefined) return undefined
  const url = firstNonBlank(metadata?.url, data?.url, response.url, metadata?.sourceURL, requestedUrl) ?? requestedUrl
  const statusCode = typeof metadata?.statusCode === 'number' && Number.isFinite(metadata.statusCode)
    ? metadata.statusCode
    : fallbackStatusCode
  const truncated = content.length > maxChars
  return {
    url,
    statusCode,
    body: { kind: 'text', content: truncated ? content.slice(0, maxChars) : content },
    truncated,
  }
}

/* jscpd:ignore-start -- search and fetch deliberately share one explicit provider policy. */
/** Firecrawl Search adapter. */
export class FirecrawlSearchProvider implements WebSearchProvider {
  readonly id = FIRECRAWL_PROVIDER_ID

  constructor(private readonly resolveOptions: () => FirecrawlSearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return URL.canParse(options.baseURL)
      && isPositiveInteger(options.searchContentMaxChars)
      && isPositiveInteger(options.maxChars)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    const apiKey = await resolveApiKey(options, 'search', signal)
    throwIfAborted('search', signal)
    const maxResults = request.maxResults
    const body = {
      query: request.query,
      ...maxResults === undefined ? {} : { limit: maxResults },
      ...options.includeSearchContent ? { scrapeOptions: { formats: ['markdown'] as const } } : {},
    }
    let response: Response
    try {
      response = await globalThis.fetch(`${trimTrailingSlashes(options.baseURL)}/v2/search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
        },
        body: JSON.stringify(body),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted('search', signal, error)
      throw new WebError(`Firecrawl search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    const payload = await readJson(response, 'search', signal)
    if (!response.ok) throw apiFailure('search', response.status, payload)
    return mapFirecrawlSearchResponse(payload as FirecrawlSearchResponse, options.includeSearchContent, options.searchContentMaxChars)
  }
}

/** Firecrawl Scrape adapter returning markdown through the web fetch contract. */
export class FirecrawlFetchProvider implements WebFetchProvider {
  readonly id = FIRECRAWL_PROVIDER_ID

  constructor(private readonly resolveOptions: () => FirecrawlFetchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return URL.canParse(options.baseURL)
      && isPositiveInteger(options.maxChars)
      && isPositiveInteger(options.searchContentMaxChars)
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const options = this.resolveOptions()
    const apiKey = await resolveApiKey(options, 'fetch', signal)
    throwIfAborted('fetch', signal)
    let response: Response
    try {
      response = await globalThis.fetch(`${trimTrailingSlashes(options.baseURL)}/v2/scrape`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
        },
        body: JSON.stringify({ url: request.url, formats: ['markdown'] }),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted('fetch', signal, error)
      throw new WebError(`Firecrawl fetch request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    const payload = await readJson(response, 'fetch', signal)
    const result = mapFirecrawlScrapeResponse(payload as FirecrawlScrapeResponse, request.url, options.maxChars, response.status)
    if (result !== undefined) return result
    if (!response.ok) throw apiFailure('fetch', response.status, payload)
    throw new WebError('Firecrawl scrape response contained no target body', 'WEB_PROVIDER_ERROR')
  }
}

function extractSearchResults(value: unknown): FirecrawlSearchResult[] {
  if (Array.isArray(value)) return value.filter(isRecord)
  if (!isRecord(value)) return []
  if (Array.isArray(value.results)) return value.results.filter(isRecord)
  if (Array.isArray(value.web)) return value.web.filter(isRecord)
  if (Array.isArray(value.data)) return value.data.filter(isRecord)
  return isRecord(value.data) ? extractSearchResults(value.data) : []
}

async function resolveApiKey(
  options: FirecrawlProviderOptions,
  operation: 'search' | 'fetch',
  signal?: AbortSignal,
): Promise<string | undefined> {
  throwIfAborted(operation, signal)
  if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
  let resolved: string | undefined
  try {
    resolved = await abortable(Promise.resolve(options.resolveApiKey?.()), signal, operation)
  } catch (error: unknown) {
    if (signal?.aborted === true || isAbortError(error)) throw aborted(operation, signal, error)
    throw new WebError(`Firecrawl ${operation} credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
  if (resolved !== undefined && resolved.length > 0) return resolved
  return undefined
}

async function readJson(response: Response, operation: 'search' | 'fetch', signal?: AbortSignal): Promise<unknown> {
  try {
    const payload: unknown = await response.json()
    throwIfAborted(operation, signal)
    return payload
  } catch (error: unknown) {
    if (signal?.aborted === true || isAbortError(error)) throw aborted(operation, signal, error)
    if (!response.ok) throw new WebError(`Firecrawl ${operation} API error (HTTP ${response.status})`, 'WEB_PROVIDER_ERROR', { cause: error })
    throw new WebError(`Firecrawl ${operation} returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

function apiFailure(operation: 'search' | 'fetch', status: number, payload: unknown): WebError {
  const detail = isRecord(payload)
    ? firstString(payload.error, payload.message, payload.detail)
    : undefined
  return new WebError(detail ?? `Firecrawl ${operation} API error (HTTP ${status})`, 'WEB_PROVIDER_ERROR')
}

function firstNonBlank(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return undefined
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === 'string') return value
  return undefined
}

function bounded(value: string | undefined, maxChars: number): string | undefined {
  return value === undefined || value.length <= maxChars ? value : value.slice(0, maxChars)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, '')
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined, operationName: 'search' | 'fetch'): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(aborted(operationName, signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(aborted(operationName, signal)) }
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

function throwIfAborted(operation: 'search' | 'fetch', signal?: AbortSignal): void {
  if (signal?.aborted === true) throw aborted(operation, signal)
}

function aborted(operation: 'search' | 'fetch', signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError(`Firecrawl ${operation} aborted`, 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
/* jscpd:ignore-end */
