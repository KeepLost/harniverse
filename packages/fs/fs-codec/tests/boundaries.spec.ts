/**
 * UTF-8 boundary-walk arms, round-trip mismatch shapes, display fallbacks,
 * and the mixed-output newline edge.
 */
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { decodeOutputWindow, displayEncoding, sniffAndDecode, utf8BoundaryEnd } from '@deepseek-ai/dsh-fs-codec'

describe('utf8BoundaryEnd', () => {
  it('returns zero for an empty buffer', () => {
    expect(utf8BoundaryEnd(Buffer.alloc(0))).toBe(0)
  })

  it('keeps a trailing multi-byte lead byte unconsumed and releases ASCII', () => {
    expect(utf8BoundaryEnd(Buffer.from([0x61, 0x62]))).toBe(2)
    expect(utf8BoundaryEnd(Buffer.from([0x61, 0x62, 0xc2]))).toBe(2)
    expect(utf8BoundaryEnd(Buffer.from([0x61, 0x62, 0xe0]))).toBe(2)
    expect(utf8BoundaryEnd(Buffer.from([0x61, 0x62, 0xf0]))).toBe(2)
    // 0xc0/0xc1/0xf5+ announce nothing decodable, so nothing is held for them.
    expect(utf8BoundaryEnd(Buffer.from([0x61, 0x62, 0xc0]))).toBe(3)
    expect(utf8BoundaryEnd(Buffer.from([0x61, 0x62, 0xf5]))).toBe(3)
  })

  it('walks trailing continuation runs against the announced length', () => {
    expect(utf8BoundaryEnd(Buffer.from([0x61, 0xe4, 0xb8, 0x80]))).toBe(4)
    // Complete 3-byte sequence plus a stray continuation: the run is longer
    // than announced, so the boundary stays at the buffer end.
    expect(utf8BoundaryEnd(Buffer.from([0x61, 0xe4, 0xb8, 0x80, 0x80]))).toBe(5)
    // A run whose lead announces nothing decodable holds the whole run.
    expect(utf8BoundaryEnd(Buffer.from([0xc0, 0x80]))).toBe(0)
    // A buffer that is entirely continuations holds everything.
    expect(utf8BoundaryEnd(Buffer.from([0x80, 0x80]))).toBe(0)
  })
})

describe('round-trip mismatch arms', () => {
  it('rejects a candidate whose re-encode changes byte length (Shift_JIS PUA)', () => {
    // F0 40 decodes to the Shift_JIS user zone but re-encodes to '?'.
    const outcome = sniffAndDecode(Buffer.from([0xf0, 0x40, 0x0a]), { priors: {}, fallbackEncodings: ['shiftjis'] })
    expect(outcome).toMatchObject({ ok: false, reason: 'none' })
  })

  it('rejects a candidate whose re-encode maps to different bytes (cp950 duplicates)', () => {
    // A4 51 decodes to 十 but re-encodes to A2 CC in cp950.
    const outcome = sniffAndDecode(Buffer.from([0xa4, 0x51, 0x0a]), { priors: {}, fallbackEncodings: ['cp950'] })
    expect(outcome).toMatchObject({ ok: false, reason: 'none' })
  })

  it('treats a recorded BOM on a non-UTF family as no BOM bytes to strip', () => {
    const outcome = sniffAndDecode(Buffer.from([0xc4, 0xe3, 0x0a]), { priors: {}, sticky: { encoding: 'gbk', bom: true } })
    expect(outcome).toMatchObject({ ok: true, decision: { encoding: 'gbk', source: 'sticky' } })
  })

  it('skips an unknown early fallback candidate and still reaches a later one', () => {
    const outcome = sniffAndDecode(Buffer.from([0xc4, 0xe3, 0x0a]), { priors: {}, fallbackEncodings: ['not-real', 'gbk'] })
    expect(outcome).toMatchObject({ ok: true, decision: { encoding: 'gbk', source: 'fallback' } })
  })

  it('gates the legacy arms on the whole buffer even when the sample passes', () => {
    const outcome = sniffAndDecode(Buffer.from([0x81, 0x00]), { priors: {}, fallbackEncodings: ['gb18030'], binarySampleBytes: 1 })
    expect(outcome).toEqual({ ok: false, reason: 'binary', candidates: [] })
  })
})

describe('displayEncoding fallbacks', () => {
  it('title-cases the windows/iso prefixes and passes other names through', () => {
    expect(displayEncoding('iso-8859-7')).toBe('Iso-8859-7')
    expect(displayEncoding('macintosh')).toBe('macintosh')
    expect(displayEncoding('koi8-r')).toBe('KOI8-R')
  })
})

describe('decodeOutputWindow — mixed newline edge', () => {
  it('keeps a newline-terminated buffer whole when the stream has not ended', () => {
    const bytes = Buffer.concat([Buffer.from('plain\n', 'utf8')])
    const result = decodeOutputWindow(bytes, { kind: 'mixed', legacy: ['gb18030'] }, { final: false })
    expect(result).toEqual({ text: 'plain\n', consumedTo: bytes.length })
  })
})
