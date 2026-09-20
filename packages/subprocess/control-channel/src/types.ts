/**
 * Types for the shared PTC/SSH control-channel contract: frames, failure
 * kinds, channel limits, and the lifecycle states one long-lived execution
 * moves through. Types only — no runtime code.
 *
 * @module @deepseek-ai/dsh-control-channel
 */

/** Host-to-program or program-to-host call over the control channel. */
export interface ControlCallFrame {
  readonly kind: 'call'
  /** Correlation id; pairs exactly one reply. */
  readonly id: number
  /** Fully-qualified invocation target (a tool or binding name). */
  readonly target: string
  /** JSON-safe call arguments. */
  readonly args: readonly unknown[]
}

/** Reply to one control call. */
export interface ControlReplyFrame {
  readonly kind: 'reply'
  readonly id: number
  /** Whether the call succeeded. */
  readonly ok: boolean
  /** JSON-safe success value; absent on failure. */
  readonly value?: unknown
  /** Failure text; absent on success. */
  readonly message?: string
}

/** Bounded human-readable progress text; never a structured result. */
export interface ControlLogFrame {
  readonly kind: 'log'
  readonly text: string
}

/** The peer hit a declared output or pending-call bound. */
export interface ControlLimitFrame {
  readonly kind: 'limit'
  readonly limit: 'output' | 'pending-calls'
}

/** Terminal outcome of the controlled execution. */
export interface ControlDoneFrame {
  readonly kind: 'done'
  /** JSON-safe success value; absent on failure. */
  readonly value?: unknown
  /** Orthogonal failure classification; absent on success. */
  readonly error?: ControlFailure
}

/** One control-channel message. */
export type ControlFrame =
  | ControlCallFrame
  | ControlReplyFrame
  | ControlLogFrame
  | ControlLimitFrame
  | ControlDoneFrame

/**
 * Orthogonal failure classification for one controlled execution. Exactly one
 * kind describes the first terminal outcome; cleanup reports separately
 * through the lifecycle states.
 *
 * - `'exception'` — the program or remote command raised.
 * - `'timeout'` — the caller-owned deadline expired.
 * - `'abort'` — the caller cancelled.
 * - `'process-exit'` — the process exited without a terminal frame.
 * - `'invalid-output'` — produced output failed validation.
 * - `'output-limit'` — the output bound truncated the run.
 * - `'protocol'` — a frame violated this contract.
 * - `'io'` — the channel transport failed.
 * - `'sandbox-unavailable'` — the requested confinement could not start.
 */
export interface ControlFailure {
  readonly kind:
    | 'exception'
    | 'timeout'
    | 'abort'
    | 'process-exit'
    | 'invalid-output'
    | 'output-limit'
    | 'protocol'
    | 'io'
    | 'sandbox-unavailable'
  readonly message: string
}

/** Bounds every channel end enforces on frames, queued writes, and pending calls. */
export interface ControlChannelLimits {
  /** Maximum encoded size of one frame; larger frames are refused, not split. */
  readonly maxFrameBytes: number
  /** Maximum total bytes waiting in the send queue; overflow refuses the send. */
  readonly maxQueuedBytes: number
  /** Maximum calls awaiting a reply; overflow refuses the call. */
  readonly maxPendingCalls: number
  /** Grace period after a close request before forced termination. */
  readonly closeGraceMs: number
}

/** Defaults aligned with the fresh-process execution budget. */
export const DEFAULT_CONTROL_CHANNEL_LIMITS: ControlChannelLimits = {
  maxFrameBytes: 1 << 20,
  maxQueuedBytes: 4 << 20,
  maxPendingCalls: 64,
  closeGraceMs: 5_000,
}

/**
 * Lifecycle of one controlled execution. The first terminal outcome —
 * `result-recorded`, `cancelled`, `timed-out`, or `channel-closed` — is
 * stable: no transition crosses terminal categories. Managed processes reach
 * `quiescent` once the process range settles, and `cleaned-up` after
 * resources are released; cleanup completes and reports independently of the
 * terminal outcome.
 */
export type ControlLifecycleState =
  | 'starting'
  | 'running'
  | 'result-recorded'
  | 'cancelled'
  | 'timed-out'
  | 'channel-closed'
  | 'quiescent'
  | 'cleaned-up'
