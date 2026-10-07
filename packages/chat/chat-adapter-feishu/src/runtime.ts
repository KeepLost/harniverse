/**
 * Feishu/Lark long connection: endpoint discovery, the `ws` socket, ping and
 * liveness, fragment reassembly, and acknowledgements. One `run` is one
 * connection session; a dropped session rejects with a classified error and
 * the bridge's run loop reconnects with its own backoff.
 *
 * Protocol per `@larksuiteoapi/node-sdk` 1.73.0 (MIT License) and the event
 * wiring of dsh-im (`src/channels/feishu/feishu-runtime.mjs`, MIT License,
 * Copyright (c) 2026 xmanrui); see THIRD_PARTY_NOTICES.md.
 * @module @deepseek-ai/dsh-chat-adapter-feishu/runtime
 */

import { ChatAdapterError } from '@deepseek-ai/dsh-chat-adapter'
import { decodeFrame, encodeFrame, type Frame } from './frame.ts'

/** Replaceable transport, for tests and proxies. */
export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>

/** The socket surface the connection drives; `ws` implements it. */
export interface SocketLike {
  on(event: 'open' | 'close', listener: () => void): unknown
  on(event: 'message', listener: (data: unknown) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  send(data: Uint8Array): void
  terminate(): void
  close(): void
}

/** Connection construction. */
export interface ConnectionOptions {
  appId: string
  /** Resolves the current app secret; rejects while the credential is unset. */
  secret(): Promise<string>
  /** Open-platform origin, e.g. `https://open.feishu.cn`. */
  domain: string
  fetch: FetchLike
  createSocket(url: string): SocketLike
  /** Receives each complete event payload (the decoded JSON). */
  onEvent(event: unknown): Promise<void>
  warn(message: string, error: unknown): void
}

const CONTROL = 0
const DATA = 1
const DEFAULT_PING_MS = 120_000
/** Longest the acknowledgement of an event waits for its handler. */
const ACK_PATIENCE_MS = 2_500
const FRAGMENT_TTL_MS = 10_000
/** Endpoint codes that mean "retry later". */
const RETRYABLE_CODES = new Set([1, 1000040343])
/** Endpoint code for too many live connections on one app. */
const CONNECTION_LIMIT_CODE = 1000040350

interface Pending {
  parts: Array<Uint8Array | undefined>
  createdAt: number
}

/** One Feishu long-connection session. */
export class FeishuConnection {
  constructor(private readonly options: ConnectionOptions) {}

  /**
   * Discover the endpoint, connect, and serve events until aborted.
   * @param signal - ends the session; abort resolves normally.
   * @throws {ChatAdapterError} `auth-failed` for rejected credentials, `poll-conflict` for the connection limit,
   * `network` for everything else.
   */
  async run(signal: AbortSignal): Promise<void> {
    const endpoint = await this.discover(signal)
    if (endpoint === undefined) return
    await this.serve(endpoint, signal)
  }

