import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import iconv from 'iconv-lite'
import { decodeOutputWindow } from '@deepseek-ai/dsh-fs-codec'

const UTF8_LINE = 'ascii line\n'
const GBK_LINE = '老机器输出行\n'

describe('decodeOutputWindow — utf-8 spec', () => {
  it('decodes a complete window byte-identically to toString', () => {
    const buffer = Buffer.from(UTF8_LINE + 'héllo\n', 'utf8')
    expect(decodeOutputWindow(buffer, { kind: 'utf-8' }, { final: true }))
      .toEqual({ text: buffer.toString('utf8'), consumedTo: buffer.length })
  })

  it('holds back an incomplete trailing sequence for the next read', () => {
    const buffer = Buffer.concat([Buffer.from('héllo\n', 'utf8'), Buffer.from([0xc3])])
    const result = decodeOutputWindow(buffer, { kind: 'utf-8' }, { final: false })
    expect(result.consumedTo).toBe(buffer.length - 1)
    expect(result.text).toBe('héllo\n')
  })

  it('decodes everything lossily once the stream has ended', () => {
    const buffer = Buffer.concat([Buffer.from('héllo\n', 'utf8'), Buffer.from([0xc3])])
    const result = decodeOutputWindow(buffer, { kind: 'utf-8' }, { final: true })
    expect(result).toEqual({ text: buffer.toString('utf8'), consumedTo: buffer.length })
  })

  it('handles an empty window', () => {
    expect(decodeOutputWindow(Buffer.alloc(0), { kind: 'utf-8' }, { final: false })).toEqual({ text: '', consumedTo: 0 })
  })
})

describe('decodeOutputWindow — mixed spec', () => {
  const legacy = ['gb18030']

  it('keeps valid UTF-8 lines as UTF-8 and falls back only for invalid lines', () => {
    const buffer = Buffer.concat([Buffer.from(UTF8_LINE, 'utf8'), iconv.encode(GBK_LINE, 'gb18030')])
    const result = decodeOutputWindow(buffer, { kind: 'mixed', legacy }, { final: true })
    expect(result.text).toBe(UTF8_LINE + GBK_LINE)
    expect(result.consumedTo).toBe(buffer.length)
  })

  it('tries legacy pages in order and falls back to lossy UTF-8 when none decode', () => {
    // A GB18030 4-byte sequence decodes in gb18030 but vetoes in big5, so the
    // first legacy page falls through to the second.
    const bytes = Buffer.concat([iconv.encode('\u{20000}', 'gb18030'), Buffer.from('\n')])
    const result = decodeOutputWindow(bytes, { kind: 'mixed', legacy: ['big5', 'gb18030'] }, { final: true, alignedSlice: true })
    expect(result.text).toBe('\u{20000}\n')
    const none = decodeOutputWindow(Buffer.from([0x81, 0x7f, 0x0a]), { kind: 'mixed', legacy: [] }, { final: true })
    expect(none.text).toBe(Buffer.from([0x81, 0x7f, 0x0a]).toString('utf8'))
  })

  it('does not fall back for a foreign slice that starts mid-character', () => {
    const whole = Buffer.concat([iconv.encode('你好\n', 'gb18030')])
    // Slice inside the two-byte character: the fragment starts with a continuation byte.
    const sliced = whole.subarray(1)
    const foreign = decodeOutputWindow(sliced, { kind: 'mixed', legacy }, { final: true })
    expect(foreign.text).toBe(sliced.toString('utf8'))
    // The same window reached through this decoder's own aligned offset is a
    // legitimate GB18030 lead byte, so the legacy page applies.
    const gbLead = Buffer.concat([iconv.encode('老', 'gb18030').subarray(0, 1), Buffer.from([0xbd, 0x41, 0x0a])])
    const aligned = decodeOutputWindow(gbLead, { kind: 'mixed', legacy }, { final: true, alignedSlice: true })
    expect(aligned.text).toBe(iconv.decode(Buffer.concat([iconv.encode('老', 'gb18030').subarray(0, 1), Buffer.from([0xbd])]), 'gb18030') + 'A\n')
  })

  it('holds back an unterminated trailing line that is not valid UTF-8', () => {
    const buffer = Buffer.concat([Buffer.from(UTF8_LINE, 'utf8'), iconv.encode('老机器', 'gb18030').subarray(0, 1)])
    const result = decodeOutputWindow(buffer, { kind: 'mixed', legacy }, { final: false })
    expect(result.consumedTo).toBe(UTF8_LINE.length)
    expect(result.text).toBe(UTF8_LINE)
  })

  it('emits a trailing line that already is valid UTF-8', () => {
    const buffer = Buffer.concat([Buffer.from(UTF8_LINE, 'utf8'), Buffer.from('tail so far', 'utf8')])
    const result = decodeOutputWindow(buffer, { kind: 'mixed', legacy }, { final: false })
    expect(result.text).toBe(UTF8_LINE + 'tail so far')
    expect(result.consumedTo).toBe(buffer.length)
  })

  it('reassembles a GB18030 4-byte sequence straddling incremental reads', () => {
    const text = 'x'.repeat(65_533) + '𠀀' + 'y'.repeat(100)
    const bytes = iconv.encode(text, 'gb18030')
    // First read covers the first 65,535 bytes; the 4-byte sequence is incomplete there.
    const first = decodeOutputWindow(bytes.subarray(0, 65_535), { kind: 'mixed', legacy }, { final: false })
    const second = decodeOutputWindow(bytes.subarray(first.consumedTo), { kind: 'mixed', legacy }, { final: true })
    expect(first.text + second.text).toBe(text)
  })
})
