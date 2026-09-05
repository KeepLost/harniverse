/** Browser API carrier: HTTP upstream plus one WebSocket per downstream event stream. */

import type { ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest } from './api.ts'
import { AbstractApiClient } from './api.ts'
import type { AuthenticationPrincipalIdentity } from '@deepseek-ai/dsh-authentication'
import { CONNECTION_AUTHENTICATED_METHOD } from '@deepseek-ai/dsh-host-apiproxy/api'
import { authenticationPrincipalIdentitySchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import { HOST_EVENTS_PATH, MUX_EVENTS_PATH } from '../api-path.ts'

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
  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return globalThis.fetch(input, init)
  }

  protected override openMux(
    payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
    onAuthenticated?: (identity: AuthenticationPrincipalIdentity) => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    const since = payload.since
    const path = since === undefined || Object.keys(since).length === 0
      ? MUX_EVENTS_PATH
      : `${MUX_EVENTS_PATH}?${new URLSearchParams({ since: JSON.stringify(since) }).toString()}`
    return this.readWebSocket(path, signal, muxFrameSchema, onOpen, onAuthenticated)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
    onAuthenticated?: (identity: AuthenticationPrincipalIdentity) => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readWebSocket(HOST_EVENTS_PATH, signal, hostFrameSchema, onOpen, onAuthenticated)
  }

  private async *readWebSocket<F extends MuxFrame | HostFrame>(
    path: string,
    signal: AbortSignal,
    frameSchema: Parser<F>,
    onOpen?: () => void,
    onAuthenticated?: (identity: AuthenticationPrincipalIdentity) => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const url = new URL(path, this.resolveBase())
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
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
    }
    socket.addEventListener('open', handleOpen)
    socket.addEventListener('message', handleMessage)
    socket.addEventListener('close', handleClose, { once: true })
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.take() as SocketItem<F>
          if (item.kind === 'end') return
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
