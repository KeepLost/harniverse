/**
 * Length-prefixed JSON frame codec with byte bounds and queued-write
 * backpressure, plus the pending-call gate. Pure buffer logic — transport
 * attachment belongs to the PTC/SSH providers.
 *
 * @module @deepseek-ai/dsh-control-channel
 */
import type { ControlChannelLimits, ControlFrame } from './types.ts'
/** A frame violated the codec contract (oversized or malformed). */
export declare class ControlProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions)
}
/**
 * Encode one frame as `length-prefix + JSON`, refusing frames whose encoded
 * size exceeds `limits.maxFrameBytes` — frames are refused, never split.
 * @param frame - the frame to encode.
 * @param limits - bounds to enforce; defaults when omitted.
 * @returns the encoded bytes.
 * @throws {@link ControlProtocolError} when the frame exceeds the byte bound.
 */
export declare function encodeControlFrame(frame: ControlFrame, limits?: ControlChannelLimits): Buffer
/**
 * Incremental decoder for a byte stream of length-prefixed frames. Feed
 * arbitrary chunks; complete frames surface in order. A declared or buffered
 * frame above `maxFrameBytes` fails the channel: the peer violated the
 * contract and partial continuation would be guesswork.
 */
export declare class ControlFrameDecoder {
  private buffer
  private readonly limits
  constructor(limits?: ControlChannelLimits)
  /**
     * Feed one chunk and return every complete frame it completes.
     * @param chunk - bytes read from the channel.
     * @returns decoded frames in arrival order.
     * @throws {@link ControlProtocolError} on an oversized or malformed frame.
     */
  feed(chunk: Buffer): ControlFrame[]
  private parse
}
/** Queued-write accounting with bounded total bytes: the send-side backpressure. */
export declare class ControlSendQueue {
  private queued
  private readonly limits
  constructor(limits?: ControlChannelLimits)
  /**
     * Reserve space for one encoded frame, refusing the send when it would push
     * queued bytes above `maxQueuedBytes` — bounded queued writes, applied at
     * the operation that makes the decision.
     * @param encoded - the frame's encoded size, from {@link encodeControlFrame}.
     * @returns a releaser to call once the bytes are handed to the transport.
     * @throws {@link ControlProtocolError} when the queued bound would overflow.
     */
  reserve(encoded: number): () => void
  /** Bytes currently waiting in the queue. */
  get queuedBytes(): number
}
/** Pending-reply accounting with a bounded call count. */
export declare class PendingCallGate {
  private readonly pending
  private count
  private readonly limits
  constructor(limits?: ControlChannelLimits)
  /**
     * Admit one call id, refusing it when `maxPendingCalls` replies are
     * already outstanding.
     * @param id - the call's correlation id.
     * @throws {@link ControlProtocolError} when the pending bound would overflow or the id is already pending.
     */
  acquire(id: number): void
  /**
     * Release one call id when its reply arrived.
     * @param id - the call's correlation id.
     */
  release(id: number): void
  /** Calls currently awaiting a reply. */
  get size(): number
}
//# sourceMappingURL=codec.d.ts.map
