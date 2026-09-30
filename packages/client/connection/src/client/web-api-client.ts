/** Browser API carrier: HTTP upstream plus one WebSocket per downstream event stream. */

import type { ApiProxy, HostFrame, MuxFrame, RpcRequest, RpcResponse, RpcReceipt, ClientResponse, ServerRequest } from './api.ts'
import type { RequestPayload, ResponseValue, RpcMethodMap } from '@deepseek-ai/dsh-host-apiproxy/api'
import { AbstractApiClient } from './api.ts'
import type { AuthenticationPrincipalIdentity } from '@deepseek-ai/dsh-authentication'
import { CONNECTION_AUTHENTICATED_METHOD } from '@deepseek-ai/dsh-host-apiproxy/api'
import { authenticationPrincipalIdentitySchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import { HOST_EVENTS_PATH, MUX_EVENTS_PATH } from '../api-path.ts'
import type { ClientAuthentication } from '@deepseek-ai/dsh-client-authentication'
import type { TargetGeneration, TransportPathResolver } from './target.ts'

type IApiEvents = import('./api.ts').IApiClient['events']

type SocketItem<F> = { kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end' }

/**
 * Ring-backed delivery queue for one WebSocket reader: amortized O(1) push and
 * take with immediate slot clearing, where an array's shift would cost O(n)
 * per frame under bursty event streams. Host twin: api-proxy's FrameQueue ring.
 * Exported for the spec that owns its ordering and growth contract.
 */
export class SocketRing<F> {
  private slots: (SocketItem<F> | undefined)[] = []
  private head = 0
  private count = 0

  /** Frames currently queued. */
  get length(): number {
    return this.count
  }

  /** Enqueue one frame at the tail, growing the ring only when capacity is exhausted.
   * @param item - frame or end marker to queue.
   */
  push(item: SocketItem<F>): void {
    if (this.count === this.slots.length) {
      if (this.head === 0) {
        this.slots.push(item)
        this.count += 1
        return
      }
      const grown = new Array<SocketItem<F> | undefined>(Math.max(this.slots.length * 2, 4))
      for (let index = 0; index < this.count; index += 1) {
        grown[index] = this.slots[(this.head + index) % this.slots.length]
      }
      grown[this.count] = item
      this.slots = grown
      this.head = 0
      this.count += 1
      return
    }
    this.slots[(this.head + this.count) % this.slots.length] = item
    this.count += 1
  }

  /** Dequeue the oldest frame, releasing every slot when the ring drains to empty.
   * @returns the oldest queued frame, or undefined when the ring is empty.
   */
  take(): SocketItem<F> | undefined {
    if (this.count === 0) return undefined
    const item = this.slots[this.head] as SocketItem<F>
    this.slots[this.head] = undefined
    this.head = (this.head + 1) % this.slots.length
    this.count -= 1
    if (this.count === 0) {
      this.head = 0
      this.slots.length = 0
    }
    return item
  }
}
type Parser<F> = { parse(value: unknown): F }

/** Browser platform subclass: unary/respond use fetch; mux/host use downlink-only WebSockets. */
export class WebApiClient extends AbstractApiClient {
  private readonly observers = new Set<(batch: readonly import('./api.ts').RpcMessage[]) => void>()
  private stopObservingTarget: (() => void) | undefined

  /** Rebind diagnostics when the stable API face changes its carrier. */
  observeTarget(): void {
    this.stopObservingTarget?.()
    this.stopObservingTarget = this.delegate?.().subscribeEnvelopes((batch) => {
      for (const listener of this.observers) {
        try { listener(batch) } catch (error) { console.error('[client-connection] envelope observer failed:', error) }
      }
    })
  }

  override subscribeEnvelopes(listener: (batch: readonly import('./api.ts').RpcMessage[]) => void): () => void {
    if (this.delegate === undefined) return super.subscribeEnvelopes(listener)
    this.observers.add(listener)
    if (this.stopObservingTarget === undefined) this.observeTarget()
    return () => { this.observers.delete(listener) }
  }

  constructor(
    timeoutMs?: number,
    initiatingPrincipal?: () => AuthenticationPrincipalIdentity | undefined,
    authenticationMismatch?: () => void,
    private readonly authentication?: ClientAuthentication,
    private readonly resolvePath: TransportPathResolver = path => path,
    private readonly generation?: () => TargetGeneration,
    private readonly delegate?: (method?: string) => WebApiClient,
  ) { super(timeoutMs, initiatingPrincipal, authenticationMismatch) }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const routed = new URL(this.resolvePath(`${input.pathname}${input.search}`), input.origin)
    if (init?.signal?.aborted) return Promise.reject(init.signal.reason instanceof Error ? init.signal.reason : new Error('connection request aborted'))
    const generation = this.generation?.()
    const send = () => this.authentication?.fetch(routed, init) ?? globalThis.fetch(routed, init)
    if (generation === undefined) return send()
    return generation.run(send)
  }

  protected override callUnary<K extends keyof RpcMethodMap>(
    method: K, payload: RequestPayload<K>, signal?: AbortSignal,
    timeoutPolicy: 'default' | 'caller-signal-only' = 'default',
  ): Promise<RpcResponse<ResponseValue<K>>> {
    if (this.delegate !== undefined) return this.delegate(method).callUnary(method, payload, signal, timeoutPolicy)
    const generation = this.generation?.()
    return generation === undefined ? super.callUnary(method, payload, signal, timeoutPolicy)
      : generation.run(() => super.callUnary(method, payload, generation.signal(signal), timeoutPolicy))
  }

  override respond(message: ClientResponse, signal?: AbortSignal): Promise<RpcReceipt> {
    if (this.delegate !== undefined) return this.delegate().respond(message, signal)
    const generation = this.generation?.()
    return generation === undefined ? super.respond(message, signal)
      : generation.run(() => super.respond(message, generation.signal(signal)))
  }

  protected override openMux(
    payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
    onAuthenticated?: (identity: AuthenticationPrincipalIdentity) => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    if (this.delegate !== undefined) return this.delegate().openMux(payload, signal, onOpen, onAuthenticated)
    const since = payload.since
    const path = since === undefined || Object.keys(since).length === 0
      ? MUX_EVENTS_PATH
      : `${MUX_EVENTS_PATH}?${new URLSearchParams({ since: JSON.stringify(since) }).toString()}`
    const generation = this.generation?.()
    return this.readWebSocket(path, generation?.signal(signal) ?? signal, muxFrameSchema, onOpen, onAuthenticated, generation)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
    onAuthenticated?: (identity: AuthenticationPrincipalIdentity) => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    if (this.delegate !== undefined) return this.delegate().openHost(_payload, signal, onOpen, onAuthenticated)
    const generation = this.generation?.()
    return this.readWebSocket(HOST_EVENTS_PATH, generation?.signal(signal) ?? signal, hostFrameSchema, onOpen, onAuthenticated, generation)
  }

  protected override openTerminal(...args: Parameters<IApiEvents['terminal']>): ReturnType<IApiEvents['terminal']> {
    if (this.delegate !== undefined) return this.delegate().openTerminal(...args)
    const signal = this.generation?.().signal(args[1]) ?? args[1]
    return this.fenceStream(super.openTerminal(args[0], signal,
      () => { if (!signal.aborted) args[2]?.() },
      (identity) => { if (!signal.aborted) args[3]?.(identity) }), signal)
  }

  protected override openHold(...args: Parameters<IApiEvents['hold']>): ReturnType<IApiEvents['hold']> {
    if (this.delegate !== undefined) return this.delegate().openHold(...args)
    const signal = this.generation?.().signal(args[1]) ?? args[1]
    return this.fenceStream(super.openHold(args[0], signal,
      () => { if (!signal.aborted) args[2]?.() },
      (identity) => { if (!signal.aborted) args[3]?.(identity) }), signal)
  }

  protected override openBrowser(...args: Parameters<IApiEvents['browser']>): ReturnType<IApiEvents['browser']> {
    if (this.delegate !== undefined) return this.delegate().openBrowser(...args)
    const signal = this.generation?.().signal(args[1]) ?? args[1]
    return this.fenceStream(super.openBrowser(args[0], signal,
      () => { if (!signal.aborted) args[2]?.() },
      (identity) => { if (!signal.aborted) args[3]?.(identity) }), signal)
  }

  private async *fenceStream<T>(stream: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
    for await (const value of stream) {
      if (signal.aborted) return
      yield value
    }
  }

  private async *readWebSocket<F extends MuxFrame | HostFrame>(
    path: string,
    signal: AbortSignal,
    frameSchema: Parser<F>,
    onOpen?: () => void,
    onAuthenticated?: (identity: AuthenticationPrincipalIdentity) => void,
    generation?: TargetGeneration,
  ): AsyncGenerator<RpcRequest<F>> {
    const aborted = (): boolean => signal.aborted
    await this.authentication?.ready(signal)
    if (aborted()) return
    const url = new URL((generation?.resolvePath ?? this.resolvePath)(path), this.resolveBase())
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    const inbox = new SocketRing<F>()
    let wake: (() => void) | undefined
    const enqueue = (item: SocketItem<F>): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    const handleOpen = (): void => { onOpen?.() }
    const handleMessage = (event: MessageEvent): void => {
      if (aborted()) return
      let full: ServerRequest
      let frame: F
      try {
        if (typeof event.data !== 'string') throw new Error('binary WebSocket frame')
        full = serverRequestSchema.parse(JSON.parse(event.data))
        if (full.method === CONNECTION_AUTHENTICATED_METHOD) {
          onAuthenticated?.(authenticationPrincipalIdentitySchema.parse(full.payload))
          return
        }
        frame = frameSchema.parse(full.payload)
      } catch (error) {
        console.error(`[client-connection] dropping malformed WebSocket frame on ${path}:`, error)
        return
      }
      this.onEnvelope(full)
      enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } })
    }
    const handleClose = (): void => { enqueue({ kind: 'end' }) }
    const handleAbort = (): void => {
      enqueue({ kind: 'end' })
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
    }
    socket.addEventListener('open', handleOpen)
    socket.addEventListener('message', handleMessage)
    socket.addEventListener('close', handleClose, { once: true })
    signal.addEventListener('abort', handleAbort, { once: true })
    if (aborted()) handleAbort()
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.take() as SocketItem<F>
          if (item.kind === 'end') {
            if (!aborted()) await this.authentication?.check(signal)
            return
          }
          if (aborted()) return
          yield item.envelope
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', handleAbort)
      socket.removeEventListener('open', handleOpen)
      socket.removeEventListener('message', handleMessage)
      socket.removeEventListener('close', handleClose)
      handleAbort()
    }
  }
}
