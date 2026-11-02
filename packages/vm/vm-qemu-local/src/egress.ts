/**
 * Host-side egress relay with approval gate for one micro-VM world.
 *
 * The guest has no network device by construction, so every outbound
 * connection a world's orchestration makes on its behalf is a host decision:
 * `open` consults the world's {@link EgressPolicy} and only then dials the
 * target, piping bytes through a tracked handle. With no policy, or a policy
 * that declines, the request fails `EGRESS_DENIED` — deny is the default,
 * not an opt-in. Handles close with the world.
 * @module @deepseek-ai/dsh-vm-qemu-local
 */

import { connect as nodeConnect } from 'node:net'

/** One approved-or-denied outbound connection request. */
export interface EgressRequest {
  /** Target hostname; resolved and dialed by the host. */
  readonly host: string
  /** Target port. */
  readonly port: number
}

/**
 * Approval callback deciding one egress request.
 * @param request - the target the world wants to reach.
 * @returns whether the relay may dial it; asynchronous answers are awaited.
 */
export type EgressPolicy = (request: EgressRequest) => boolean | Promise<boolean>

/** The approval callback declined the request (or no policy was provided). */
export class EgressDeniedError extends Error {
  constructor(public readonly request: EgressRequest) {
    super(`egress denied: ${request.host}:${String(request.port)}`)
    this.name = 'EgressDeniedError'
  }
}

/** The approved dial failed or timed out. */
export class EgressConnectError extends Error {
  constructor(
    public readonly request: EgressRequest,
    public readonly code: string,
    cause?: unknown,
  ) {
    super(`egress connect failed (${code}): ${request.host}:${String(request.port)}`)
    this.name = 'EgressConnectError'
    this.cause = cause
  }
}


/** Minimal socket surface the relay drives. */
export interface EgressSocket {
  write(data: Uint8Array | string): boolean
  destroy(): void
  on(event: 'data', listener: (chunk: Buffer) => void): void
  on(event: 'close', listener: (hadError: boolean) => void): void
  on(event: 'error', listener: (error: Error) => void): void
}

/** Injectable seams for the relay; every field has a real default. */
export interface EgressDeps {
  /** Dial one approved request; defaults to `node:net` connect. */
  connect?: (request: EgressRequest) => Promise<EgressSocket>
}

/** Live relay handle for one approved egress connection. */
export interface EgressHandle {
  /** The request this handle serves. */
  readonly request: EgressRequest
  /**
   * Send one chunk to the target.
   * @param chunk - bytes to relay outbound.
   * @throws Error when the handle already closed.
   */
  write(chunk: Uint8Array | string): void
  /** Iterate inbound chunks; ends at stream end, throws on transport error. */
  [Symbol.asyncIterator](): AsyncIterator<Buffer, undefined, void>
  /** Resolves once the connection is closed, however it closed. */
  readonly closed: Promise<void>
  /** Close the connection; safe to call more than once. */
  close(): Promise<void>
}

/** Default connect budget per approved request. */
export const DEFAULT_EGRESS_CONNECT_TIMEOUT_MS = 5_000

interface RelayState {
  chunks: Buffer[]
  waiters: ((result: IteratorResult<Buffer, undefined>) => void)[]
  terminal: { error?: Error } | undefined
}

function defaultConnect(request: EgressRequest): Promise<EgressSocket> {
  return new Promise((resolve, reject) => {
    const socket = nodeConnect(request.port, request.host)
    socket.once('connect', () => { resolve(socket) })
    socket.once('error', (error: Error) => { reject(error) })
  })
}

/** Egress relay for one world: approval gate, tracked handles, bulk close. */
export class WorldEgress {
  private readonly handles = new Set<{ close(): Promise<void> }>()
  private closed = false

  constructor(
    private readonly policy: EgressPolicy | undefined,
    private readonly deps: EgressDeps = {},
    private readonly connectTimeoutMs: number = DEFAULT_EGRESS_CONNECT_TIMEOUT_MS,
  ) {}

  /**
   * Ask the policy and, when approved, dial the target.
   * @param host - target hostname.
   * @param port - target port.
   * @returns the live relay handle.
   * @throws EgressDeniedError when no policy is set or it declines.
   * @throws EgressConnectError when the dial fails or times out.
   */
  async open(host: string, port: number): Promise<EgressHandle> {
    if (this.closed) throw new EgressDeniedError({ host, port })
    const request: EgressRequest = { host, port }
    const allowed = this.policy === undefined ? false : await this.policy(request)
    if (!allowed) throw new EgressDeniedError(request)

    const connect = this.deps.connect ?? defaultConnect
    let socket: EgressSocket
    try {
      socket = await new Promise<EgressSocket>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error('EGRESS_CONNECT_TIMEOUT')) }, this.connectTimeoutMs)
        connect(request).then(
          (connected) => { clearTimeout(timer); resolve(connected) },
          (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) },
        )
      })
    } catch (error) {
      const code = error instanceof Error && /^EGRESS_/.test(error.message) ? error.message : describeErrno(error)
      throw new EgressConnectError(request, code, error)
    }

    const state: RelayState = { chunks: [], waiters: [], terminal: undefined }
    const whenClosed = new Promise<void>((resolve) => {
      socket.on('close', () => {
        state.terminal ??= {}
        resolve()
      })
    })
    socket.on('data', (chunk: Buffer) => {
      const waiter = state.waiters.shift()
      if (waiter !== undefined) waiter({ value: chunk, done: false })
      else state.chunks.push(chunk)
    })
    socket.on('error', (error: Error) => {
      state.terminal ??= { error: new EgressConnectError(request, describeErrno(error), error) }
    })

    const entry = {
      close: async () => {
        socket.destroy()
        await whenClosed
      },
    }
    this.handles.add(entry)
    void whenClosed.then(() => { this.handles.delete(entry) })

    return {
      request,
      closed: whenClosed,
      write(chunk: Uint8Array | string) {
        if (state.terminal !== undefined) throw new Error('egress handle closed')
        socket.write(chunk)
      },
      [Symbol.asyncIterator]() {
        return {
          next: (): Promise<IteratorResult<Buffer, undefined>> => {
            const buffered = state.chunks.shift()
            if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false })
            if (state.terminal !== undefined) {
              if (state.terminal.error !== undefined) return Promise.reject(state.terminal.error)
              return Promise.resolve({ value: undefined, done: true })
            }
            return new Promise((resolve) => { state.waiters.push(resolve) })
          },
        }
      },
      close: async () => {
        socket.destroy()
        await whenClosed
      },
    }
  }

  /** Close every live handle; further `open` calls deny. */
  async closeAll(): Promise<void> {
    this.closed = true
    await Promise.all([...this.handles].map(async handle => handle.close()))
  }
}

function describeErrno(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && code.length > 0 ? code : 'EGRESS_CONNECT_FAILED'
}
