/**
 * Safe HTTP(S) retrieval for `ctx.web`: validates URLs, resolves and pins public addresses,
 * rejects redirects, enforces time and size limits, classifies and decodes text, and leaves
 * presentation to `@deepseek-ai/dsh-tool-web`. Requests carry no browser cookies or ambient
 * credentials and use direct Node transports without proxy configuration.
 * @module @deepseek-ai/dsh-web-fetch-http/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchBody, WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions as HttpRequestOptions } from 'node:http'
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from 'node:https'
import { Readable } from 'node:stream'
import { classifyContentType, decoderForCharset, isPublicIp, parseCharset, validateFetchUrl } from './policy.ts'

/** Resolved provider limits (the plugin's schemastery Config supplies defaults). */
export interface HttpFetchLimits {
  /** Maximum accepted request URL length. */
  maxUrlLength: number
  /** Maximum response body size in bytes (read is aborted past this). */
  maxResponseBytes: number
  /** Maximum decoded body length in characters (truncated past this). */
  maxBodyChars: number
  /** Default fetch timeout in milliseconds. */
  timeoutMs: number
  /** Must be zero; redirects are a fixed-deny policy. */
  maxRedirects: number
  /** `User-Agent` header sent on every request. */
  userAgent: string
}

/** Stable id this provider registers under. */
export const LOCAL_FETCH_PROVIDER_ID = 'http'

interface ResolvedAddress {
  readonly address: string
  readonly family: 4 | 6
}

interface FetchTransportOptions {
  readonly signal: AbortSignal
  readonly userAgent: string
}

type HostnameResolver = (hostname: string, signal: AbortSignal) => Promise<readonly ResolvedAddress[]>
type FetchTransport = (url: URL, address: ResolvedAddress, options: FetchTransportOptions) => Promise<Response>

/** Internal test seam; production construction uses the built-in resolver and direct transport. */
interface HttpFetchSeams {
  readonly resolveHostname?: HostnameResolver
  readonly request?: FetchTransport
}

/** The anonymous public HTTP(S) fetch provider. */
export class HttpFetchProvider implements WebFetchProvider {
  readonly id = LOCAL_FETCH_PROVIDER_ID

  private readonly resolveHostname: HostnameResolver
  private readonly requestTransport: FetchTransport

  constructor(private readonly limits: HttpFetchLimits, seams: HttpFetchSeams = {}) {
    if (limits.maxRedirects !== 0) {
      throw new Error('web-fetch-http: maxRedirects must be 0 because redirects are disabled')
    }
    this.resolveHostname = seams.resolveHostname ?? resolveHostname
    this.requestTransport = seams.request ?? requestDirect
  }

  /** No credentials to check — an anonymous public fetcher is always usable. */
  available(): boolean {
    return true
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')

    // One signal stops both the request and body read. The deadline's TimeoutReason later
    // distinguishes this provider's timeout from caller or outer-deadline cancellation.
    using d = deadline(signal, this.limits.timeoutMs, 'WEB_FETCH_TIMEOUT')
    return await this.requestAndRead(request.url, d.signal)
  }

  /** Resolve the public destination, make one request, and read its final response. */
  private async requestAndRead(initialUrl: string, signal: AbortSignal): Promise<WebFetchResult> {
    const url = validateFetchUrl(initialUrl, this.limits.maxUrlLength)
    const response = await this.requestOnce(url, signal)
    if (isRedirectStatus(response.status)) {
      await response.body?.cancel()
      throw new WebError('redirect responses are disabled; retry the URL directly', 'WEB_REDIRECT_BLOCKED')
    }
    return await this.readBody(response, url, signal)
  }

  private async requestOnce(url: URL, signal: AbortSignal): Promise<Response> {
    const address = await this.resolvePublicAddress(url, signal)
    try {
      return await this.requestTransport(url, address, { signal, userAgent: this.limits.userAgent })
    } catch (error: unknown) {
      throw translateAbortOrNetwork(error, signal)
    }
  }

