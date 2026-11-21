/** Shared scripted pairing target for the peer subagent backend tests. */

import { createServer, type Server } from 'node:http'
import type { PeerRunResult } from '@deepseek-ai/dsh-peer-protocol'

/** One captured peer RPC request. */
export interface CapturedCall {
  url: string
  request: Record<string, unknown>
}

/** The scripted target's delegated session id. */
export const SCRIPTED_PEER_SESSION = 'peer-01234567-89ab-cdef-0123-456789abcdef'

/** Scripted pairing target: token exchange plus queued delegate readbacks. */
export class ScriptedPeerTarget {
  readonly requests: CapturedCall[] = []
  delegateRuns: PeerRunResult[] = []
  wireError: { reason: string } | undefined
  /** Serve a non-JSON token response, so transport setup fails before any RPC. */
  tokenGarbage = false
  /** Optional delay before the delegate readback, to race local cancellation. */
  delayMs = 0
  private readonly server: Server

  constructor() {
    this.server = createServer((req, response) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => { chunks.push(chunk as Buffer) })
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { rpcId?: string; payload?: { args?: { request?: Record<string, unknown> } } }
        const url = req.url ?? ''
        if (url === '/auth/challenge') {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ id: 'cha', payload: 'c2lnbg', expiresAt: new Date(Date.now() + 60_000).toISOString() }))
          return
        }
        if (url === '/auth/token') {
          response.setHeader('content-type', 'application/json')
          response.end(this.tokenGarbage ? 'not json' : JSON.stringify({ accessToken: 'tok', expiresAt: new Date(Date.now() + 60_000).toISOString() }))
          return
        }
        const request = body.payload?.args?.request ?? {}
        this.requests.push({ url, request })
        const send = (value: unknown, ok = true): void => {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify(ok
            ? { type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }
            : { type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code: 'peer-failed', details: { reason: this.wireError?.reason }, message: `peer: ${String(this.wireError?.reason)}` } } }))
        }
        if (this.wireError !== undefined) { send(undefined, false); return }
        if (url.endsWith('/api/peer/delegate')) {
          const reply = () => {
            send(this.delegateRuns.shift() ?? { sessionId: SCRIPTED_PEER_SESSION, messageId: 'm', state: 'settled', reply: 'ok', endReason: 'completed' })
          }
          if (this.delayMs > 0) {
            setTimeout(reply, this.delayMs)
            return
          }
          reply()
          return
        }
        send(undefined, false)
      })
    })
  }

  /** Start listening and return the reachable origin. */
  async start(): Promise<string> {
    await new Promise<void>((resolve) => { this.server.listen(0, '127.0.0.1', () => { resolve() }) })
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('scripted target: no listen address')
    return `http://127.0.0.1:${String(address.port)}`
  }

  /** Stop the server. */
  async stop(): Promise<void> {
    await new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
  }
}
