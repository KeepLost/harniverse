/**
 * Programmable Connection-carrier mock for web-client unit tests: a real
 * `AbstractApiClient` wire surface whose unary dispatch is keyed by the
 * `RpcMethodMap`, hand-pumped SSE downlinks, a bypass authentication double,
 * and a mount helper that boots the real connection plugin over them.
 * @module @deepseek-ai/dsh-remote-mock
 */

import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { AuthenticationPrincipalIdentity } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {
  EventsApi,
  HostFrame,
  MuxFrame,
  RequestPayload,
  ResponseValue,
  RpcMethodMap,
  RpcRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ClientAuthentication } from '@deepseek-ai/dsh-client-authentication'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { apply as applyConnection } from '@deepseek-ai/dsh-client-connection/client'

/** Default wire identity carried by every mocked settlement. */
const BYPASS_IDENTITY: AuthenticationPrincipalIdentity = { kind: 'bypass' }

/** Handler-thrown business error; maps onto the `internal` RpcResult error branch. */
export class RemoteMockRpcError extends Error {
  readonly details: Record<string, never>

  constructor(message: string) {
    super(message)
    this.name = 'RemoteMockRpcError'
    this.details = {}
  }
}

/** Context handed to one programmed unary handler. */
export interface RemoteMockCallContext {
  /** Caller cancellation, when provided. */
  readonly signal: AbortSignal | undefined
  /** Wire rpcId of the request. */
  readonly rpcId: string
  /** Wire requestId of the request. */
  readonly requestId: string
}

/** One programmable downlink (mux or host stream) with hand-pumped frames. */
export interface MockDownlink {
  /** Emit one frame to the stream consumer. */
  push(frame: MuxFrame | HostFrame): void
  /** Emit the carrier-authenticated identity to the stream consumer. */
  authenticated(identity?: AuthenticationPrincipalIdentity): void
  /** End the server side; the reader loop ends. */
  close(): void
}

/** `since` resumption cursor each opened mux downlink received. */
export interface DownlinkOpenRecord {
  /** `events.mux` or `events.host`. */
  readonly stream: 'events.mux' | 'events.host'
  /** The `since` query value parsed when present. */
  readonly since: Record<string, unknown> | undefined
}

type PumpItem = { kind: 'frame'; frame: MuxFrame | HostFrame } | { kind: 'authenticated'; identity: AuthenticationPrincipalIdentity } | { kind: 'end' }

/** Hand-pumped downlink queue shared by the mock and its test controller. */
class DownlinkQueue implements MockDownlink {
  readonly #items: PumpItem[] = []
  #wake: (() => void) | undefined

  push(frame: MuxFrame | HostFrame): void {
    this.#items.push({ kind: 'frame', frame })
    this.#wake?.()
    this.#wake = undefined
  }

  authenticated(identity?: AuthenticationPrincipalIdentity): void {
    this.#items.push({ kind: 'authenticated', identity: identity ?? BYPASS_IDENTITY })
    this.#wake?.()
    this.#wake = undefined
  }

  close(): void {
    this.#items.push({ kind: 'end' })
    this.#wake?.()
    this.#wake = undefined
  }

