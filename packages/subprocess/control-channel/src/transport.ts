/**
 * The optional stream-attached control transport: one duplex pair carrying
 * the frame codec, with caller-owned cancellation and deadline, close-grace
 * escalation, and the lifecycle state machine driven to quiescence and
 * cleanup. Providers supply the streams and the process-range termination
 * hook; this module never spawns or kills anything itself.
 *
 * @module @deepseek-ai/dsh-control-channel
 */

import type { Readable, Writable } from 'node:stream'
import type {
  ControlCallFrame,
  ControlChannelLimits,
  ControlFailure,
  ControlFrame,
  ControlLifecycleState,
  ControlLimitFrame,
  ControlReplyFrame,
} from './types.ts'
import { DEFAULT_CONTROL_CHANNEL_LIMITS } from './types.ts'
import {
  ControlFrameDecoder,
  ControlProtocolError,
  ControlSendQueue,
  encodeControlFrame,
  PendingCallGate,
} from './codec.ts'
import { assertControlTransition } from './lifecycle.ts'

/** One resolved terminal outcome: a success value or the first failure. */
export type ControlOutcome =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'failure'; readonly failure: ControlFailure }

/** Per-call options for {@link ControlChannelTransport.call}. */
export interface ControlCallOptions {
  /** Reject the call when its reply has not arrived within this window. */
  readonly timeoutMs?: number
}

/** Provider-supplied frame handlers; every member is optional. */
export interface ControlTransportHandlers {
  /** Progress text from the peer; wording belongs to the provider. */
  onLog?(text: string): void
  /**
   * Serve one program-to-host call and return its success value.
   * @param frame - the incoming call frame.
   * @returns the JSON-safe reply value.
   */
  onCall?(frame: ControlCallFrame): Promise<unknown>
  /** The peer hit a declared output or pending-call bound. */
  onLimit?(limit: ControlLimitFrame['limit']): void
}

/** Everything the transport needs to attach to one peer. */
export interface ControlTransportOptions {
  /** Frames arriving from the peer. */
  readonly input: Readable
  /** Frame sink toward the peer. */
  readonly output: Writable
  /** Bounds both channel ends enforce; defaults when omitted. */
  readonly limits?: ControlChannelLimits
  /** Caller cancellation; aborting terminates the execution as `abort`. */
  readonly signal?: AbortSignal
  /** Terminate the whole execution when its deadline expires. */
  readonly deadlineMs?: number
  /**
   * Escalation after the close grace expires without the peer settling —
   * the provider's forced process-range termination.
   */
  readonly forceTerminate?: () => Promise<void> | void
  /** Optional frame handlers. */
  readonly handlers?: ControlTransportHandlers
}

/** Rejection reason for one failed {@link ControlChannelTransport.call}. */
export class ControlCallError extends Error {
  constructor(readonly failure: ControlFailure) {
    super(failure.message)
    this.name = 'ControlCallError'
  }
}

interface PendingReply {
  resolve(value: unknown): void
  reject(reason: ControlCallError): void
  timer: NodeJS.Timeout | undefined
}

/**
 * The stream-attached control channel end. Attaches to one duplex pair,
 * pairs calls with replies under the pending-call gate, applies send
 * backpressure at the write site, records exactly one terminal outcome, and
 * drives the lifecycle through quiescence and cleanup — the first outcome
 * stays stable while cleanup completes and reports independently.
 */
export class ControlChannelTransport {
  private readonly limits: ControlChannelLimits
  private readonly input: Readable
  private readonly output: Writable
  private readonly forceTerminate: (() => Promise<void> | void) | undefined
  private readonly handlers: ControlTransportHandlers
  private readonly decoder = new ControlFrameDecoder()
  private readonly sendQueue: ControlSendQueue
  private readonly gate: PendingCallGate
  private readonly pending = new Map<number, PendingReply>()
  private readonly cleanupErrors: string[] = []
  private nextCallId = 1
  private state: ControlLifecycleState = 'starting'
  private outcomeRecorded = false
  private outcomeResolve: ((outcome: ControlOutcome) => void) | undefined
  private settleResolve: (() => void) | undefined
  private readonly outcomePromise: Promise<ControlOutcome>
  private readonly settledPromise: Promise<void>
  private graceTimer: NodeJS.Timeout | undefined
  private deadlineTimer: NodeJS.Timeout | undefined
  private disposed = false

