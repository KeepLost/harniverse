/**
 * Host-side egress relay with an origin-bound approval gate for one micro-VM
 * world.
 *
 * The guest has no network device by construction, so every outbound
 * connection a world's guest asks for is a host decision: a dial consults the
 * approval source registered under the requesting exec's egress-origin token
 * and only then connects to the target, piping bytes through a tracked
 * handle. With no registered approver — or one that declines — the dial
 * denies `EGRESS_DENIED`: deny is the default, not an opt-in. `egress:
 * 'deny'` keeps the whole surface closed regardless of registrations.
 * Handles close with the world.
 * @module @deepseek-ai/dsh-vm-qemu-local
 */

import { connect as nodeConnect } from 'node:net'
import type { EgressPolicy, EgressRequest } from '@deepseek-ai/dsh-vm'

export type { EgressPolicy, EgressRequest } from '@deepseek-ai/dsh-vm'

/** The approval callback declined the request (or no approver was registered). */
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
  waiters: { resolve: (result: IteratorResult<Buffer, undefined>) => void; reject: (error: Error) => void }[]
  terminal: { error?: Error } | undefined
}

function defaultConnect(request: EgressRequest): Promise<EgressSocket> {
  return new Promise((resolve, reject) => {
    const socket = nodeConnect(request.port, request.host)
    socket.once('connect', () => { resolve(socket) })
    socket.once('error', (error: Error) => { reject(error) })
  })
}

/** Whether this world consults registered approvers at all. */
export type EgressMode = 'ask' | 'deny'

/** Egress relay for one world: origin-bound approvals, tracked handles, bulk close. */
export class WorldEgress {
  private readonly approvers = new Map<string, EgressPolicy>()
  private readonly handles = new Set<{ close(): Promise<void> }>()
  private closed = false

  constructor(
    private readonly mode: EgressMode = 'deny',
    private readonly deps: EgressDeps = {},
    private readonly connectTimeoutMs: number = DEFAULT_EGRESS_CONNECT_TIMEOUT_MS,
  ) {}

  /**
   * Bind one egress-origin token to an approval callback.
   * @param origin - token execs carry and egress dials echo back.
   * @param approver - callback consulted before any dial with this origin.
   * @returns disposer that unbinds the token.
   */
  register(origin: string, approver: EgressPolicy): () => void {
    this.approvers.set(origin, approver)
    return () => {
      if (this.approvers.get(origin) === approver) this.approvers.delete(origin)
    }
  }

  /**
   * Ask the origin's approver and, when approved, dial the target.
   * @param host - target hostname.
   * @param port - target port.
   * @param origin - egress-origin token the dialing exec carried.
   * @returns the live relay handle.
   * @throws EgressDeniedError when the surface is closed or in `deny` mode,
   *   the origin has no registered approver, or the approver declines.
   * @throws EgressConnectError when the dial fails or times out.
   */
  async open(host: string, port: number, origin?: string): Promise<EgressHandle> {
    const request: EgressRequest = { host, port }
    if (origin !== undefined) request.origin = origin
    if (this.closed || this.mode !== 'ask') throw new EgressDeniedError(request)
    const approver = origin === undefined ? undefined : this.approvers.get(origin)
    if (approver === undefined) throw new EgressDeniedError(request)
    let allowed: boolean
    try {
      allowed = await approver(request)
    } catch {
      throw new EgressDeniedError(request)
    }
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
    const settleWaiters = (): void => {
      for (const waiter of state.waiters.splice(0)) {
        if (state.terminal?.error !== undefined) waiter.reject(state.terminal.error)
        else waiter.resolve({ value: undefined, done: true })
      }
    }
    const whenClosed = new Promise<void>((resolve) => {
      socket.on('close', () => {
        state.terminal ??= {}
        settleWaiters()
        resolve()
      })
    })
    socket.on('data', (chunk: Buffer) => {
      const waiter = state.waiters.shift()
      if (waiter !== undefined) waiter.resolve({ value: chunk, done: false })
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
            return new Promise<IteratorResult<Buffer, undefined>>((resolve, reject) => {
              state.waiters.push({ resolve, reject })
            })
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
