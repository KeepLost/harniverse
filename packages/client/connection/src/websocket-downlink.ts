/** Host-side WebSocket carrier for the two server-to-browser event streams. */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import type {
  ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { AuthenticationCredential } from '@deepseek-ai/dsh-authentication'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { eventsMuxRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'

type Frame = MuxFrame | HostFrame

function serverRequest(frame: RpcRequest<Frame>): ServerRequest {
  return {
    type: 'server-request',
    rpcId: frame.rpcId,
    method: frame.payload.type,
    payload: frame.payload,
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

function failureFrame(error: unknown): RpcRequest<Frame> {
  return {
    rpcId: RpcId(randomUUID()),
    payload: {
      type: 'stream/error',
      error: { code: 'internal', message: String(error), details: {} },
    },
  }
}

function credentialKey(credential: AuthenticationCredential): string {
  return `${credential.tokenId}:${String(credential.generation)}`
}

/**
 * Owns WebSocket negotiation and frame pumping for the connection plugin's
 * two downlinks. Client messages are a protocol violation: upstream traffic
 * remains on HTTP.
 */
export class WebSocketDownlinks {
  private readonly server = new WebSocketServer({ noServer: true })
  private readonly pumps = new Set<Promise<void>>()
  private readonly credentials = new Map<WebSocket, AuthenticationCredential>()
  private readonly revokedCredentials = new Map<string, number>()
  private authenticationAvailable = true

  /** @param api - host API supplying the typed event streams. */
  constructor(private readonly api: ApiProxy) {}

  /**
   * Upgrade one socket and pump the mux stream until either side closes.
   * @param req - HTTP upgrade request.
   * @param socket - Raw socket transferred by the HTTP server.
   * @param head - Bytes already read after the upgrade headers.
   * @param credential - accepted token revision, absent in bypass mode.
   */
  handleMux(req: IncomingMessage, socket: Duplex, head: Buffer, credential?: AuthenticationCredential): void {
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
    }, signal), credential)
  }

  /**
   * Upgrade one socket and pump the host stream until either side closes.
   * @param req - HTTP upgrade request.
   * @param socket - Raw socket transferred by the HTTP server.
   * @param head - Bytes already read after the upgrade headers.
   * @param credential - accepted token revision, absent in bypass mode.
   */
  handleHost(req: IncomingMessage, socket: Duplex, head: Buffer, credential?: AuthenticationCredential): void {
    this.upgrade(req, socket, head, signal => this.api.events.host({
      rpcId: RpcId(randomUUID()),
      payload: {},
    }, signal), credential)
  }

  /**
   * Close sockets admitted by any invalidated credential revision.
   * @param credentials - exact token revisions invalidated by the registry commit.
   */
  revoke(credentials: readonly AuthenticationCredential[]): void {
    const revoked = new Set(credentials.map(credentialKey))
    for (const credential of credentials) {
      const previous = this.revokedCredentials.get(credential.tokenId) ?? 0
      this.revokedCredentials.set(credential.tokenId, Math.max(previous, credential.generation))
    }
    for (const [socket, credential] of this.credentials) {
      if (revoked.has(credentialKey(credential))) {
        socket.close(4001, 'credential revoked')
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
    credential?: AuthenticationCredential,
  ): void {
    this.server.handleUpgrade(req, socket, head, (websocket) => {
      const abort = new AbortController()
      if (!this.authenticationAvailable) {
        websocket.close(1012, 'authentication unavailable')
        return
      }
      if (credential !== undefined
        && (this.revokedCredentials.get(credential.tokenId) ?? 0) >= credential.generation) {
        websocket.close(4001, 'credential revoked')
        return
      }
      if (credential !== undefined) this.credentials.set(websocket, credential)
      const cleanup = (): void => {
        this.credentials.delete(websocket)
        abort.abort()
      }
      websocket.once('close', cleanup)
      websocket.once('error', cleanup)
      websocket.once('message', () => {
        websocket.close(1008, 'downlink only')
      })
      const pump = this.pump(websocket, open(abort.signal), abort)
      this.pumps.add(pump)
      void pump.then(() => { this.pumps.delete(pump) })
    })
  }

  private async pump<F extends Frame>(
    socket: WebSocket,
    frames: AsyncIterable<RpcRequest<F>>,
    abort: AbortController,
  ): Promise<void> {
    try {
      for await (const frame of frames) await send(socket, frame)
    } catch (error) {
      if (!abort.signal.aborted) {
        try {
          await send(socket, failureFrame(error))
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
 */
export function rejectUnauthorizedWebSocket(socket: Duplex): void {
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