  constructor(options: ControlTransportOptions) {
    this.limits = options.limits ?? DEFAULT_CONTROL_CHANNEL_LIMITS
    this.input = options.input
    this.output = options.output
    const forceTerminate = options.forceTerminate
    this.forceTerminate = forceTerminate === undefined ? undefined : () => forceTerminate()
    this.handlers = options.handlers ?? {}
    this.sendQueue = new ControlSendQueue(this.limits)
    this.gate = new PendingCallGate(this.limits)
    this.outcomePromise = new Promise((resolve) => {
      this.outcomeResolve = resolve
    })
    this.settledPromise = new Promise((resolve) => {
      this.settleResolve = resolve
    })
    this.input.on('data', (chunk) => {
      this.receive(chunk as Buffer)
    })
    this.input.on('end', () => {
      this.terminate({ kind: 'process-exit', message: 'peer closed the channel without a terminal frame' }, 'channel-closed')
      this.checkSettled()
    })
    this.input.on('error', (cause) => {
      this.terminate({ kind: 'io', message: `input stream failed: ${cause.message}` }, 'channel-closed')
      this.checkSettled()
    })
    this.output.on('error', (cause) => {
      this.terminate({ kind: 'io', message: `output stream failed: ${cause.message}` }, 'channel-closed')
      this.checkSettled()
    })
    this.output.on('finish', () => {
      this.checkSettled()
    })
    this.input.on('close', () => {
      this.checkSettled()
    })
    this.output.on('close', () => {
      this.checkSettled()
    })
    const signal = options.signal
    if (signal !== undefined) {
      if (signal.aborted) {
        this.cancel(String(signal.reason))
      } else {
        signal.addEventListener('abort', () => { this.cancel(String(signal.reason)) }, { once: true })
      }
    }
    if (options.deadlineMs !== undefined) {
      this.deadlineTimer = setTimeout(() => {
        this.terminate({ kind: 'timeout', message: `execution deadline of ${options.deadlineMs}ms expired` }, 'timed-out')
      }, options.deadlineMs)
    }
  }

  /** The current lifecycle state of this channel end. */
  get lifecycleState(): ControlLifecycleState {
    return this.state
  }

  /**
   * The first terminal outcome, exactly once: a `done` frame's value or the
   * failure that ended the execution. A channel disposed before terminating
   * never settles this promise.
   * @returns the recorded outcome.
   */
  outcome(): Promise<ControlOutcome> {
    return this.outcomePromise
  }

