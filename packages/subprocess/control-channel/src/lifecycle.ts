/**
 * The control lifecycle state machine: which transitions one controlled
 * execution may take, separating the first terminal outcome from managed
 * quiescence and final cleanup.
 *
 * @module @deepseek-ai/dsh-control-channel
 */

import type { ControlLifecycleState } from './types.ts'

/** Thrown when a lifecycle controller attempts a transition the contract forbids. */
export class ControlLifecycleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ControlLifecycleError'
  }
}

/**
 * Legal transitions. The first terminal outcome — `result-recorded`,
 * `cancelled`, `timed-out`, `channel-closed` — is stable: terminal categories
 * never cross. Terminal states reach `quiescent` once the managed process
 * range settles, and only `quiescent` reaches `cleaned-up`, so cleanup always
 * completes and reports after the outcome it follows. `starting` may reach
 * `cleaned-up` directly for an execution that never ran.
 */
const TRANSITIONS: Readonly<Record<ControlLifecycleState, readonly ControlLifecycleState[]>> = {
  'starting': ['running', 'cancelled', 'channel-closed', 'cleaned-up'],
  'running': ['result-recorded', 'cancelled', 'timed-out', 'channel-closed'],
  'result-recorded': ['quiescent'],
  'cancelled': ['quiescent'],
  'timed-out': ['quiescent'],
  'channel-closed': ['quiescent'],
  'quiescent': ['cleaned-up'],
  'cleaned-up': [],
}

/** Whether one lifecycle transition is legal. */
export function canTransitionControlLifecycle(from: ControlLifecycleState, to: ControlLifecycleState): boolean {
  return TRANSITIONS[from].includes(to)
}

/**
 * Assert one lifecycle transition, naming both states in the failure.
 * @throws {@link ControlLifecycleError} when the transition is forbidden.
 */
export function assertControlTransition(from: ControlLifecycleState, to: ControlLifecycleState): void {
  if (!canTransitionControlLifecycle(from, to)) {
    throw new ControlLifecycleError(`control lifecycle cannot transition ${from} -> ${to}`)
  }
}

/** Whether the state records a first terminal outcome (stable, never crossed). */
export function isTerminalControlState(state: ControlLifecycleState): boolean {
  return state === 'result-recorded' || state === 'cancelled' || state === 'timed-out' || state === 'channel-closed'
}
