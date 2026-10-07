/**
 * Resumable event mux. One instance owns a WebSocket to `/api/events.mux`,
 * replays from per-session cursors after every disconnect, replaces the
 * socket before the Access Token lifetime ends, and delivers consumed frames
 * in order with duplicate suppression.
 * @module @deepseek-ai/dsh-chat-harniverse-client/mux
 */

import { Buffer } from 'node:buffer'
import { internals } from './internals.ts'
import type { CallOptions, HostDescription, MuxOptions, MuxSocket, MuxState } from './types.ts'
import { parseMuxMessage, type WirePrincipal } from './wire.ts'

/** Server close code for an expired or revoked Access Token. */
export const TOKEN_EXPIRED_CLOSE_CODE = 4001

/** Most pending-prompt rpc ids remembered for duplicate suppression. */
const MAX_SEEN_RPC_IDS = 2_048

/** Timing knobs the mux reads from the client configuration. */
export interface MuxTiming {
  muxRenewAfterMs: number
  reconnectMinMs: number
  reconnectMaxMs: number
}

/** The slice of the client a mux depends on. */
export interface MuxHost {
  readonly config: MuxTiming
  /** A current `Authorization` header value; rejects with `authentication-failed`. */
  authorization(): Promise<string>
  /** Build the WebSocket URL with resume cursors and the optional remote host. */
  muxUrl(cursors: Readonly<Record<string, number>>, remoteHost: string | undefined): URL
  /** Record the identity announced by the stream's first frame. */
  learnIdentity(principal: WirePrincipal): void
  describeHost(options?: CallOptions): Promise<HostDescription>
  warn(message: string, error?: unknown): void
}

/**
 * Decode one WebSocket message payload to text.
 * @param data - `ws` raw data: string, Buffer, ArrayBuffer, or Buffer chunks.
 * @returns the UTF-8 text.
 */
function messageText(data: unknown): string {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return (data as Buffer).toString('utf8')
}

/** One resumable `events.mux` stream, optionally bound to a remote runtime. */
export class HarniverseMux {
  private readonly cursors = new Map<string, number>()
  private readonly seenRpcIds = new Set<string>()
  private readonly remoteHost: string | undefined
  private current: MuxSocket | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private failures = 0
  private closed = false
  private connecting = false
  private everOpened = false
  private bootId: string | undefined
  private delivery: Promise<void> = Promise.resolve()
  private readonly opened: Promise<void>
  private resolveOpened!: () => void
  private rejectOpened!: (error: Error) => void

  constructor(private readonly host: MuxHost, private readonly options: MuxOptions) {
    this.remoteHost = options.remoteHost
    for (const [sessionId, seq] of Object.entries(options.cursors ?? {})) this.cursors.set(sessionId, seq)
    this.opened = new Promise<void>((resolve, reject) => {
      this.resolveOpened = resolve
      this.rejectOpened = reject
    })
    // The rejection is observable through whenOpen(); an unobserved one must not crash the process.
    this.opened.catch(() => undefined)
  }

  /** Current resume cursors (last applied `seq` per session). */
  get resumeCursors(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.cursors)
  }

  /**
   * Resolve when the stream first opens.
   * @returns a promise rejecting when the mux is closed before it ever opened.
   */
  whenOpen(): Promise<void> {
    return this.opened
  }

  /** Begin connecting; repeated calls while running are ignored. */
  start(): void {
    if (this.closed || this.current !== undefined || this.timer !== undefined || this.connecting) return
    this.state('connecting')
    void this.connect()
  }

  /** Stop reconnecting, close the socket, and end the stream for good. */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.current?.close(1000)
    this.current = undefined
    this.rejectOpened(new Error('chat-harniverse-client: mux closed before it opened'))
    this.state('closed')
  }

  private state(state: MuxState): void {
    this.options.onState?.(state)
  }

  private async connect(): Promise<void> {
    this.connecting = true
    let socket: MuxSocket
    try {
      const authorization = await this.host.authorization()
      socket = internals.createSocket(this.host.muxUrl(this.resumeCursors, this.remoteHost), { authorization })
    } catch (error) {
      this.connecting = false
      this.host.warn('mux connection failed', error)
      this.retryLater()
      return
    }
    this.connecting = false
    this.attach(socket)
  }

  private attach(socket: MuxSocket): void {
    let opened = false
    socket.on('open', () => {
      opened = true
      this.failures = 0
      const previous = this.current
      if (this.closed) {
        socket.close(1000)
        return
      }
      this.current = socket
      previous?.close(1000)
      this.everOpened = true
      this.resolveOpened()
      this.state('open')
      this.scheduleRenewal()
      void this.checkBoot()
    })
    socket.on('message', (data) => { this.receive(data) })
    socket.on('error', (error) => { this.host.warn('mux socket error', error) })
    socket.on('close', (code) => {
      if (this.current === socket) {
        this.current = undefined
        this.retryLater(code === TOKEN_EXPIRED_CLOSE_CODE)
        return
      }
      if (!opened && !this.closed && this.current === undefined) this.retryLater()
    })
  }

  /** Schedule the next connection attempt; a token-expiry close reconnects at once. */
  private retryLater(immediate = false): void {
    if (this.closed) return
    const { reconnectMinMs, reconnectMaxMs } = this.host.config
    const delay = immediate ? 0 : Math.min(reconnectMaxMs, reconnectMinMs * 2 ** this.failures)
    if (!immediate) this.failures += 1
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.connect()
    }, delay)
    if (this.everOpened) this.state('reconnecting')
  }

  /** Replace the live socket before its Access Token can expire; the old one keeps streaming until the new one opens. */
  private scheduleRenewal(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.connect()
    }, this.host.config.muxRenewAfterMs)
  }

  private async checkBoot(): Promise<void> {
    try {
      const { bootId } = await this.host.describeHost(this.remoteHost === undefined ? {} : { remoteHost: this.remoteHost })
      const previous = this.bootId
      this.bootId = bootId
      if (previous !== undefined && previous !== bootId) this.options.onHostRestart?.(previous, bootId)
    } catch (error) {
      this.host.warn('mux host check failed', error)
    }
  }

  private receive(data: unknown): void {
    let parsed: ReturnType<typeof parseMuxMessage>
    try {
      parsed = parseMuxMessage(messageText(data))
    } catch (error) {
      this.host.warn('dropping a malformed mux frame', error)
      return
    }
    if (parsed.kind === 'ignored') return
    if (parsed.kind === 'identity') {
      if (this.remoteHost === undefined) this.host.learnIdentity(parsed.principal)
      return
    }
    const { rpcId, frame } = parsed
    if (frame.type === 'approval/requested' || frame.type === 'question/requested') {
      if (this.seenRpcIds.has(rpcId)) return
      this.seenRpcIds.add(rpcId)
      if (this.seenRpcIds.size > MAX_SEEN_RPC_IDS) {
        for (const oldest of this.seenRpcIds) {
          this.seenRpcIds.delete(oldest)
          break
        }
      }
    }
    if (frame.type === 'session/event') {
      const cursor = this.cursors.get(frame.sessionId)
      if (cursor !== undefined && frame.event.seq <= cursor) return
      this.cursors.set(frame.sessionId, frame.event.seq)
      this.options.onCursor?.(frame.sessionId, frame.event.seq)
    }
    const delivery = { rpcId, frame, ...this.remoteHost === undefined ? {} : { remoteHost: this.remoteHost } }
    this.delivery = this.delivery.then(() => this.options.onFrame(delivery)).catch((error: unknown) => {
      this.host.warn(`frame handler failed for ${frame.type}`, error)
    })
  }
}
