/** Fake mux socket and host for driving the mux deterministically. */

import { EventEmitter } from 'node:events'
import type { MuxHost } from '../../src/mux.ts'
import type { CallOptions, HostDescription, MuxSocket } from '../../src/types.ts'
import type { WirePrincipal } from '../../src/wire.ts'

/** Socket double: tests emit lifecycle events and read what the mux asked of it. */
export class FakeSocket extends EventEmitter implements MuxSocket {
  closeCodes: Array<number | undefined> = []

  constructor(readonly url: URL, readonly headers: Record<string, string>) {
    super()
  }

  close(code?: number): void {
    this.closeCodes.push(code)
    queueMicrotask(() => { this.emit('close', code ?? 1005) })
  }

  /** Emit `open`. */
  open(): this {
    this.emit('open')
    return this
  }

  /** Emit one server-request message carrying `payload`. */
  frame(rpcId: string, payload: unknown, method = 'events.mux'): this {
    this.emit('message', Buffer.from(JSON.stringify({ type: 'server-request', rpcId, method, payload })))
    return this
  }

  /** Emit the identity control frame. */
  identity(payload: unknown): this {
    return this.frame('auth-1', payload, 'connection.authenticated')
  }

  /** Emit a server-initiated close. */
  drop(code: number): this {
    this.emit('close', code)
    return this
  }
}

/** `session/event` payload. */
export function sessionEvent(sessionId: string, seq: number, type = 'assistant/chunk'): unknown {
  return { type: 'session/event', sessionId, event: { type, seq, time: 1, data: { seq } } }
}

/** A scripted {@link MuxHost}. */
export class FakeHost implements MuxHost {
  readonly config = { muxRenewAfterMs: 540_000, reconnectMinMs: 1_000, reconnectMaxMs: 8_000 }
  readonly sockets: FakeSocket[] = []
  readonly urls: URL[] = []
  readonly warnings: string[] = []
  readonly identities: WirePrincipal[] = []
  readonly described: CallOptions[] = []
  bootIds: Array<string | Error> = ['boot-1']
  authorizationFailures = 0
  private token = 0

  authorization(): Promise<string> {
    if (this.authorizationFailures > 0) {
      this.authorizationFailures -= 1
      return Promise.reject(new Error('no token'))
    }
    this.token += 1
    return Promise.resolve(`Bearer t${String(this.token)}`)
  }

  muxUrl(cursors: Readonly<Record<string, number>>, remoteHost: string | undefined): URL {
    const url = new URL('ws://127.0.0.1:3080/api/events.mux')
    if (Object.keys(cursors).length > 0) url.searchParams.set('since', JSON.stringify(cursors))
    if (remoteHost !== undefined) url.searchParams.set('dshRemoteHost', remoteHost)
    this.urls.push(url)
    return url
  }

  learnIdentity(principal: WirePrincipal): void {
    this.identities.push(principal)
  }

  describeHost(options: CallOptions = {}): Promise<HostDescription> {
    this.described.push(options)
    const next = this.bootIds.length > 1 ? this.bootIds.shift()! : this.bootIds[0]!
    return next instanceof Error ? Promise.reject(next) : Promise.resolve({ bootId: next })
  }

  warn(message: string, error?: unknown): void {
    this.warnings.push(error === undefined ? message : `${message}: ${error instanceof Error ? error.message : JSON.stringify(error)}`)
  }

  /** Socket factory for `internals.createSocket`. */
  readonly createSocket = (url: URL, headers: Record<string, string>): FakeSocket => {
    const socket = new FakeSocket(url, headers)
    this.sockets.push(socket)
    return socket
  }
}
