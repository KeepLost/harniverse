/**
 * The shared bounded control-channel contract for PTC and SSH execution:
 * frames, codec with byte bounds and backpressure, the pending-call gate, the
 * orthogonal failure vocabulary, and the lifecycle state machine. One
 * lifecycle owner consumes this seam; ordinary shell, LSP, and child-agent
 * launches keep their simpler paths.
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
