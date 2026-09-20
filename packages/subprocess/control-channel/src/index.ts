/**
 * The shared bounded control-channel contract for PTC and SSH execution:
 * frames, codec with byte bounds and backpressure, the pending-call gate, the
 * orthogonal failure vocabulary, the lifecycle state machine, and the
 * optional stream-attached transport that drives them over one duplex pair.
 * One lifecycle owner consumes this seam; ordinary shell, LSP, and
 * child-agent launches keep their simpler paths.
 *
 * @module @deepseek-ai/dsh-control-channel
 */

export {
  ControlFrameDecoder,
  ControlProtocolError,
  ControlSendQueue,
  encodeControlFrame,
  PendingCallGate,
} from './codec.ts'
export {
  assertControlTransition,
  canTransitionControlLifecycle,
  ControlLifecycleError,
  isTerminalControlState,
} from './lifecycle.ts'
export { assertNever, ControlCallError, ControlChannelTransport } from './transport.ts'
export type {
  ControlCallOptions,
  ControlOutcome,
  ControlTransportHandlers,
  ControlTransportOptions,
} from './transport.ts'
export { DEFAULT_CONTROL_CHANNEL_LIMITS } from './types.ts'
export type {
  ControlCallFrame,
  ControlChannelLimits,
  ControlDoneFrame,
  ControlFailure,
  ControlFrame,
  ControlLimitFrame,
  ControlLifecycleState,
  ControlLogFrame,
  ControlReplyFrame,
} from './types.ts'
