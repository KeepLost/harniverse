/**
 * Length-prefixed JSON frame codec with byte bounds and queued-write
 * backpressure, plus the pending-call gate. Pure buffer logic — transport
 * attachment belongs to the PTC/SSH providers.
 *
 * @module @deepseek-ai/dsh-control-channel
 */

import type { ControlChannelLimits, ControlFrame } from './types.ts'
import { DEFAULT_CONTROL_CHANNEL_LIMITS } from './types.ts'

/** Header size of one encoded frame: a 32-bit big-endian length prefix. */
const PREFIX_BYTES = 4

/** A frame violated the codec contract (oversized or malformed). */
export class ControlProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ControlProtocolError'
  }
}

/**
 * Encode one frame as `length-prefix + JSON`, refusing frames whose encoded
 * size exceeds `limits.maxFrameBytes` — frames are refused, never split.
 * @param frame - the frame to encode.
 * @param limits - bounds to enforce; defaults when omitted.
 * @returns the encoded bytes.
 * @throws {@link ControlProtocolError} when the frame exceeds the byte bound.
 */
export function encodeControlFrame(frame: ControlFrame, limits: ControlChannelLimits = DEFAULT_CONTROL_CHANNEL_LIMITS): Buffer {
  const body = Buffer.from(JSON.stringify(frame), 'utf8')
  if (PREFIX_BYTES + body.byteLength > limits.maxFrameBytes) {
    throw new ControlProtocolError(`control frame (${frame.kind}) encodes to ${PREFIX_BYTES + body.byteLength} bytes, above maxFrameBytes ${limits.maxFrameBytes}`)
  }
  const head = Buffer.alloc(PREFIX_BYTES)
  head.writeUInt32BE(body.byteLength, 0)
  return Buffer.concat([head, body])
}

/**
 * Incremental decoder for a byte stream of length-prefixed frames. Feed
 * arbitrary chunks; complete frames surface in order. A declared or buffered
 * frame above `maxFrameBytes` fails the channel: the peer violated the
 * contract and partial continuation would be guesswork.
 */
export class ControlFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0)

  constructor(private readonly limits: ControlChannelLimits = DEFAULT_CONTROL_CHANNEL_LIMITS) {}


  /**
   * Feed one chunk and return every complete frame it completes.
   * @param chunk - bytes read from the channel.
   * @returns decoded frames in arrival order.
   * @throws {@link ControlProtocolError} on an oversized or malformed frame.
   */
  feed(chunk: Buffer): ControlFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const frames: ControlFrame[] = []
    while (this.buffer.length >= PREFIX_BYTES) {
      const declared = this.buffer.readUInt32BE(0)
      if (PREFIX_BYTES + declared > this.limits.maxFrameBytes) {
        throw new ControlProtocolError(`peer declared a ${PREFIX_BYTES + declared}-byte frame, above maxFrameBytes ${this.limits.maxFrameBytes}`)
      }
      if (this.buffer.length < PREFIX_BYTES + declared) break
      const body = this.buffer.subarray(PREFIX_BYTES, PREFIX_BYTES + declared)
      this.buffer = this.buffer.subarray(PREFIX_BYTES + declared)
      frames[frames.length] = this.parse(body)
    }
    return frames
  }

  private parse(body: Buffer): ControlFrame {
    let parsed: unknown
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch (cause) {
      throw new ControlProtocolError('frame body is not valid JSON', { cause })
    }
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as ControlFrame).kind !== 'string') {
      throw new ControlProtocolError('frame body is not a control frame (missing kind)')
    }
    return parsed as ControlFrame
  }
}

/** Queued-write accounting with bounded total bytes: the send-side backpressure. */
export class ControlSendQueue {
  private queued = 0

  constructor(private readonly limits: ControlChannelLimits = DEFAULT_CONTROL_CHANNEL_LIMITS) {}

  /**
   * Reserve space for one encoded frame, refusing the send when it would push
   * queued bytes above `maxQueuedBytes` — bounded queued writes, applied at
   * the operation that makes the decision.
   * @param encoded - the frame's encoded size, from {@link encodeControlFrame}.
   * @returns a releaser to call once the bytes are handed to the transport.
   * @throws {@link ControlProtocolError} when the queued bound would overflow.
   */
  reserve(encoded: number): () => void {
    if (this.queued + encoded > this.limits.maxQueuedBytes) {
      throw new ControlProtocolError(`send queue would hold ${this.queued + encoded} bytes, above maxQueuedBytes ${this.limits.maxQueuedBytes}`)
    }
    this.queued += encoded
    return () => {
      this.queued -= encoded
    }
  }

  /** Bytes currently waiting in the queue. */
  get queuedBytes(): number {
    return this.queued
  }
}

/** Captured at module load: this library also runs INSIDE hostile child
 *  processes whose programs may rebind or delete the global constructors —
 *  accounting must never consult a prototype the program armed. */
const intrinsicObjectCreate = Object.create

/** Pending-reply accounting with a bounded call count. */
export class PendingCallGate {
  // Null-prototype membership table: plain property semantics, no Set.
  private readonly pending = intrinsicObjectCreate(null) as Record<number, true>
  private count = 0

  constructor(private readonly limits: ControlChannelLimits = DEFAULT_CONTROL_CHANNEL_LIMITS) {}

  /**
   * Admit one call id, refusing it when `maxPendingCalls` replies are
   * already outstanding.
   * @param id - the call's correlation id.
   * @throws {@link ControlProtocolError} when the pending bound would overflow or the id is already pending.
   */
  acquire(id: number): void {
    if (this.pending[id] === true) {
      throw new ControlProtocolError(`call id ${id} is already pending`)
    }
    if (this.count >= this.limits.maxPendingCalls) {
      throw new ControlProtocolError(`${this.limits.maxPendingCalls} calls await replies, above maxPendingCalls`)
    }
    this.pending[id] = true
    this.count += 1
  }

  /**
   * Release one call id when its reply arrived.
   * @param id - the call's correlation id.
   */
  release(id: number): void {
    if (this.pending[id] === true) {
      // oxlint-disable-next-line typescript/no-dynamic-delete -- null-proto table by design (hostile-child hardening)
      delete this.pending[id]
      this.count -= 1
    }
  }

  /** Calls currently awaiting a reply. */
  get size(): number {
    return this.count
  }
}
