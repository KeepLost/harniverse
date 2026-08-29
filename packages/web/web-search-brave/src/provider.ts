/** Native Brave Search adapter for the aggregate `ctx.web` capability seam. */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { BraveError, BraveResult, BraveSearchResponse } from './types.ts'

/** Stable id registered in `ctx.web`. */
export const BRAVE_PROVIDER_ID = 'brave'
/** Brave Search web endpoint base; `/search` is appended. */
export const BRAVE_DEFAULT_BASE_URL = 'https://api.search.brave.com/res/v1/web'

/** Options resolved once at the start of one Brave search. */
export interface BraveSearchProviderOptions {
  apiKey?: string
  resolveApiKey?: () => Promise<string | undefined>
  apiKeyEnv?: CredentialRef
  baseURL: string
  maxResults?: number
}

/**
 * Map one Brave web result, retaining its primary and extra snippets.
 * @param result - one Brave web result.
 * @returns the normalized source, or undefined for a blank URL.
 */
export function mapBraveResult(result: BraveResult): WebSearchSource | undefined {
  if (result.url.length === 0) return undefined
  const snippets = [result.description, ...(result.extra_snippets ?? [])]
    .filter((value): value is string => value != null && value.trim().length > 0)
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    ...snippets.length === 0 ? {} : { snippet: snippets.join('\n\n') },
  }
}

/**
 * Map Brave's nested `web.results[]` response without inventing an answer.
 * @param response - the Brave search response.
 * @returns the normalized search result.
 */
export function mapBraveResponse(response: BraveSearchResponse): WebSearchResult {
  const sources = (response.web?.results ?? [])
    .map(mapBraveResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  return { sources, truncated: false }
}

/* jscpd:ignore-start -- each provider intentionally owns its credential, abort, and HTTP policy. */
/** Brave-backed search provider. Credential-bearing redirects are rejected. */
export class BraveSearchProvider implements WebSearchProvider {
  readonly id = BRAVE_PROVIDER_ID

  constructor(private readonly resolveOptions: () => BraveSearchProviderOptions) {}

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
    const endpoint = new URL(`${trimTrailingSlashes(options.baseURL)}/search`)
    endpoint.searchParams.set('q', request.query)
    const maxResults = request.maxResults ?? options.maxResults
    if (maxResults !== undefined) endpoint.searchParams.set('count', String(maxResults))

    let response: Response
    try {
      response = await fetch(endpoint.toString(), {
        method: 'GET',
        redirect: 'error',
        headers: {
          'x-subscription-token': apiKey,
          accept: 'application/json',
        },
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      throw new WebError(`Brave search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      throw new WebError(await apiErrorMessage(response, signal), 'WEB_PROVIDER_ERROR')
    }
    try {
      const payload = await response.json() as BraveSearchResponse
      throwIfAborted(signal)
      return mapBraveResponse(payload)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      throw new WebError(`Brave returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  private async apiKey(options: BraveSearchProviderOptions, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal)
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved: string | undefined
    try {
      resolved = await abortable(Promise.resolve(options.resolveApiKey?.()), signal)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      throw new WebError(`Brave search credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (resolved !== undefined && resolved.length > 0) return resolved
    const ref = options.apiKeyEnv ?? 'BRAVE_API_KEY'
    throw new WebError(
      `Brave search has no API key for "${ref}"; store it through the credentials service`
        + ' (the web Models page writes it), export it in the launching environment, or set a literal'
        + ' "apiKey" in the web-search-brave config',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

async function apiErrorMessage(response: Response, signal?: AbortSignal): Promise<string> {
  let message = `Brave API error (HTTP ${response.status})`
  try {
    const parsed = await response.json() as BraveError
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
  return new WebError('Brave search aborted', 'WEB_ABORTED', {
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
