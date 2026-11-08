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
import type { ControlCallFrame, ControlChannelLimits, ControlDonePayload, ControlFailure, ControlLifecycleState, ControlLimitFrame } from './types.ts'
/** One resolved terminal outcome: a success value or the first failure. */
export type ControlOutcome = {
  readonly kind: 'value'
  readonly value: unknown
} | {
  readonly kind: 'failure'
  readonly failure: ControlFailure
}
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
export declare class ControlCallError extends Error {
  /** The orthogonal failure vocabulary entry this rejection carries. */
  readonly failure: ControlFailure
  constructor(failure: ControlFailure)
}
/**
 * The stream-attached control channel end. Attaches to one duplex pair,
 * pairs calls with replies under the pending-call gate, applies send
 * backpressure at the write site, records exactly one terminal outcome, and
 * drives the lifecycle through quiescence and cleanup — the first outcome
 * stays stable while cleanup completes and reports independently.
 */
export declare class ControlChannelTransport {
  private readonly limits
  private readonly input
  private readonly output
  private readonly forceTerminate
  private readonly handlers
  private readonly decoder
  private readonly sendQueue
  private readonly gate
  private pending
  private readonly cleanupErrors
  private nextCallId
  private state
  private outcomeRecorded
  private outcomeResolve
  private settleResolve
  private readonly outcomePromise
  private readonly settledPromise
  private graceTimer
  private deadlineTimer
  private disposed
  constructor(options: ControlTransportOptions)
  /** The current lifecycle state of this channel end. */
  get lifecycleState(): ControlLifecycleState
  /**
     * The first terminal outcome, exactly once: a `done` frame's value or the
     * failure that ended the execution. A channel disposed before terminating
     * never settles this promise.
     * @returns the recorded outcome.
     */
  outcome(): Promise<ControlOutcome>
  /**
     * Call one target on the peer and await its reply.
     * @param target - fully-qualified invocation target.
     * @param args - JSON-safe call arguments.
     * @param options - per-call reply timeout.
     * @returns the reply's success value.
     * @throws {@link ControlCallError} when the reply reports failure, the
     * per-call timeout expires, or the channel terminated first.
     */
  call<T = unknown>(target: string, args?: readonly unknown[], options?: ControlCallOptions): Promise<T>
  /**
     * Send one bounded progress line to the peer.
     * @param text - bounded human-readable progress text.
     */
  sendLog(text: string): void
  /**
     * Report one declared bound to the peer.
     * @param limit - the bound this end hit.
     */
  sendLimit(limit: ControlLimitFrame['limit']): void
  /**
     * Send this end's terminal outcome to the peer: the executor side of a
     * controlled execution reports its completion value or failure as one
     * `done` frame, which the peer's transport records as its outcome. Sending
     * does not settle THIS end's own lifecycle — the executor ends through
     * disposal or peer closure, so the frame is dropped once this end already
     * terminated.
     * @param outcome - the completion value, or the failure that ended the run.
     */
  sendDone(outcome: ControlDonePayload): void
  /**
     * Cancel the execution from the caller side: the terminal outcome becomes
     * an `abort` failure unless a first outcome was already recorded.
     * @param reason - why the caller cancelled.
     */
  cancel(reason: string): void
  /**
     * Resolves once the peer has settled after the terminal outcome: the
     * writable finished, the readable ended, and any close-grace escalation
     * completed. Marks the lifecycle `quiescent`.
     */
  waitSettled(): Promise<void>
  /**
     * Final resource cleanup. Cancels a still-running channel first, then
     * releases timers and listeners and walks the lifecycle to `cleaned-up`.
     * Forced settlement: a peer that ignores the close does not hold cleanup
     * hostage — cooperative settlement is {@link waitSettled}.
     * @returns notes describing every cleanup error; empty when cleanup was clean.
     */
  dispose(): Promise<readonly string[]>
  private releaseResources
  private receive
  private dispatch
  private dispatchReply
  private serveCall
  private terminateFromDone
  private terminate
  private recordOutcome
  private beginClose
  private checkSettled
  private send
  private transition
}
/**
 * Exhaustiveness helper for the closed control-frame union.
 * @param value - the unreachable frame variant.
 * @param context - where the unreachable variant surfaced.
 * @returns never — always throws.
 */
export declare function assertNever(value: never, context: string): never
//# sourceMappingURL=transport.d.ts.map
