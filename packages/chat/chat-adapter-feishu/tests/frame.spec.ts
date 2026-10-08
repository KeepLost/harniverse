/** Frame codec: byte-identical to the vendor protobuf layout, and strict about malformed input. */

import { describe, expect, it } from 'vitest'
import { decodeFrame, encodeFrame, type Frame } from '../src/frame.ts'

// Bytes produced by protobufjs for the pbbp2.Frame layout of @larksuiteoapi/node-sdk 1.73.0.
const PING_HEX = '08001000180720002a0c0a0474797065120470696e67'
const EVENT_HEX = '0894b4e4f4cb031063180320012a0d0a047479706512056576656e742a110a0a6d6573736167655f696412036162632a080a0373756d1201312a080a037365711201303a046a736f6e420c7b22636f6465223a3230307d4a0378797a'

const ping: Frame = { SeqID: 0n, LogID: 0n, service: 7, method: 0, headers: [{ key: 'type', value: 'ping' }] }
const event: Frame = {
  SeqID: 123456789012n, LogID: 99n, service: 3, method: 1,
  headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'abc' }, { key: 'sum', value: '1' }, { key: 'seq', value: '0' }],
  payloadType: 'json', payload: new TextEncoder().encode('{"code":200}'), LogIDNew: 'xyz',
}

describe('frame codec', () => {
  it('encodes to the vendor bytes', () => {
    expect(Buffer.from(encodeFrame(ping)).toString('hex')).toBe(PING_HEX)
    expect(Buffer.from(encodeFrame(event)).toString('hex')).toBe(EVENT_HEX)
  })

  it('decodes vendor bytes', () => {
    expect(decodeFrame(Buffer.from(PING_HEX, 'hex'))).toEqual(ping)
    const decoded = decodeFrame(Buffer.from(EVENT_HEX, 'hex'))
    expect(decoded).toMatchObject({ SeqID: 123456789012n, LogID: 99n, service: 3, method: 1, payloadType: 'json', LogIDNew: 'xyz' })
    expect(new TextDecoder().decode(decoded.payload)).toBe('{"code":200}')
    expect(decoded.headers).toEqual(event.headers)
  })

  it('round-trips the payload encoding field and large ids', () => {
    const frame: Frame = { ...event, SeqID: 2n ** 63n, payloadEncoding: 'gzip' }
    expect(decodeFrame(encodeFrame(frame))).toMatchObject({ SeqID: 2n ** 63n, payloadEncoding: 'gzip' })
  })

  it('skips unknown fields of every wire type', () => {
    const bytes = Uint8Array.from([
      ...encodeFrame(ping),
      0x50, 0x05, // field 10 varint
      0x59, 1, 2, 3, 4, 5, 6, 7, 8, // field 11 fixed64
      0x62, 0x02, 0xaa, 0xbb, // field 12 length-delimited
      0x6d, 1, 2, 3, 4, // field 13 fixed32
    ])
    expect(decodeFrame(bytes)).toEqual(ping)
  })

  it('skips unknown header fields', () => {
    const header = Uint8Array.from([0x0a, 0x01, 0x6b, 0x12, 0x01, 0x76, 0x18, 0x07])
    const bytes = Uint8Array.from([0x2a, header.length, ...header])
    expect(decodeFrame(bytes).headers).toEqual([{ key: 'k', value: 'v' }])
  })

  it.each([
    ['a truncated varint', [0x08, 0x80]],
    ['a truncated field', [0x2a, 0x10, 0x01]],
    ['an unsupported wire type', [0x53]],
  ])('rejects %s', (_label, bytes) => {
    expect(() => decodeFrame(Uint8Array.from(bytes))).toThrow(RangeError)
  })
})