  private async resolvePublicAddress(url: URL, signal: AbortSignal): Promise<ResolvedAddress> {
    const hostname = stripIpv6Brackets(url.hostname)
    const family = isIP(hostname)
    if (family !== 0) {
      const address = { address: hostname, family: family as 4 | 6 }
      assertPublicAddress(hostname, address)
      return address
    }

    let addresses: readonly ResolvedAddress[]
    try {
      addresses = await waitForSignal(this.resolveHostname(hostname, signal), signal)
    } catch (error: unknown) {
      throw translateAbortOrNetwork(error, signal)
    }
    if (addresses.length === 0) {
      throw new WebError(`DNS lookup for "${hostname}" returned no addresses`, 'WEB_PROVIDER_ERROR')
    }
    for (const address of addresses) assertPublicAddress(hostname, address)
    const [address] = addresses
    /* v8 ignore next -- the length check above makes this unreachable; retained for strict narrowing. */
    if (address === undefined) throw new WebError(`DNS lookup for "${hostname}" returned no addresses`, 'WEB_PROVIDER_ERROR')
    return address
  }

  /** Read, byte-cap, classify, and decode the final response body. */
  private async readBody(response: Response, finalUrl: URL, signal: AbortSignal): Promise<WebFetchResult> {
    const contentType = response.headers.get('content-type')
    const kind = classifyContentType(contentType)
    if (kind === undefined) {
      await response.body?.cancel()
      throw new WebError(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }

    // Resolve the decoder BEFORE reading the body so an unsupported charset
    // fails without consuming the stream — but cancel the body on that failure
    // so the socket does not leak (matching the unsupported-content-type path).
    let decoder: TextDecoder
    try {
      decoder = decoderForCharset(parseCharset(contentType))
    } catch (error: unknown) {
      await response.body?.cancel()
      throw error
    }
    const { bytes, truncatedByBytes } = await this.readCapped(response, signal)
    const decoded = decoder.decode(bytes)
    const truncatedByChars = decoded.length > this.limits.maxBodyChars
    const content = truncatedByChars ? decoded.slice(0, this.limits.maxBodyChars) : decoded
    const body: WebFetchBody = kind === 'html' ? { kind: 'html', content } : { kind: 'text', content }

    return {
      url: finalUrl.toString(),
      statusCode: response.status,
      body,
      truncated: truncatedByBytes || truncatedByChars,
    }
  }

  /**
   * Read the response stream up to `maxResponseBytes`. A `Content-Length` over
   * the cap rejects immediately with `WEB_FETCH_TOO_LARGE`; a stream that grows
   * past the cap is cut short (`truncatedByBytes`) rather than rejected, so a
   * server that under-reports still yields a bounded usable body.
   */
  private async readCapped(response: Response, signal: AbortSignal): Promise<{ bytes: Uint8Array; truncatedByBytes: boolean }> {
    const declared = response.headers.get('content-length')
    if (declared !== null) {
      const length = Number(declared)
      if (Number.isFinite(length) && length > this.limits.maxResponseBytes) {
        await response.body?.cancel()
        throw new WebError(`response exceeds the maximum of ${this.limits.maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE')
      }
    }

    /* v8 ignore next -- an HTTP Response normally exposes a body stream; the null guard is defensive. */
    if (response.body === null) return { bytes: new Uint8Array(0), truncatedByBytes: false }

    const chunks: Uint8Array[] = []
    let total = 0
    let truncatedByBytes = false
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const remaining = this.limits.maxResponseBytes - total
        // Only DROPPED bytes count as truncation: a chunk that exactly fills the
        // remaining capacity keeps all its bytes and we read on to observe EOF,
        // so an exactly-at-cap body is not falsely flagged truncated.
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining))
          total += remaining
          truncatedByBytes = true
          break
        }
        chunks.push(value)
        total += value.byteLength
      }
    } catch (error: unknown) {
      /* v8 ignore next -- mid-stream read fault needs a network drop after headers; translate path covered by request-phase tests. */
      throw translateAbortOrNetwork(error, signal)
    } finally {
      /* v8 ignore next 4 -- cancel() after a completed/broken read settles without rejecting; unobserved best-effort cleanup. */
      await reader.cancel().catch(() => {
        // Cancel after a successful read (or after we broke past the cap) is
        // best-effort cleanup; the bytes we need are already collected.
      })
    }

    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, truncatedByBytes }
  }
}

/** Reject every redirection response; `304 Not Modified` is not a redirect. */
function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400 && status !== 304
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function assertPublicAddress(hostname: string, address: ResolvedAddress): void {
  if (isIP(address.address) !== address.family || !isPublicIp(address.address)) {
    throw new WebError(`URL hostname "${hostname}" resolves to a non-public address`, 'WEB_BLOCKED_URL')
  }
}

/** Resolve a hostname to all addresses so the complete answer set can be checked. */
async function resolveHostname(hostname: string): Promise<readonly ResolvedAddress[]> {
  const addresses = await lookup(hostname, { all: true, order: 'verbatim' })
  return addresses.map(({ address, family }) => ({ address, family: family === 4 ? 4 : 6 }))
}

async function waitForSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw toError(signal.reason ?? new Error('web fetch aborted'))
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      reject(toError(signal.reason ?? new Error('web fetch aborted')))
    }
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(toError(error))
      },
    )
  })
}

/** Send one direct request to an already validated address without DNS or proxy resolution. */
function requestDirect(url: URL, address: ResolvedAddress, options: FetchTransportOptions): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const onResponse = (response: IncomingMessage): void => {
      try {
        resolve(toFetchResponse(response))
      } catch (error: unknown) {
        response.destroy()
        reject(toError(error))
      }
    }
    const requestOptions: HttpRequestOptions = {
      protocol: url.protocol,
      hostname: address.address,
      family: address.family,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      agent: false,
      headers: {
        host: url.host,
        'user-agent': options.userAgent,
        accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
      },
      signal: options.signal,
    }
    let request: ClientRequest
    try {
      if (url.protocol === 'https:') {
        request = httpsRequest({
          ...requestOptions,
          servername: isIP(stripIpv6Brackets(url.hostname)) === 0 ? stripIpv6Brackets(url.hostname) : undefined,
        } as HttpsRequestOptions, onResponse)
      } else {
        request = httpRequest(requestOptions, onResponse)
      }
    } catch (error: unknown) {
      reject(toError(error))
      return
    }
    request.once('error', reject)
    request.end()
  })
}

function toFetchResponse(response: IncomingMessage): Response {
  const status = response.statusCode
  if (status === undefined) throw new Error('HTTP response did not include a status code')
  const headers = new Headers()
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }
  const body = status === 204 || status === 205 || status === 304
    ? null
    : Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>
  if (body === null) response.resume()
  return new Response(body, { status, headers })
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Translate a thrown request/stream error into a `WebError`, classified by the
 * deadline signal rather than the thrown value (which differs by phase: the
 * request phase rejects with the abort reason, while the read phase
 * reader surfaces a bare `AbortError`). `timeoutOf(signal, 'WEB_FETCH_TIMEOUT')`
 * recovering OUR reason means our timeout fired (`WEB_FETCH_TIMEOUT`); any other
 * abort — an upstream cancel, or a foreign/outer deadline's timeout under
 * nesting — is `WEB_ABORTED`; a throw with the signal NOT aborted is a
 * transport/network failure (`WEB_PROVIDER_ERROR`).
 */
function translateAbortOrNetwork(error: unknown, signal: AbortSignal): WebError {
  const timeout = timeoutOf(signal, 'WEB_FETCH_TIMEOUT')
  if (timeout !== undefined) return new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: timeout })
  if (signal.aborted) return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
  return new WebError(`web fetch failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}
