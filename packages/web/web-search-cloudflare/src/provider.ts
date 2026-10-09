/** Native Cloudflare Web Search API adapter for the aggregate `ctx.web` capability seam. */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

/** Stable id registered in `ctx.web`. */
export const CLOUDFLARE_PROVIDER_ID = 'cloudflare'
/** Public Cloudflare API base; `/accounts/{accountId}/ai/websearch/` is appended. */
export const CLOUDFLARE_DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4'
/** Every Cloudflare account has an AI Gateway with this id. */
export const CLOUDFLARE_DEFAULT_GATEWAY_ID = 'default'
/** Upstream engines behind Cloudflare's `provider` request field. */
export const CLOUDFLARE_ENGINES = ['ceramic', 'exa', 'linkup'] as const
/** One upstream engine Cloudflare can route a search to. */
export type CloudflareSearchEngine = typeof CLOUDFLARE_ENGINES[number]
/** Cloudflare's own default engine. */
export const CLOUDFLARE_DEFAULT_ENGINE: CloudflareSearchEngine = 'ceramic'
/**
 * Default bound on one result's snippet. Engines return long page descriptions
 * (Ceramic up to 8,000 characters), which would otherwise flood model context.
 */
export const CLOUDFLARE_DEFAULT_SNIPPET_MAX_CHARS = 2_000
/** Cloudflare rejects a `limit` above this value. */
export const CLOUDFLARE_MAX_RESULTS = 10

/** Account ids and BYOK aliases share this shape; it also keeps the id safe inside the URL path. */
const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/u

/** Options resolved once at the start of one Cloudflare search. */
export interface CloudflareSearchProviderOptions {
  /** Literal API token, when configured. */
  apiKey?: string
  /** Per-operation credential lookup. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Reference shown in missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Cloudflare API base. */
  baseURL: string
  /** Cloudflare account id the search is billed to. */
  accountId?: string
  /** AI Gateway the request is routed through. */
  gatewayId: string
  /** Upstream engine Cloudflare should use. */
  engine: CloudflareSearchEngine
  /** Alias of a provider key stored on the gateway (bring your own key). */
  byokAlias?: string
  /** Maximum characters kept from each result description. */
  snippetMaxChars: number
}

/**
 * Map one Cloudflare result item to the portable source shape. Cloudflare's
 * `description` becomes the snippet; `lastModifiedDate` is not a publication
 * date and is therefore not mapped to `publishedAt`.
 * @param item - one untrusted entry of the response `items` array.
 * @param snippetMaxChars - maximum snippet length.
 * @returns the normalized source, or undefined when the item carries no usable URL.
 */
export function mapCloudflareItem(item: unknown, snippetMaxChars: number): WebSearchSource | undefined {
  if (!isRecord(item)) return undefined
  const url = text(item.url)
  if (url === undefined) return undefined
  const title = text(item.title)
  const description = text(item.description)
  return {
    url,
    ...title === undefined ? {} : { title },
    ...description === undefined ? {} : { snippet: bounded(description, snippetMaxChars) },
  }
}

/**
 * Map Cloudflare's `{ items, metadata }` envelope; no engine returns an AI answer.
 * @param response - the untrusted parsed response body.
 * @param snippetMaxChars - maximum snippet length.
 * @returns the normalized search result.
 */
export function mapCloudflareResponse(response: unknown, snippetMaxChars: number): WebSearchResult {
  const items: unknown[] = isRecord(response) && Array.isArray(response.items) ? response.items : []
  const sources = items
    .map(item => mapCloudflareItem(item, snippetMaxChars))
    .filter((source): source is WebSearchSource => source !== undefined)
  return { sources, truncated: false }
}

/* jscpd:ignore-start -- provider-local HTTP and credential policy is deliberately explicit. */
/** Cloudflare-backed search provider. Credential-bearing redirects are rejected. */
export class CloudflareSearchProvider implements WebSearchProvider {
  readonly id = CLOUDFLARE_PROVIDER_ID

  constructor(private readonly resolveOptions: () => CloudflareSearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
      && URL.canParse(options.baseURL)
      && options.gatewayId.trim().length > 0
      && (options.byokAlias === undefined || IDENTIFIER.test(options.byokAlias))
      && Number.isInteger(options.snippetMaxChars) && options.snippetMaxChars > 0
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    throwIfAborted(signal)
    const accountId = (options.accountId ?? '').trim()
    if (!IDENTIFIER.test(accountId)) {
      throw new WebError(
        'Cloudflare search has no valid account id; set "accountId" in the web-search-cloudflare config'
          + ' (the web settings page writes it) to your 32-character Cloudflare account id',
        'WEB_PROVIDER_CONFIG_INVALID',
      )
    }
    const apiKey = await this.apiKey(options, signal)
    throwIfAborted(signal)
    const endpoint = `${trimTrailingSlashes(options.baseURL)}/accounts/${accountId}/ai/websearch/`

    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          query: request.query,
          provider: options.engine,
          ...request.maxResults === undefined ? {} : { limit: Math.min(request.maxResults, CLOUDFLARE_MAX_RESULTS) },
          ...options.byokAlias === undefined ? {} : { byokAlias: options.byokAlias },
          options: { gateway: { id: options.gatewayId } },
        }),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      throw new WebError(`Cloudflare search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) throw new WebError(await apiErrorMessage(response, signal), 'WEB_PROVIDER_ERROR')
    try {
      const payload: unknown = await response.json()
      throwIfAborted(signal)
      return mapCloudflareResponse(payload, options.snippetMaxChars)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      throw new WebError(`Cloudflare returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  private async apiKey(options: CloudflareSearchProviderOptions, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal)
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved: string | undefined
    try {
      resolved = await abortable(Promise.resolve(options.resolveApiKey?.()), signal)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      throw new WebError(`Cloudflare search credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (resolved !== undefined && resolved.length > 0) return resolved
    const ref = options.apiKeyEnv ?? 'CLOUDFLARE_API_TOKEN'
    throw new WebError(
      `Cloudflare search has no API token for "${ref}"; store it through the credentials service`
        + ' (the web Models page writes it), export it in the launching environment, or set a literal'
        + ' "apiKey" in the web-search-cloudflare config',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

/**
 * Cloudflare reports failures in several envelopes: `errors[]` (API gateway),
 * `error[]` (AI Gateway), a bare `message`, or `error: { code }` (gateway proxy).
 */
function errorDetail(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  const listed = [body.errors, body.error]
    .flatMap(value => Array.isArray(value) ? value as unknown[] : [])
    .map(entry => isRecord(entry) ? text(entry.message) : undefined)
    .find(message => message !== undefined)
  return listed ?? text(body.message) ?? (isRecord(body.error) ? text(body.error.code) : undefined)
}

async function apiErrorMessage(response: Response, signal?: AbortSignal): Promise<string> {
  let message = `Cloudflare API error (HTTP ${response.status})`
  try {
    const detail = errorDetail(await response.json())
    throwIfAborted(signal)
    if (detail !== undefined) message = `Cloudflare web search failed: ${detail}`
  } catch (error: unknown) {
    if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
  }
  return message
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Truncate to `max` UTF-16 units without leaving half of a surrogate pair at the cut. */
function bounded(value: string, max: number): string {
  if (value.length <= max) return value
  const lastKept = value.charCodeAt(max - 1)
  return value.slice(0, lastKept >= 0xD800 && lastKept <= 0xDBFF ? max - 1 : max)
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
  return new WebError('Cloudflare search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
/* jscpd:ignore-end */
