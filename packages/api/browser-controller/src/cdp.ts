/**
 * Minimal Chrome DevTools Protocol client over the runtime's global
 * `WebSocket`. The protocol is a JSON-RPC dialect with one addition this
 * controller depends on: flat sessions. `Target.attachToTarget` with
 * `flatten: true` returns a session id that rides every later message as a
 * top-level `sessionId` field, so one socket multiplexes all of a browser's
 * pages instead of one socket per page.
 *
 * Deliberately not a browser-automation library: the controller needs command
 * dispatch, event delivery, and failure propagation, and Node ships a
 * `WebSocket` capable of all three — a CDP dependency would add a supply-chain
 * surface for no behaviour this package does not already own.
 */

/** One protocol event: a method notification with no `id`. */
export interface CdpEvent {
  readonly method: string
  readonly params: Record<string, unknown>
  /** Flat-session origin; absent for browser-level events. */
  readonly sessionId?: string
}

/** A protocol error reply (`{ id, error }`) rather than a transport failure. */
export class CdpError extends Error {
  /** Protocol error code as reported by the browser. */
  readonly code: number

  /**
   * @param method - command that failed.
   * @param code - protocol error code.
   * @param message - protocol error message.
   */
  constructor(method: string, code: number, message: string) {
    super(`${method} failed: ${message}`)
    this.name = 'CdpError'
    this.code = code
  }
}

/** One in-flight command awaiting its reply. */
interface Pending {
  readonly method: string
  readonly resolve: (value: Record<string, unknown>) => void
  readonly reject: (error: Error) => void
}

/** An open DevTools connection to one browser process. */
export class CdpConnection {
  private readonly socket: WebSocket
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<(event: CdpEvent) => void>()
  private nextId = 0
  private failure: Error | undefined

  /**
   * @param socket - an already-open WebSocket to the browser endpoint.
   */
  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener('message', (event) => { this.receive(event) })
    socket.addEventListener('close', () => { this.fail(new Error('DevTools connection closed')) })
    socket.addEventListener('error', () => { this.fail(new Error('DevTools connection failed')) })
  }

  /**
   * Open a connection and wait for the socket handshake.
   * @param endpoint - `ws://` DevTools endpoint printed by the browser.
   * @param signal - abort signal cancelling the handshake wait.
   * @returns the connected client.
   */
  static open(endpoint: string, signal: AbortSignal): Promise<CdpConnection> {
    return new Promise<CdpConnection>((resolve, reject) => {
      const socket = new WebSocket(endpoint)
      const settle = (): void => {
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
        signal.removeEventListener('abort', onAbort)
      }
      const onOpen = (): void => {
        settle()
        resolve(new CdpConnection(socket))
      }
      const onError = (): void => {
        settle()
        reject(new Error(`DevTools endpoint ${endpoint} refused the connection`))
      }
      const onAbort = (): void => {
        settle()
        socket.close()
        reject(new Error('DevTools connection was aborted'))
      }
      socket.addEventListener('open', onOpen)
      socket.addEventListener('error', onError)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Dispatch one command and await its reply.
   * @param method - protocol method name.
   * @param params - method parameters.
   * @param sessionId - flat session the command targets; absent addresses the browser.
   * @returns the reply's result object.
   */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    this.nextId += 1
    const id = this.nextId
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject })
      // A send on an already-dead socket is dropped rather than thrown by the
      // platform WebSocket; the command then fails through the close event,
      // which is the same failure every other in-flight command receives.
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
    })
  }

  /**
   * Subscribe to every protocol event on this connection.
   * @param listener - event sink.
   * @returns an unsubscribe function.
   */
  on(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Close the socket; in-flight commands reject. */
  close(): void {
    this.fail(new Error('DevTools connection was closed by the host'))
    // A socket that already closed throws nothing here; close() is idempotent.
    this.socket.close()
  }

  /** Decode one socket message into a reply or an event. */
  private receive(event: MessageEvent): void {
    if (typeof event.data !== 'string') return
    let message: Record<string, unknown>
    try {
      message = JSON.parse(event.data) as Record<string, unknown>
    } catch {
      // A malformed frame cannot be correlated to a command, so the only
      // honest action is to ignore it and let the command's own caller time out.
      return
    }
    const id = message['id']
    if (typeof id === 'number') {
      this.settle(id, message)
      return
    }
    const method = message['method']
    if (typeof method !== 'string') return
    const params = (message['params'] ?? {}) as Record<string, unknown>
    const sessionId = message['sessionId']
    const decoded: CdpEvent = {
      method,
      params,
      ...(typeof sessionId === 'string' ? { sessionId } : {}),
    }
    for (const listener of [...this.listeners]) listener(decoded)
  }

  /** Resolve or reject one pending command from its reply message. */
  private settle(id: number, message: Record<string, unknown>): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    const error = message['error']
    if (error !== undefined && typeof error === 'object') {
      const record = error as { code?: unknown; message?: unknown }
      const code = typeof record.code === 'number' ? record.code : 0
      const text = typeof record.message === 'string' ? record.message : 'unknown protocol error'
      pending.reject(new CdpError(pending.method, code, text))
      return
    }
    pending.resolve((message['result'] ?? {}) as Record<string, unknown>)
  }

  /** Record a terminal failure and reject every in-flight command once. */
  private fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.reject(error)
  }
}
