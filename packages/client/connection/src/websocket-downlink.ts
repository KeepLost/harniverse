/** Host-side WebSocket carrier for the two server-to-browser event streams. */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  authenticationPrincipalIdentity,
  type AuthenticationDecision,
  type AuthenticationGrantRevision,
} from '@deepseek-ai/dsh-authentication'
import WebSocket, { WebSocketServer } from 'ws'
import type {
  ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { CONNECTION_AUTHENTICATED_METHOD, RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { eventsMuxRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'

type Frame = MuxFrame | HostFrame
type AcceptedAuthentication = Extract<AuthenticationDecision, { kind: 'accepted' }>

function serverRequest(frame: RpcRequest<Frame>): ServerRequest {
  return {
    type: 'server-request',
    rpcId: frame.rpcId,
    method: frame.payload.type,
    payload: frame.payload,
  }
}

function authenticationRequest(admission: AcceptedAuthentication): ServerRequest {
  return {
    type: 'server-request',
    rpcId: RpcId(randomUUID()),
    method: CONNECTION_AUTHENTICATED_METHOD,
    payload: authenticationPrincipalIdentity(admission.principal),
  }
}

function send(socket: WebSocket, frame: RpcRequest<Frame>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error('websocket downlink closed before frame delivery'))
      return
    }
    socket.send(JSON.stringify(serverRequest(frame)), (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function sendRequest(socket: WebSocket, request: ServerRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error('websocket downlink closed before control delivery'))
      return
    }
    socket.send(JSON.stringify(request), (error) => {
      if (error == null) resolve()
      else reject(error)
    })
  })
}

function failureFrame(): RpcRequest<Frame> {
  return {
    rpcId: RpcId(randomUUID()),
    payload: {
      type: 'stream/error',
      error: { code: 'internal', message: 'event stream failed', details: {} },
    },
  }
}

/**
 * Owns WebSocket negotiation and frame pumping for the connection plugin's
 * two downlinks. Client messages are a protocol violation: upstream traffic
 * remains on HTTP.
 */
export class WebSocketDownlinks {
  private readonly server = new WebSocketServer({ noServer: true })
  private readonly pumps = new Set<Promise<void>>()
  private readonly admissions = new Map<WebSocket, AcceptedAuthentication>()
  private readonly revokedGrants = new Map<string, number>()
  private authenticationAvailable = true

  /**
   * @param api - host API supplying the typed event streams.
   * @param reportError - server-side diagnostic sink for source failures.
   */
  constructor(
    private readonly api: ApiProxy,
    private readonly reportError: (error: unknown) => void = (error) => {
      console.error('[client-connection] WebSocket event stream failed:', error)
    },
  ) {}

  /**
   * Upgrade one socket and pump the mux stream until either side closes.
   * @param req - HTTP upgrade request.
   * @param socket - Raw socket transferred by the HTTP server.
   * @param head - Bytes already read after the upgrade headers.
   * @param admission - accepted principal and optional revocable credential.
   */
  handleMux(req: IncomingMessage, socket: Duplex, head: Buffer, admission: AcceptedAuthentication): void {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const values = url.searchParams.getAll('since')
    let decoded: unknown = undefined
    try {
      if (values.length > 1) throw new Error('duplicate since')
      if (values[0] !== undefined) decoded = JSON.parse(values[0])
    } catch {
      rejectBadRequest(socket)
      return
    }
    const parsed = eventsMuxRequestSchema.safeParse(decoded === undefined ? {} : { since: decoded })
    if (!parsed.success) {
      rejectBadRequest(socket)
      return
    }
    const payload = parsed.data as Parameters<ApiProxy['events']['mux']>[0]['payload']
    this.upgrade(req, socket, head, signal => this.api.events.mux({
      rpcId: RpcId(randomUUID()),
      payload,
      principal: admission.principal,
    }, signal), admission)
  }

  /**
   * Upgrade one socket and pump the host stream until either side closes.
   * @param req - HTTP upgrade request.
   * @param socket - Raw socket transferred by the HTTP server.
   * @param head - Bytes already read after the upgrade headers.
   * @param admission - accepted principal and optional revocable credential.
   */
  handleHost(req: IncomingMessage, socket: Duplex, head: Buffer, admission: AcceptedAuthentication): void {
    this.upgrade(req, socket, head, signal => this.api.events.host({
      rpcId: RpcId(randomUUID()),
      payload: {},
      principal: admission.principal,
    }, signal), admission)
  }

  /**
   * Close sockets admitted by any invalidated Grant revision.
   * @param grants - exact Grant revisions invalidated by the registry commit.
   */
  revoke(grants: readonly AuthenticationGrantRevision[]): void {
    const revoked = new Set(grants.map(grant => `${grant.grantId}:${String(grant.grantRevision)}`))
    for (const grant of grants) {
      const previous = this.revokedGrants.get(grant.grantId) ?? 0
      this.revokedGrants.set(grant.grantId, Math.max(previous, grant.grantRevision))
    }
    for (const [socket, admission] of this.admissions) {
      if (admission.principal.kind === 'grant'
        && revoked.has(`${admission.principal.grantId}:${String(admission.principal.grantRevision)}`)) {
        socket.close(4001, 'grant revoked')
      }
    }
  }

