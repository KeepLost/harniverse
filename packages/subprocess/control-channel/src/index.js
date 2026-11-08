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
export { ControlFrameDecoder, ControlProtocolError, ControlSendQueue, encodeControlFrame, PendingCallGate, } from "./codec.js";
export { assertControlTransition, canTransitionControlLifecycle, ControlLifecycleError, isTerminalControlState, } from "./lifecycle.js";
export { assertNever, ControlCallError, ControlChannelTransport } from "./transport.js";
export { DEFAULT_CONTROL_CHANNEL_LIMITS } from "./types.js";
//# sourceMappingURL=index.js.map