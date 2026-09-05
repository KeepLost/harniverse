/**
 * Native transport for an installed proxy policy: a hand-rolled dispatcher speaking the contract
 * Node's global `fetch` resolves through its global-dispatcher symbol, plus the one proxy-hop
 * builder (`requestViaProxy`) every native consumer reuses.
 *
 * Node bundles no importable `undici`, so this module IS the tunnel: `http:` targets are sent to
 * the proxy in absolute form, `https:` targets are tunnelled through `CONNECT` and then spoken
 * over TLS with the origin's server name. No connection is pooled — each hop opens its own socket
 * and closes it when the response ends (see the README's Known Limitations).
 * @module @deepseek-ai/dsh-http-proxy/dispatcher
 */

import { once } from 'node:events'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { proxyForUrl, type ProxyPolicy } from './policy.ts'

/**
 * The symbol Node's global `fetch` reads its dispatcher through, once per call. Setting it installs
 * a dispatcher for every plain `fetch()` in the process; deleting it restores Node's internal
 * default, which never passes through this symbol.
 */
export const GLOBAL_DISPATCHER_SYMBOL = Symbol.for('undici.globalDispatcher.1')

/**
 * The part of undici's dispatch options the native transport consumes. Global `fetch` supplies
 * exactly these fields; `headers` is the flat `[name, value, …]` array undici passes down.
 */
export interface DispatchOptions {
  /** Request target as `pathname + search`; the origin it resolves against. */
  readonly path: string
  /** The request origin, as a string or URL. */
  readonly origin: string | URL
  /** HTTP method. */
  readonly method: string
  /** Flat `[name, value, …]` request headers. */
  readonly headers: readonly (string | Buffer)[]
  /** Request body chunks, or `undefined`/`null` when the request carries none. */
  readonly body?: AsyncIterable<Uint8Array> | null
  /** Abort signal the caller (global `fetch`) ties to this one request. */
  readonly signal?: AbortSignal | undefined
  /** Present on an upgrade request, which no proxy route in this package serves. */
  readonly upgrade?: unknown
}

/** The callbacks a dispatcher drives, in undici's documented order. */
export interface DispatchHandlers {
  /** Called first with the callback whose invocation (`abort(reason)`) must stop the request. */
  onConnect(abort: (reason?: unknown) => void): void
  /**
   * Called when final response headers arrived. Return `false` to pause the body; the `resume`
   * callback hands the flow back.
   */
  onHeaders(status: number, rawHeaders: (Buffer | string)[], resume: () => void, statusText: string): boolean
  /** Called per body chunk; return `false` to pause until the resume callback. */
  onData(chunk: Buffer): boolean
  /** Called when the response completed. */
  onComplete(): void
  /** Called once on any failure; no other callback may follow it. */
  onError(error: Error): void
}

/** A dispatcher global `fetch` can drive: the interface undici's own agents present here. */
export interface Dispatcher {
  dispatch(options: DispatchOptions, handlers: DispatchHandlers): boolean
  close(): Promise<void>
  destroy(): void
}

/** One outbound hop's handles: the final response plus the thing that can stop the whole hop. */
export interface ProxyHop {
  /** The final response, after any CONNECT tunnel. */
  readonly response: IncomingMessage
  /** Destroys the request and every socket the hop opened. */
  readonly request: { destroy(error?: Error): void }
}

/** What the shared hop builders need from a caller. */
export interface ProxyRequestOptions {
  /** HTTP method. */
  readonly method: string
  /** Flat `[name, value, …]` request headers (the `host` header is added when absent). */
  readonly headers: readonly (string | Buffer)[]
  /** Request body chunks, or `undefined`/`null` when the request carries none. */
  readonly body?: AsyncIterable<Uint8Array> | null
  /** Aborts the hop at any phase. */
  readonly signal?: AbortSignal
}

/**
 * Send one request to `url` through the proxy at `proxyUrl`.
 *
 * This is the one tunnel implementation: the installed dispatcher, `dsh-web-fetch-http`, and any
 * later native consumer route through it so no two transports can disagree about how a proxied
 * request is spoken.
 *
 * @param proxyUrl - the validated `http(s):` proxy URL the policy resolved.
 * @param url - the request target; `http:` is sent in absolute form, `https:` through CONNECT.
 * @param options - method, headers, body, and abort signal.
 * @returns the final response and the handle that aborts the whole hop.
 */
