/**
 * The control lifecycle state machine: which transitions one controlled
 * execution may take, separating the first terminal outcome from managed
 * quiescence and final cleanup.
 *
 * @module @deepseek-ai/dsh-control-channel
 */
import type { ControlLifecycleState } from './types.ts'
/** Thrown when a lifecycle controller attempts a transition the contract forbids. */
export declare class ControlLifecycleError extends Error {
  constructor(message: string)
}
/**
 * Whether one lifecycle transition is legal.
 * @param from - the current state.
 * @param to - the proposed next state.
 * @returns whether the transition table permits the move.
 */
export declare function canTransitionControlLifecycle(from: ControlLifecycleState, to: ControlLifecycleState): boolean
/**
 * Assert one lifecycle transition, naming both states in the failure.
 * @param from - the current state.
 * @param to - the proposed next state.
 * @throws {@link ControlLifecycleError} when the transition is forbidden.
 */
export declare function assertControlTransition(from: ControlLifecycleState, to: ControlLifecycleState): void
/**
 * Whether the state records a first terminal outcome (stable, never crossed).
 * @param state - the state to test.
 * @returns whether the state is one of the four terminal categories.
 */
export declare function isTerminalControlState(state: ControlLifecycleState): boolean
//# sourceMappingURL=lifecycle.d.ts.map