  /** Close current sockets and reject upgrades until authentication recovers. */
  authenticationUnavailable(): void {
    this.authenticationAvailable = false
    for (const socket of this.server.clients) socket.close(1012, 'authentication unavailable')
  }

  /** Admit upgrades again after the provider reconciles credential freshness. */
  authenticationRecovered(): void {
    this.authenticationAvailable = true
  }

  /**
   * Terminate owned sockets and await the no-server acceptor plus frame pumps.
   * @returns A promise resolving after every socket and source iterator stops.
   */
  async close(): Promise<void> {
    for (const socket of this.server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
    await Promise.all(this.pumps)
  }

  private upgrade<F extends Frame>(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    open: (signal: AbortSignal) => AsyncIterable<RpcRequest<F>>,
    admission: AcceptedAuthentication,
  ): void {
    this.server.handleUpgrade(req, socket, head, (websocket) => {
      const abort = new AbortController()
      if (!this.authenticationAvailable) {
        websocket.close(1012, 'authentication unavailable')
        return
      }
      if (admission.principal.kind === 'grant'
        && (this.revokedGrants.get(admission.principal.grantId) ?? 0) >= admission.principal.grantRevision) {
        websocket.close(4001, 'grant revoked')
        return
      }
      if (admission.principal.kind === 'grant' && Date.parse(admission.principal.expiresAt) <= Date.now()) {
        websocket.close(4001, 'access expired')
        return
      }
      this.admissions.set(websocket, admission)
      const expiry = admission.principal.kind === 'grant'
        ? setTimeout(() => { websocket.close(4001, 'access expired') }, Math.min(
          Math.max(1, Date.parse(admission.principal.expiresAt) - Date.now()),
          2_147_483_647,
        ))
        : undefined
      expiry?.unref()
      const cleanup = (): void => {
        if (expiry !== undefined) clearTimeout(expiry)
        this.admissions.delete(websocket)
        abort.abort()
      }
      websocket.once('close', cleanup)
      websocket.once('error', cleanup)
      websocket.once('message', () => {
        websocket.close(1008, 'downlink only')
      })
      const pump = this.pump(websocket, open(abort.signal), abort, admission)
      this.pumps.add(pump)
      // pump contains its own failures; teardown still releases the entry if
      // its finalizer ever throws.
      const forget = (): void => { this.pumps.delete(pump) }
      void pump.then(forget, forget)
    })
  }

  private async pump<F extends Frame>(
    socket: WebSocket,
    frames: AsyncIterable<RpcRequest<F>>,
    abort: AbortController,
    admission: AcceptedAuthentication,
  ): Promise<void> {
    try {
      await sendRequest(socket, authenticationRequest(admission))
      for await (const frame of frames) await send(socket, frame)
    } catch (error) {
      if (!abort.signal.aborted) {
        try {
          this.reportError(error)
        } catch {
          // A diagnostic sink must not replace downstream failure containment.
        }
        try {
          await send(socket, failureFrame())
        } catch {
          // Socket loss won the race; no downstream remains to receive the failure frame.
        }
      }
    } finally {
      abort.abort()
      if (socket.readyState === WebSocket.OPEN) socket.close()
    }
  }
}

/** Reject a malformed stream query before WebSocket negotiation. */
function rejectBadRequest(socket: Duplex): void {
  socket.end([
    'HTTP/1.1 400 Bad Request',
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Length: 11',
    '',
    'bad request',
  ].join('\r\n'))
}

/**
 * Reject an untrusted upgrade before protocol negotiation.
 * @param socket - Raw HTTP socket that remains owned by the caller.
 */
export function rejectWebSocketUpgrade(socket: Duplex): void {
  socket.end([
    'HTTP/1.1 403 Forbidden',
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Length: 9',
    '',
    'forbidden',
  ].join('\r\n'))
}

/**
 * Reject an unauthenticated upgrade before protocol negotiation.
 * @param socket - raw HTTP socket that remains owned by the caller.
 * @param decision - provider rejection, including an optional retry interval.
 */
export function rejectUnauthorizedWebSocket(
  socket: Duplex,
  decision: Extract<AuthenticationDecision, { kind: 'rejected' }>,
): void {
  if (decision.reason === 'rate-limited') {
    socket.end([
      'HTTP/1.1 429 Too Many Requests',
      'Connection: close',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Length: 12',
      `Retry-After: ${String(Math.ceil(decision.retryAfterMs / 1_000))}`,
      '',
      'rate limited',
    ].join('\r\n'))
    return
  }
  socket.end([
    'HTTP/1.1 401 Unauthorized',
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Length: 12',
    'WWW-Authenticate: Bearer realm="dsh"',
    '',
    'unauthorized',
  ].join('\r\n'))
}