  /** Drain items as an async generator feeding `readSse`-shaped callbacks. */
  async *consume(
    onOpen: (() => void) | undefined,
    onAuthenticated: ((identity: AuthenticationPrincipalIdentity) => void) | undefined,
  ): AsyncGenerator<MuxFrame | HostFrame> {
    await Promise.resolve()
    onOpen?.()
    while (true) {
      const item = this.#items.shift()
      if (item === undefined) {
        await new Promise<void>((resolve) => { this.#wake = resolve })
        continue
      }
      if (item.kind === 'end') return
      if (item.kind === 'authenticated') {
        onAuthenticated?.(item.identity)
        continue
      }
      yield item.frame
    }
  }
}

/**
 * Wire-true mock carrier: unary dispatch over the same JSON envelope and
 * schema validation as the real transport, plus pumpable downlinks.
 */
export class RemoteMockApiClient extends AbstractApiClient {
  /** Chronological unary call record: `[method, payload]`. */
  readonly calls: { method: string; payload: unknown }[] = []
  /** Every downlink open, in order, with its resumption cursor. */
  readonly downlinks: DownlinkOpenRecord[] = []
  #handlers = new Map<string, (payload: unknown, context: RemoteMockCallContext) => unknown>()
  #identity: AuthenticationPrincipalIdentity = BYPASS_IDENTITY
  #mux: DownlinkQueue[] = []
  #host: DownlinkQueue[] = []

  constructor() {
    super(undefined, () => this.#identity)
  }

  /**
   * Program one unary method's response value (or a `RemoteMockRpcError` throw).
   * @param method - RpcMethodMap method key.
   * @param handler - value producer receiving the parsed payload.
   */
  on<K extends keyof RpcMethodMap>(
    method: K,
    handler: (payload: RequestPayload<K>, context: RemoteMockCallContext) => Promise<ResponseValue<K>> | ResponseValue<K>,
  ): void {
    this.#handlers.set(method, handler)
  }

  /** Override the wire identity settled on every response. */
  authenticateAs(identity: AuthenticationPrincipalIdentity): void {
    this.#identity = identity
  }

  protected override async doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const method = input.pathname.replace(/^\/api\//, '')
    const requestBody = typeof init?.body === 'string' ? init.body : ''
    const envelope = JSON.parse(requestBody) as {
      rpcId: string
      requestId: string
      payload: unknown
    }
    this.calls.push({ method, payload: envelope.payload })
    const handler = this.#handlers.get(method)
    if (handler === undefined) {
      return new Response(`remote-mock: no handler programmed for ${method}`, { status: 500 })
    }
    let body: string
    try {
      const value = await handler(envelope.payload, {
        signal: init?.signal instanceof AbortSignal ? init.signal : undefined,
        rpcId: envelope.rpcId,
        requestId: envelope.requestId,
      })
      body = JSON.stringify({
        type: 'server-response',
        rpcId: envelope.rpcId,
        requestId: envelope.requestId,
        authentication: this.#identity,
        result: { ok: true, value },
      })
    } catch (error) {
      if (error instanceof RemoteMockRpcError) {
        body = JSON.stringify({
          type: 'server-response',
          rpcId: envelope.rpcId,
          requestId: envelope.requestId,
          authentication: this.#identity,
          result: { ok: false, error: { code: 'internal', message: error.message, details: error.details } },
        })
      } else {
        throw error
      }
    }
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  }

  protected override openMux(
    payload: Parameters<EventsApi['mux']>[0]['payload'],
    _signal: AbortSignal,
    onOpen?: () => void,
    onAuthenticated?: (identity: AuthenticationPrincipalIdentity) => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    this.downlinks.push({ stream: 'events.mux', since: payload.since })
    const queue = new DownlinkQueue()
    this.#mux.push(queue)
    return pumpAsRpcRequests(queue.consume(onOpen, onAuthenticated))
  }

  protected override openHost(
    _payload: Parameters<EventsApi['host']>[0]['payload'],
    _signal: AbortSignal,
    onOpen?: () => void,
    onAuthenticated?: (identity: AuthenticationPrincipalIdentity) => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    this.downlinks.push({ stream: 'events.host', since: undefined })
    const queue = new DownlinkQueue()
    this.#host.push(queue)
    return pumpAsRpcRequests(queue.consume(onOpen, onAuthenticated))
  }

  /** Latest opened mux downlink (the connection loop opens exactly one). */
  get muxDownlink(): MockDownlink | undefined {
    return this.#mux.at(-1)
  }

  /** Latest opened host downlink. */
  get hostDownlink(): MockDownlink | undefined {
    return this.#host.at(-1)
  }
}

/** Re-key hand-pumped frames as RpcRequest envelopes (fresh rpcIds). */
async function *pumpAsRpcRequests<F extends MuxFrame | HostFrame>(
  source: AsyncGenerator<MuxFrame | HostFrame>,
): AsyncGenerator<RpcRequest<F>> {
  let next = 0
  for await (const frame of source) {
    yield { rpcId: RpcId(`remote-mock-${String(next++)}`), payload: frame as F }
  }
}

/** Bypass-mode client authentication double: ready, never renewing, no network. */
export function createBypassClientAuthentication(): ClientAuthentication {
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => ({ mode: 'bypass', phase: 'ready', expiresAt: null, reason: null }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    ready: () => Promise.resolve(),
    check: () => Promise.resolve(),
    requireRefresh: () => {},
    fetch: () => Promise.resolve(new Response('remote-mock: no web transport in mock boots', { status: 501 })),
    stop: () => Promise.resolve(),
  }
}

/** Everything a test needs after mounting the real connection plugin. */
export interface RemoteConnectionHarness {
  /** Programmable carrier the real plugin runs over. */
  readonly mock: RemoteMockApiClient
  /** Bypass authentication double provided to the plugin. */
  readonly authentication: ClientAuthentication
  /** The real `ctx.connection` handle after the plugin applied. */
  connection(): ConnectionHandle
}

/**
 * Boot the real client connection plugin over a programmable mock carrier:
 * provides `clientAuthentication` (bypass double) and the `connectionCarrier`
 * override, then applies `@deepseek-ai/dsh-client-connection/client` unchanged.
 * @param ctx - test cordis context.
 * @returns the harness holding the mock, the double, and the mounted handle.
 */
export async function mountRemoteConnection(ctx: Context): Promise<RemoteConnectionHarness> {
  const mock = new RemoteMockApiClient()
  const authentication = createBypassClientAuthentication()
  await ctx.plugin({
    name: 'remote-mock-carrier',
    apply(c) {
      c.provide('clientAuthentication', authentication)
      c.provide('connectionCarrier', { api: mock })
    },
  })
  await ctx.plugin({ name: 'client-connection', inject: ['clientAuthentication'], apply: applyConnection })
  const connection = () => ctx.get('connection') as ConnectionHandle
  return { mock, authentication, connection }
}
