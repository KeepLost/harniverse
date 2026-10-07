/**
 * Minimal protobuf codec for the Feishu long-connection `pbbp2.Frame`. The
 * message layout (field numbers and types) matches `@larksuiteoapi/node-sdk`
 * 1.73.0 (MIT License), which the protocol is derived from; see
 * THIRD_PARTY_NOTICES.md.
 * @module @deepseek-ai/dsh-chat-adapter-feishu/frame
 */

/** One frame header. */
export interface FrameHeader {
  key: string
  value: string
}

/** One long-connection frame. `method` is 0 for control frames and 1 for data frames. */
export interface Frame {
  SeqID: bigint
  LogID: bigint
  service: number
  method: number
  headers: FrameHeader[]
  payloadEncoding?: string
  payloadType?: string
  payload?: Uint8Array
  LogIDNew?: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function varint(value: bigint): number[] {
  const out: number[] = []
  let rest = value
  while (rest >= 0x80n) {
    out.push(Number(rest & 0x7fn) | 0x80)
    rest >>= 7n
  }
  out.push(Number(rest))
  return out
}

function tag(field: number, wire: 0 | 2): number[] {
  return varint(BigInt((field << 3) | wire))
}

function bytesField(field: number, data: Uint8Array): number[] {
  return [...tag(field, 2), ...varint(BigInt(data.length)), ...data]
}

/**
 * Encode a frame.
 * @param frame - frame to serialize; required fields are always written.
 * @returns protobuf bytes.
 */
export function encodeFrame(frame: Frame): Uint8Array {
  const out: number[] = [
    ...tag(1, 0), ...varint(frame.SeqID),
    ...tag(2, 0), ...varint(frame.LogID),
    ...tag(3, 0), ...varint(BigInt(frame.service)),
    ...tag(4, 0), ...varint(BigInt(frame.method)),
  ]
  for (const header of frame.headers) {
    const key = bytesField(1, encoder.encode(header.key))
    const value = bytesField(2, encoder.encode(header.value))
    out.push(...bytesField(5, Uint8Array.from([...key, ...value])))
  }
  if (frame.payloadEncoding !== undefined) out.push(...bytesField(6, encoder.encode(frame.payloadEncoding)))
  if (frame.payloadType !== undefined) out.push(...bytesField(7, encoder.encode(frame.payloadType)))
  if (frame.payload !== undefined) out.push(...bytesField(8, frame.payload))
  if (frame.LogIDNew !== undefined) out.push(...bytesField(9, encoder.encode(frame.LogIDNew)))
  return Uint8Array.from(out)
}

/** Sequential reader over protobuf bytes. */
class Reader {
  position = 0

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.position >= this.bytes.length
  }

  varint(): bigint {
    let result = 0n
    let shift = 0n
    for (;;) {
      const byte = this.bytes[this.position++]
      if (byte === undefined) throw new RangeError('truncated varint')
      result |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return result
      shift += 7n
    }
  }

  bytesValue(): Uint8Array {
    const length = Number(this.varint())
    const end = this.position + length
    if (end > this.bytes.length) throw new RangeError('truncated field')
    const slice = this.bytes.subarray(this.position, end)
    this.position = end
    return slice
  }

  skip(wire: number): void {
    if (wire === 0) this.varint()
    else if (wire === 2) this.bytesValue()
    else if (wire === 1) this.position += 8
    else if (wire === 5) this.position += 4
    else throw new RangeError(`unsupported wire type ${String(wire)}`)
  }
}

function decodeHeader(bytes: Uint8Array): FrameHeader {
  const reader = new Reader(bytes)
  const header: FrameHeader = { key: '', value: '' }
  while (!reader.done) {
    const tagValue = Number(reader.varint())
    if (tagValue === 10) header.key = decoder.decode(reader.bytesValue())
    else if (tagValue === 18) header.value = decoder.decode(reader.bytesValue())
    else reader.skip(tagValue & 7)
  }
  return header
}

/**
 * Decode a frame.
 * @param bytes - one WebSocket binary message.
 * @returns the frame.
 * @throws {RangeError} when the bytes are not a well-formed frame.
 */
export function decodeFrame(bytes: Uint8Array): Frame {
  const reader = new Reader(bytes)
  const frame: Frame = { SeqID: 0n, LogID: 0n, service: 0, method: 0, headers: [] }
  while (!reader.done) {
    const tagValue = Number(reader.varint())
    switch (tagValue >>> 3) {
      case 1: frame.SeqID = reader.varint(); break
      case 2: frame.LogID = reader.varint(); break
      case 3: frame.service = Number(reader.varint()); break
      case 4: frame.method = Number(reader.varint()); break
      case 5: frame.headers.push(decodeHeader(reader.bytesValue())); break
      case 6: frame.payloadEncoding = decoder.decode(reader.bytesValue()); break
      case 7: frame.payloadType = decoder.decode(reader.bytesValue()); break
      case 8: frame.payload = reader.bytesValue(); break
      case 9: frame.LogIDNew = decoder.decode(reader.bytesValue()); break
      default: reader.skip(tagValue & 7)
    }
  }
  return frame
}
