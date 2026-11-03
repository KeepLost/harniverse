import { describe, expect, it } from 'vitest'
import { EmptyFrameError, FrameReader, FrameTooLargeError, MAX_FRAME_BYTES, encodeFrame } from '../src/frame.ts'

describe('vm-qemu-local frame codec', () => {
  it('round-trips one JSON payload', () => {
    const reader = new FrameReader()
    expect(reader.push(encodeFrame('{"t":"ping","n":7}'))).toEqual(['{"t":"ping","n":7}'])
  })

  it('reassembles a frame split across arbitrary chunk boundaries', () => {
    const frame = encodeFrame('{"t":"hello"}')
    const reader = new FrameReader()
    const payloads: string[] = []
    for (const byte of frame) {
      payloads.push(...reader.push(Buffer.from([byte])))
    }
    expect(payloads).toEqual(['{"t":"hello"}'])
  })

  it('delivers two frames arriving in one chunk in order', () => {
    const reader = new FrameReader()
    const combined = Buffer.concat([encodeFrame('{"a":1}'), encodeFrame('{"b":2}')])
    expect(reader.push(combined)).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('carries multibyte UTF-8 payloads intact', () => {
    const reader = new FrameReader()
    const payload = '{"label":"微虚拟机"}'
    expect(reader.push(encodeFrame(payload))).toEqual([payload])
  })

  it('rejects an oversized length prefix before buffering the body', () => {
    const reader = new FrameReader()
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    expect(() => reader.push(prefix)).toThrow(FrameTooLargeError)
  })

  it('rejects a zero-length frame prefix', () => {
    const reader = new FrameReader()
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32BE(0, 0)
    expect(() => reader.push(prefix)).toThrow(EmptyFrameError)
  })

  it('keeps a partial prefix buffered until the body completes', () => {
    const reader = new FrameReader()
    expect(reader.push(encodeFrame('{"t":"pong","n":1}').subarray(0, 5))).toEqual([])
    expect(reader.push(encodeFrame('{"t":"pong","n":1}').subarray(5))).toEqual(['{"t":"pong","n":1}'])
  })
})