  /**
   * Call one target on the peer and await its reply.
   * @param target - fully-qualified invocation target.
   * @param args - JSON-safe call arguments.
   * @param options - per-call reply timeout.
   * @returns the reply's success value.
   * @throws {@link ControlCallError} when the reply reports failure, the
   * per-call timeout expires, or the channel terminated first.
   */
  async call<T = unknown>(target: string, args: readonly unknown[] = [], options: ControlCallOptions = {}): Promise<T> {
    if (this.outcomeRecorded) {
      throw new ControlCallError({ kind: 'protocol', message: 'control channel already terminated' })
    }
    const id = this.nextCallId
    this.gate.acquire(id)
    this.nextCallId += 1
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const entry: PendingReply = {
          resolve,
          reject,
          timer: options.timeoutMs === undefined ? undefined : setTimeout(() => {
            this.pending.delete(id)
            this.gate.release(id)
            reject(new ControlCallError({ kind: 'timeout', message: `call ${id} (${target}) exceeded its ${options.timeoutMs}ms reply window` }))
          }, options.timeoutMs),
        }
        this.pending.set(id, entry)
        this.send({ kind: 'call', id, target, args })
      }) as T
    } finally {
      const entry = this.pending.get(id)
      if (entry !== undefined) {
        if (entry.timer !== undefined) clearTimeout(entry.timer)
        this.pending.delete(id)
        this.gate.release(id)
      }
    }
  }

  /**
   * Send one bounded progress line to the peer.
   * @param text - bounded human-readable progress text.
   */
  sendLog(text: string): void {
    this.send({ kind: 'log', text })
  }

  /**
   * Report one declared bound to the peer.
   * @param limit - the bound this end hit.
   */
  sendLimit(limit: ControlLimitFrame['limit']): void {
    this.send({ kind: 'limit', limit })
  }

  /**
   * Cancel the execution from the caller side: the terminal outcome becomes
   * an `abort` failure unless a first outcome was already recorded.
   * @param reason - why the caller cancelled.
   */
  cancel(reason: string): void {
    this.terminate({ kind: 'abort', message: reason }, 'cancelled')
  }

  /**
   * Resolves once the peer has settled after the terminal outcome: the
   * writable finished, the readable ended, and any close-grace escalation
   * completed. Marks the lifecycle `quiescent`.
   */
  async waitSettled(): Promise<void> {
    await this.settledPromise
  }

  /**
   * Final resource cleanup. Cancels a still-running channel first, then
   * releases timers and listeners and walks the lifecycle to `cleaned-up`.
   * Forced settlement: a peer that ignores the close does not hold cleanup
   * hostage — cooperative settlement is {@link waitSettled}.
   * @returns notes describing every cleanup error; empty when cleanup was clean.
   */
  dispose(): Promise<readonly string[]> {
    if (this.disposed) return Promise.resolve(this.cleanupErrors)
    this.disposed = true
    if (!this.outcomeRecorded) {
      this.terminate({ kind: 'abort', message: 'disposed before a terminal outcome' }, 'channel-closed')
    }
    this.releaseResources()
    this.settleResolve?.()
    this.settleResolve = undefined
    while (this.state !== 'cleaned-up') {
      this.transition(this.state === 'quiescent' ? 'cleaned-up' : 'quiescent')
    }
    return Promise.resolve(this.cleanupErrors)
  }

  private releaseResources(): void {
    if (this.graceTimer !== undefined) {
      clearTimeout(this.graceTimer)
      this.graceTimer = undefined
    }
    if (this.deadlineTimer !== undefined) clearTimeout(this.deadlineTimer)
    this.input.removeAllListeners()
    this.output.removeAllListeners()
  }

  private receive(chunk: Buffer): void {
    let frames: ControlFrame[]
    try {
      frames = this.decoder.feed(chunk)
    } catch (cause) {
      this.terminate({ kind: 'protocol', message: errorMessageOf(cause) }, 'channel-closed')
      return
    }
    if (this.state === 'starting' && frames.length > 0) this.transition('running')
    for (const frame of frames) {
      try {
        this.dispatch(frame)
      } catch (cause) {
        if (cause instanceof ControlProtocolError) {
          this.terminate({ kind: 'protocol', message: cause.message }, 'channel-closed')
          return
        }
        this.cleanupErrors.push(`frame handler failed: ${errorMessageOf(cause)}`)
      }
    }
  }

  private dispatch(frame: ControlFrame): void {
    switch (frame.kind) {
      case 'reply':
        this.dispatchReply(frame)
        break
      case 'log':
        this.handlers.onLog?.(frame.text)
        break
      case 'limit':
        this.handlers.onLimit?.(frame.limit)
        break
      case 'call':
        void this.serveCall(frame)
        break
      case 'done':
        this.terminateFromDone(frame)
        break
      default:
        assertNever(frame, 'ControlFrame dispatch')
    }
  }

  private dispatchReply(frame: ControlReplyFrame): void {
    const entry = this.pending.get(frame.id)
    if (entry === undefined) {
      this.terminate({ kind: 'protocol', message: `reply for unknown call id ${frame.id}` }, 'channel-closed')
      return
    }
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    this.pending.delete(frame.id)
    this.gate.release(frame.id)
    if (frame.ok) entry.resolve(frame.value)
    else entry.reject(new ControlCallError({ kind: 'exception', message: frame.message ?? 'call failed' }))
  }

  private async serveCall(frame: ControlCallFrame): Promise<void> {
    let reply: ControlReplyFrame
    if (this.handlers.onCall === undefined) {
      reply = { kind: 'reply', id: frame.id, ok: false, message: `no handler serves ${frame.target}` }
    } else {
      try {
        reply = { kind: 'reply', id: frame.id, ok: true, value: await this.handlers.onCall(frame) }
      } catch (cause) {
        reply = { kind: 'reply', id: frame.id, ok: false, message: errorMessageOf(cause) }
      }
    }
    this.send(reply)
  }

  private terminateFromDone(frame: Extract<ControlFrame, { kind: 'done' }>): void {
    if (this.outcomeRecorded) {
      this.cleanupErrors.push('peer sent a second terminal frame')
      return
    }
    const outcome: ControlOutcome = frame.error === undefined
      ? { kind: 'value', value: frame.value }
      : { kind: 'failure', failure: frame.error }
    this.recordOutcome(outcome, 'result-recorded')
  }

  private terminate(failure: ControlFailure, terminal: ControlLifecycleState): void {
    if (this.outcomeRecorded) return
    this.recordOutcome({ kind: 'failure', failure }, terminal)
  }

  private recordOutcome(outcome: ControlOutcome, terminal: ControlLifecycleState): void {
    this.outcomeRecorded = true
    if (this.deadlineTimer !== undefined) clearTimeout(this.deadlineTimer)
    if (this.state === 'starting') {
      this.transition('running')
    }
    this.transition(terminal)
    for (const [id, entry] of this.pending) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      entry.reject(outcome.kind === 'failure'
        ? new ControlCallError(outcome.failure)
        : new ControlCallError({ kind: 'abort', message: `channel recorded its outcome while call ${id} was pending` }))
      this.gate.release(id)
    }
    this.pending.clear()
    this.outcomeResolve?.(outcome)
    this.outcomeResolve = undefined
    this.beginClose()
  }

  private beginClose(): void {
    this.output.end()
    this.graceTimer = setTimeout(() => {
      void (async () => {
        try {
          await this.forceTerminate?.()
        } catch (cause) {
          this.cleanupErrors.push(`forced termination failed: ${errorMessageOf(cause)}`)
        }
      })()
    }, this.limits.closeGraceMs)
    this.checkSettled()
  }

  private checkSettled(): void {
    if (!this.outcomeRecorded) return
    const inputSettled = this.input.readableEnded || this.input.destroyed
    const outputSettled = this.output.writableFinished || this.output.destroyed
    if (!inputSettled || !outputSettled) return
    const resolve = this.settleResolve
    if (resolve === undefined) return
    clearTimeout(this.graceTimer)
    this.graceTimer = undefined
    this.settleResolve = undefined
    this.transition('quiescent')
    resolve()
  }

  private send(frame: ControlFrame): void {
    if (this.outcomeRecorded) return
    let encoded: Buffer
    let release: () => void
    try {
      encoded = encodeControlFrame(frame, this.limits)
      release = this.sendQueue.reserve(encoded.byteLength)
    } catch (cause) {
      if (cause instanceof ControlProtocolError) {
        this.terminate({ kind: 'protocol', message: cause.message }, 'channel-closed')
        return
      }
      throw cause
    }
    if (this.state === 'starting') this.transition('running')
    this.output.write(encoded, () => {
      release()
    })
    this.checkSettled()
  }

  private transition(to: ControlLifecycleState): void {
    assertControlTransition(this.state, to)
    this.state = to
  }
}

/** Extract a printable message from an unknown catch value. */
function errorMessageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Exhaustiveness helper for the closed control-frame union.
 * @param value - the unreachable frame variant.
 * @param context - where the unreachable variant surfaced.
 * @returns never — always throws.
 */
export function assertNever(value: never, context: string): never {
  const printable = (JSON.stringify(value) as string | undefined) ?? String(value)
  throw new ControlProtocolError(`unreachable variant in ${context}: ${printable}`)
}
