/**
 * Length-prefixed JSON frame codec for the micro-VM control channel.
 *
 * Frame layout: 4-byte big-endian payload length, then that many bytes of
 * UTF-8 JSON. `FrameReader` accepts arbitrary socket chunk boundaries and
 * rejects oversized frames before buffering them.
 * @module @deepseek-ai/dsh-vm-qemu-local
 */

/** Largest payload a frame may carry; longer prefixes are rejected without buffering. */
export const MAX_FRAME_BYTES = 1 << 20

/** Raised when a frame length prefix exceeds {@link MAX_FRAME_BYTES}. */
export class FrameTooLargeError extends Error {
  constructor(public readonly declaredLength: number) {
    super(`frame length ${declaredLength} exceeds limit ${MAX_FRAME_BYTES}`)
    this.name = 'FrameTooLargeError'
  }
}

/** Raised when a frame declares an empty payload. */
export class EmptyFrameError extends Error {
  constructor() {
    super('frame length must be at least 1')
    this.name = 'EmptyFrameError'
  }
}

/**
 * Encode one JSON payload as a wire frame.
 * @param payload - JSON text to carry.
 * @returns the framed bytes: 4-byte big-endian length plus the payload.
 */
export function encodeFrame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

/**
 * Incremental frame decoder over arbitrary chunk boundaries.
 */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0)

  /**
   * Feed one socket chunk and drain every complete frame it completes.
   * @param chunk - bytes received from the socket.
   * @returns decoded UTF-8 payloads, in arrival order.
   * @throws FrameTooLargeError when a pending prefix exceeds the limit.
   * @throws EmptyFrameError when a frame declares zero payload bytes.
   */
  push(chunk: Buffer): string[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const payloads: string[] = []
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0)
      if (length > MAX_FRAME_BYTES) throw new FrameTooLargeError(length)
      if (length < 1) throw new EmptyFrameError()
      if (this.buffer.length < 4 + length) break
      payloads.push(this.buffer.subarray(4, 4 + length).toString('utf8'))
      this.buffer = this.buffer.subarray(4 + length)
    }
    return payloads
  }
}