export function requestViaProxy(proxyUrl: string, url: URL, options: ProxyRequestOptions): Promise<ProxyHop> {
  const proxy = new URL(proxyUrl)
  if (url.protocol === 'http:') {
    return new Promise<ProxyHop>((resolve, reject) => {
      const request = proxyTransportRequest(proxy, {
        method: options.method,
        // Absolute form: the proxy is the next hop, so the full URL is the request target.
        path: url.href,
        headers: { ...foldHeaders(options.headers), host: url.host, ...proxyAuthorization(proxy) },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      request.once('error', reject)
      request.once('response', (response) => { resolve({ request, response }) })
      pipeBody(request, options.body)
    })
  }
  return new Promise<ProxyHop>((resolve, reject) => {
    let settled = false
    let inner: ClientRequest | undefined
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      inner?.destroy()
      reject(toError(error))
    }
    const authority = `${stripBrackets(url.hostname)}:${effectivePort(url)}`
    const connect = proxyTransportRequest(proxy, {
      method: 'CONNECT',
      path: authority,
      headers: { host: authority, ...proxyAuthorization(proxy) },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    connect.once('error', fail)
    connect.once('connect', (_response: IncomingMessage, socket: Socket) => {
      // A refused CONNECT surfaces through the request's own error path, so this handler only
      // sees established tunnels.
      const tlsSocket = tlsConnect({ socket, servername: sniOf(url) })
      tlsSocket.once('error', fail)
      // The inner request is spoken as plain HTTP over the already-established TLS socket. No
      // `agent` may be set: an explicit `agent: false` makes Node allocate its own connection and
      // ignore the tunnelled socket entirely.
      inner = httpRequest({
        createConnection: () => tlsSocket,
        hostname: stripBrackets(url.hostname),
        port: effectivePort(url),
        path: `${url.pathname}${url.search}`,
        method: options.method,
        headers: { ...foldHeaders(options.headers), host: url.host },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      inner.once('error', fail)
      inner.once('response', (response) => {
        settled = true
        resolve({
          response,
          request: {
            destroy(error?: Error): void {
              inner?.destroy(error)
              connect.destroy(error)
            },
          },
        })
      })
      pipeBody(inner, options.body)
    })
    // CONNECT carries no body; ending it is what flushes the request line to the proxy.
    connect.end()
  })
}

/**
 * Send one request directly to `url` on a per-request socket, for a process whose global dispatcher
 * this package owns but whose policy leaves the URL direct and no displaced dispatcher can serve.
 *
 * @param url - the request target.
 * @param options - method, headers, body, and abort signal.
 * @returns the response and the handle that aborts the hop.
 */
export function requestDirect(url: URL, options: ProxyRequestOptions): Promise<ProxyHop> {
  return new Promise<ProxyHop>((resolve, reject) => {
    const base = {
      protocol: url.protocol,
      hostname: stripBrackets(url.hostname),
      port: url.port === '' ? undefined : url.port,
      path: `${url.pathname}${url.search}`,
      method: options.method,
      agent: false,
      headers: { ...foldHeaders(options.headers), host: url.host },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }
    const request = url.protocol === 'https:'
      ? httpsRequest({ ...base, servername: sniOf(url) })
      : httpRequest(base)
    request.once('error', reject)
    request.once('response', (response) => { resolve({ request, response }) })
    pipeBody(request, options.body)
  })
}

/**
 * The dispatcher an installed policy routes through. Each request is classified by the same
 * {@link proxyForUrl} every caller consults: a proxied URL takes the native tunnel, a direct URL
 * goes to the dispatcher this one displaced — or, when there was none, to {@link requestDirect} —
 * so a URL never changes route between the answer and the hop.
 */
export class ProxyDispatcher implements Dispatcher {
  /** The dispatcher direct URLs are handed to, for the install that layered this one on top. */
  readonly delegate: Dispatcher | undefined
  readonly #policy: ProxyPolicy
  readonly #pending = new Set<Promise<void>>()
  readonly #aborts = new Set<AbortController>()

  /**
   * @param policy - the policy to route by; it must proxy at least one scheme.
   * @param delegate - the dispatcher to hand direct URLs to, when one was installed.
   */
  constructor(policy: ProxyPolicy, delegate: Dispatcher | undefined) {
    this.#policy = policy
    this.delegate = delegate
  }

  dispatch(options: DispatchOptions, handlers: DispatchHandlers): boolean {
    let url: URL
    try {
      url = new URL(options.path, options.origin)
    } catch (error: unknown) {
      queueMicrotask(() => { handlers.onError(toError(error)) })
      return false
    }
    if (options.upgrade !== undefined) {
      // WebSocket-style upgrades never arrive from `fetch`; refusing beats silently bypassing the
      // policy a URL was classified under.
      queueMicrotask(() => { handlers.onError(new Error('upgrade requests are not supported through the proxy dispatcher')) })
      return false
    }
    const proxy = proxyForUrl(this.#policy, url)
    const delegate = this.delegate
    if (proxy === undefined && delegate !== undefined) return delegate.dispatch(options, handlers)
    const build = (requestOptions: ProxyRequestOptions): Promise<ProxyHop> =>
      proxy === undefined ? requestDirect(url, requestOptions) : requestViaProxy(proxy, url, requestOptions)
    void this.#serve(build, options, handlers)
    return false
  }

  /** Resolve when every dispatched request has settled; nothing new is accepted after a dispose. */
  async close(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending])
  }

  /** Abort every in-flight hop immediately. */
  destroy(): void {
    for (const abort of this.#aborts) abort.abort()
  }

  /** Drive one hop's callbacks, keeping the pending set current for close() and destroy(). */
  async #serve(
    build: (requestOptions: ProxyRequestOptions) => Promise<ProxyHop>,
    options: DispatchOptions,
    handlers: DispatchHandlers,
  ): Promise<void> {
    const pending = (async () => {
      const abort = new AbortController()
      let hop: ProxyHop | undefined
      const onAbort = (reason?: unknown): void => {
        const error = reason instanceof Error ? reason : new Error(reason === undefined ? 'aborted' : JSON.stringify(reason))
        hop?.request.destroy(error)
        if (!abort.signal.aborted) abort.abort(error)
      }
      this.#aborts.add(abort)
      try {
        try {
          handlers.onConnect(onAbort)
        } catch (error: unknown) {
          handlers.onError(toError(error))
          return
        }
        // One signal covers every phase: CONNECT, TLS, and the final request all die together.
        const signal = options.signal === undefined
          ? abort.signal
          : AbortSignal.any([options.signal, abort.signal])
        try {
          hop = await build({
            method: options.method,
            headers: options.headers,
            ...(options.body === undefined ? {} : { body: options.body }),
            signal,
          })
        } catch (error: unknown) {
          handlers.onError(toError(error))
          return
        }
        bridgeResponse(hop.request, hop.response, handlers)
      } finally {
        this.#aborts.delete(abort)
      }
    })()
    this.#pending.add(pending)
    try {
      await pending
    } finally {
      this.#pending.delete(pending)
    }
  }
}

/** Connect the response events to the dispatcher callbacks, honoring backpressure both ways. */
function bridgeResponse(request: { destroy(error?: Error): void }, response: IncomingMessage, handlers: DispatchHandlers): void {
  const rawHeaders: (Buffer | string)[] = [...response.rawHeaders]
  const resume = (): void => { response.resume() }
  let accepted: boolean | void
  try {
    accepted = handlers.onHeaders(response.statusCode ?? 0, rawHeaders, resume, response.statusMessage ?? '')
  } catch (error: unknown) {
    request.destroy()
    handlers.onError(toError(error))
    return
  }
  response.on('data', (chunk: Buffer) => {
    if (!handlers.onData(chunk)) response.pause()
  })
  response.on('end', () => { handlers.onComplete() })
  response.on('error', (error: Error) => { handlers.onError(error) })
  if (!accepted) response.pause()
}

/** Send one request to the proxy itself, over plain HTTP or TLS as the proxy URL's scheme says. */
function proxyTransportRequest(
  proxy: URL,
  options: { method: string; path: string; headers: Record<string, string>; signal?: AbortSignal },
): ClientRequest {
  const requestOptions = {
    protocol: proxy.protocol,
    hostname: stripBrackets(proxy.hostname),
    port: proxy.port === '' ? undefined : effectivePort(proxy),
    path: options.path,
    method: options.method,
    agent: false,
    headers: options.headers,
    signal: options.signal,
  }
  return proxy.protocol === 'https:' ? httpsRequest(requestOptions) : httpRequest(requestOptions)
}

/**
 * Write the request body with real backpressure: a full socket buffer pauses the body iterable
 * until the request drains, and a request that dies mid-body stops the write loop.
 */
function pipeBody(request: ClientRequest, body: AsyncIterable<Uint8Array> | null | undefined): void {
  if (body === null || body === undefined) {
    request.end()
    return
  }
  const stopped = new AbortController()
  request.once('close', () => { stopped.abort() })
  void (async () => {
    try {
      for await (const chunk of body) {
        if (request.write(chunk)) continue
        await once(request, 'drain', { signal: stopped.signal })
      }
      request.end()
    } catch {
      // The request closed mid-body (abort, reset, or normal close racing the last drain wait);
      // destroying it releases the socket even if the close already had.
      request.destroy()
    }
  })()
}

/** The `Proxy-Authorization` header a proxy URL's userinfo carries, if any. */
function proxyAuthorization(proxy: URL): Record<string, string> {
  if (proxy.username === '' && proxy.password === '') return {}
  const credentials = Buffer.from(
    `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
  ).toString('base64')
  return { 'proxy-authorization': `Basic ${credentials}` }
}

/** Fold undici's flat header array into the object Node's request options take. */
function foldHeaders(flat: readonly (string | Buffer)[]): Record<string, string> {
  const headers: Record<string, string> = {}
  for (let index = 0; index + 1 < flat.length; index += 2) {
    const name = String(flat[index])
    const value = String(flat[index + 1])
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`
  }
  return headers
}

/** A URL's port, or the protocol default when it carries none. */
function effectivePort(url: URL): string {
  return url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80'
}

/** The TLS server name for a URL: the hostname only when it is not an address literal. */
function sniOf(url: URL): string | undefined {
  const hostname = stripBrackets(url.hostname)
  return isIP(hostname) === 0 ? hostname : undefined
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