  private async discover(signal: AbortSignal): Promise<{ url: string; serviceId: number; pingMs: number } | undefined> {
    let body: { code?: number; msg?: string; data?: { URL?: string; ClientConfig?: { PingInterval?: number } } }
    try {
      const response = await this.options.fetch(new URL('/callback/ws/endpoint', this.options.domain), {
        method: 'POST',
        headers: { 'content-type': 'application/json', locale: 'zh' },
        body: JSON.stringify({ AppID: this.options.appId, AppSecret: await this.options.secret() }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      })
      body = await response.json() as typeof body
    } catch (error) {
      if (signal.aborted) return undefined
      throw new ChatAdapterError('network', 'feishu', 'endpoint discovery failed', { cause: error })
    }
    const code = body.code ?? -1
    if (code !== 0) {
      const message = `endpoint discovery refused (code ${String(code)}: ${body.msg ?? 'no message'})`
      if (RETRYABLE_CODES.has(code)) throw new ChatAdapterError('network', 'feishu', message)
      throw new ChatAdapterError(code === CONNECTION_LIMIT_CODE ? 'poll-conflict' : 'auth-failed', 'feishu', message)
    }
    const url = body.data?.URL
    if (url === undefined) throw new ChatAdapterError('network', 'feishu', 'endpoint discovery returned no URL')
    const serviceId = Number(new URL(url).searchParams.get('service_id') ?? 0)
    const pingSeconds = body.data?.ClientConfig?.PingInterval
    return { url, serviceId, pingMs: pingSeconds === undefined ? DEFAULT_PING_MS : Math.max(1_000, pingSeconds * 1_000) }
  }

  private serve(endpoint: { url: string; serviceId: number; pingMs: number }, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = this.options.createSocket(endpoint.url)
      const fragments = new Map<string, Pending>()
      let pingMs = endpoint.pingMs
      let pingTimer: ReturnType<typeof setTimeout> | undefined
      let livenessTimer: ReturnType<typeof setTimeout> | undefined
      let settled = false
      const finish = (error?: ChatAdapterError): void => {
        if (settled) return
        settled = true
        clearTimeout(pingTimer)
        clearTimeout(livenessTimer)
        signal.removeEventListener('abort', onAbort)
        socket.terminate()
        if (error === undefined) resolve()
        else reject(error)
      }
      const onAbort = (): void => { finish() }
      signal.addEventListener('abort', onAbort, { once: true })
      const arm = (): void => {
        clearTimeout(livenessTimer)
        livenessTimer = setTimeout(() => { finish(new ChatAdapterError('network', 'feishu', 'no frame received before the liveness deadline')) }, pingMs * 3)
      }
      const ping = (): void => {
        socket.send(encodeFrame({ SeqID: 0n, LogID: 0n, service: endpoint.serviceId, method: CONTROL, headers: [{ key: 'type', value: 'ping' }] }))
        pingTimer = setTimeout(ping, pingMs)
      }
      socket.on('open', () => { ping(); arm() })
      socket.on('error', (error) => { finish(new ChatAdapterError('network', 'feishu', 'socket error', { cause: error })) })
      socket.on('close', () => { finish(new ChatAdapterError('network', 'feishu', 'connection closed')) })
      socket.on('message', (data) => {
        arm()
        let frame: Frame
        try {
          frame = decodeFrame(data as Uint8Array)
        } catch (error) {
          this.options.warn('dropping a malformed frame', error)
          return
        }
        if (frame.method === CONTROL) {
          const next = this.control(frame)
          if (next !== undefined) pingMs = next
        } else if (frame.method === DATA) {
          this.data(frame, fragments, socket)
        }
      })
    })
  }

  /** Apply a pong's refreshed ping interval; returns it in ms when present. */
  private control(frame: Frame): number | undefined {
    const type = frame.headers.find(header => header.key === 'type')?.value
    if (type !== 'pong' || frame.payload === undefined) return undefined
    try {
      const config = JSON.parse(new TextDecoder().decode(frame.payload)) as { PingInterval?: number }
      return config.PingInterval === undefined ? undefined : Math.max(1_000, config.PingInterval * 1_000)
    } catch (error) {
      this.options.warn('ignoring an unreadable pong', error)
      return undefined
    }
  }

  private data(frame: Frame, fragments: Map<string, Pending>, socket: SocketLike): void {
    const headers = Object.fromEntries(frame.headers.map(header => [header.key, header.value]))
    if (headers.type !== 'event' || frame.payload === undefined) return
    const now = Date.now()
    for (const [id, entry] of fragments) if (now - entry.createdAt > FRAGMENT_TTL_MS) fragments.delete(id)
    const sum = Number(headers.sum ?? 1)
    const seq = Number(headers.seq ?? 0)
    const id = headers.message_id ?? ''
    const entry = fragments.get(id) ?? { parts: Array<Uint8Array | undefined>(sum).fill(undefined), createdAt: now }
    entry.parts[seq] = frame.payload
    fragments.set(id, entry)
    if (!entry.parts.every(part => part !== undefined)) return
    fragments.delete(id)
    const whole = Buffer.concat(entry.parts)
    let event: unknown
    try {
      event = JSON.parse(whole.toString('utf8'))
    } catch (error) {
      this.options.warn('dropping an event that is not JSON', error)
      return
    }
    const started = Date.now()
    const handled = this.options.onEvent(event).then(() => 200, (error: unknown) => {
      this.options.warn('handling an event failed', error)
      return 500
    })
    void Promise.race([handled, new Promise<number>((resolve) => { setTimeout(resolve, ACK_PATIENCE_MS, 200).unref() })]).then((code) => {
      try {
        socket.send(encodeFrame({
          ...frame,
          headers: [...frame.headers, { key: 'biz_rt', value: String(Date.now() - started) }],
          payload: new TextEncoder().encode(JSON.stringify({ code })),
        }))
      } catch (error) {
        // The socket closed while the handler ran; the platform redelivers unacknowledged events on the next connection.
        this.options.warn('acknowledging an event failed', error)
      }
    })
  }
}
