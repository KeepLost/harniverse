import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import iconv from 'iconv-lite'
import {
  decodeStrict,
  encodeForWrite,
  encodingAnnotation,
  encodingExists,
  sniffAndDecode,
  sniffBom,
  suggestEncodings,
} from '@deepseek-ai/dsh-fs-codec'

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

function gbk(text: string): Buffer {
  return iconv.encode(text, 'gbk')
}

describe('sniffBom', () => {
  it('recognizes the three byte order marks', () => {
    expect(sniffBom(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toEqual({ encoding: 'utf-8', bom: true })
    expect(sniffBom(Buffer.from([0xff, 0xfe, 0x61, 0x00]))).toEqual({ encoding: 'utf-16le', bom: true })
    expect(sniffBom(Buffer.from([0xfe, 0xff, 0x00, 0x61]))).toEqual({ encoding: 'utf-16be', bom: true })
    expect(sniffBom(Buffer.from([0xef, 0xbb, 0x00]))).toBeUndefined()
  })
})

describe('decodeStrict', () => {
  it('decodes clean bytes and vetoes any U+FFFD', () => {
    expect(decodeStrict(gbk('你好，世界'), 'gb18030')).toBe('你好，世界')
    expect(decodeStrict(Buffer.from([0x81, 0x7f]), 'gb18030')).toBeUndefined()
    expect(decodeStrict(Buffer.from([0x38, 0x31, 0x20, 0xff]), 'utf-8')).toBeUndefined()
  })
})

describe('sniffAndDecode — zero-regression boundary', () => {
  it('keeps strict UTF-8 text identical and BOM-stripped with the bom flag set', () => {
    const outcome = sniffAndDecode(Buffer.concat([UTF8_BOM, Buffer.from('héllo\r\nwo\r\nrld\n')]), { priors: {} })
    expect(outcome).toMatchObject({
      ok: true,
      text: 'héllo\r\nwo\r\nrld\n',
      decision: { encoding: 'utf-8', source: 'bom', bom: true, eol: 'CRLF' },
    })
  })

  it('reports plain UTF-8 with source utf8 and LF', () => {
    const outcome = sniffAndDecode(Buffer.from('纯文本\n第二行\n'), { priors: {} })
    expect(outcome).toMatchObject({ ok: true, decision: { encoding: 'utf-8', source: 'utf8', bom: false, eol: 'LF' } })
  })

  it('rejects NUL bytes without a UTF-16 BOM as binary before any decoding', () => {
    const outcome = sniffAndDecode(Buffer.concat([gbk('你好'), Buffer.from([0x00])]), { priors: { localeCharset: 'gbk' } })
    expect(outcome).toEqual({ ok: false, reason: 'binary', candidates: [] })
  })

  it('decodes UTF-16LE with BOM even though the bytes contain NULs', () => {
    const bytes = iconv.encode('汉字文件\n', 'utf-16le')
    const outcome = sniffAndDecode(Buffer.concat([Buffer.from([0xff, 0xfe]), bytes]), { priors: {} })
    expect(outcome).toMatchObject({ ok: true, text: '汉字文件\n', decision: { encoding: 'utf-16le', source: 'bom', bom: true } })
  })

  it('decodes UTF-16BE with BOM', () => {
    const le = iconv.encode('日本語\n', 'utf-16le')
    const be = Buffer.from(le.buffer, le.byteOffset, le.byteLength).swap16()
    const outcome = sniffAndDecode(Buffer.concat([Buffer.from([0xfe, 0xff]), be]), { priors: {} })
    expect(outcome).toMatchObject({ ok: true, text: '日本語\n', decision: { encoding: 'utf-16be', bom: true } })
  })

  it('rejects BOM-less UTF-16 as binary (NUL gate)', () => {
    const outcome = sniffAndDecode(iconv.encode('ab\n', 'utf-16le'), { priors: {} })
    expect(outcome).toEqual({ ok: false, reason: 'binary', candidates: [] })
  })
})

describe('sniffAndDecode — candidate order', () => {
  const gbkBytes = gbk('老机器上的配置文件\r\n第二行\n')

  it('explicit wins first and strips a sniffed BOM before decoding', () => {
    const outcome = sniffAndDecode(gbkBytes, { explicit: 'gb18030', priors: {} })
    expect(outcome).toMatchObject({ ok: true, decision: { encoding: 'gb18030', source: 'explicit' } })
    const bommed = sniffAndDecode(Buffer.concat([UTF8_BOM, Buffer.from('内容\n')]), { explicit: 'utf-8', priors: {} })
    expect(bommed).toMatchObject({ ok: true, text: '内容\n', decision: { encoding: 'utf-8', source: 'explicit', bom: true } })
  })

  it('reports an unknown explicit name without probing', () => {
    const outcome = sniffAndDecode(Buffer.from('x'), { explicit: 'not-a-codec', priors: {} })
    expect(outcome).toEqual({ ok: false, reason: 'explicit', encoding: 'not-a-codec', candidates: [] })
  })

  it('reports an explicit name that cannot decode the bytes cleanly', () => {
    const invalid = Buffer.from([0x81, 0x7f, 0x0a])
    const outcome = sniffAndDecode(invalid, { explicit: 'gb18030', priors: {} })
    expect(outcome).toMatchObject({ ok: false, reason: 'explicit', encoding: 'gb18030' })
  })

  it('reuses a sticky decision for unchanged bytes', () => {
    const outcome = sniffAndDecode(gbkBytes, { sticky: { encoding: 'gb18030', bom: false }, priors: {} })
    expect(outcome).toMatchObject({ ok: true, decision: { encoding: 'gb18030', source: 'sticky' } })
  })

  it('keeps a sticky decision over the inherent UTF-8 ambiguity for plain legacy text', () => {
    // C3 A9 is both valid UTF-8 (é) and a complete GB18030 pair (茅): sticky wins.
    const outcome = sniffAndDecode(Buffer.from('\u00e9\n', 'utf8'), { sticky: { encoding: 'gb18030', bom: false }, priors: {} })
    expect(outcome).toMatchObject({ ok: true, decision: { encoding: 'gb18030', source: 'sticky' } })
  })

  it('drops a sticky decision when the bytes no longer decode cleanly in it', () => {
    // E2 82 AC 0A (€ + LF) is valid UTF-8 but the GB18030 read hits the invalid AC 0A pair.
    const outcome = sniffAndDecode(Buffer.from('\u20ac\n', 'utf8'), { sticky: { encoding: 'gb18030', bom: false }, priors: {} })
    expect(outcome).toMatchObject({ ok: true, decision: { encoding: 'utf-8', source: 'utf8' } })
  })

  it('uses the host code page prior on win32 facts', () => {
    const outcome = sniffAndDecode(gbkBytes, { priors: { acp: 936, oemcp: 936 } })
    expect(outcome).toMatchObject({ ok: true, decision: { encoding: 'gb18030', source: 'host' } })
  })

  it('uses the POSIX locale charset prior', () => {
    const outcome = sniffAndDecode(iconv.encode('こんにちは世界\n', 'shiftjis'), { priors: { localeCharset: 'sjis', localeLanguage: 'ja', localeTerritory: 'JP' } })
    expect(outcome).toMatchObject({ ok: true, decision: { encoding: 'shiftjis', source: 'host' } })
  })

  it('infers the language page for a UTF-8 locale', () => {
    const cp1251 = iconv.encode('Привет, мир\n', 'windows-1251')
    const outcome = sniffAndDecode(cp1251, { priors: { localeCharset: 'utf-8', localeLanguage: 'ru', localeTerritory: 'RU' } })
    expect(outcome).toMatchObject({ ok: true, decision: { encoding: 'windows-1251', source: 'locale' } })
  })

  it('prefers Big5 for zh-TW locales and GB18030 for zh-CN', () => {
    const big5 = iconv.encode('繁體中文測試\n', 'big5')
    expect(sniffAndDecode(big5, { priors: { localeCharset: 'utf-8', localeLanguage: 'zh', localeTerritory: 'TW' } }))
      .toMatchObject({ ok: true, decision: { encoding: 'big5', source: 'locale' } })
    expect(sniffAndDecode(big5, { priors: { localeCharset: 'utf-8', localeLanguage: 'zh', localeTerritory: 'CN' } }))
      .toMatchObject({ decision: { encoding: 'gb18030' } })
  })

  it('tries configured fallback encodings last, in configured order', () => {
    const big5 = iconv.encode('繁體中文測試\n', 'big5')
    const outcome = sniffAndDecode(big5, { priors: {}, fallbackEncodings: ['big5'] })
    expect(outcome).toMatchObject({ ok: true, decision: { encoding: 'big5', source: 'fallback' } })
  })

  it('skips every legacy candidate when detect is false', () => {
    const outcome = sniffAndDecode(gbkBytes, { priors: { localeCharset: 'gbk' }, detect: false })
    expect(outcome).toMatchObject({ ok: false, reason: 'none' })
  })
})

describe('sniffAndDecode — rejections', () => {
  it('lists viable probe encodings when every ordered candidate failed', () => {
    // C4 2E 43 34 0A: invalid UTF-8 (C4 needs a continuation) and invalid
    // GB18030 (trail 0x2E < 0x30), but clean windows-1252 ("Ä.C4\n").
    const outcome = sniffAndDecode(Buffer.from([0xc4, 0x2e, 0x43, 0x34, 0x0a]), { priors: { localeCharset: 'gbk', localeLanguage: 'zh', localeTerritory: 'CN' } })
    expect(outcome).toMatchObject({
      ok: false,
      reason: 'none',
      candidates: ['shiftjis', 'windows-1251', 'windows-1252', 'windows-1250', 'windows-1253', 'windows-1255', 'windows-1256', 'windows-874', 'koi8-r', 'iso-8859-15'],
    })
  })

  it('rejects a single-byte auto candidate whose decode is mostly control characters', () => {
    // 80 81 82 83 0A: invalid UTF-8; ISO-8859-x decodes to four C1 controls.
    const outcome = sniffAndDecode(Buffer.from([0x80, 0x81, 0x82, 0x83, 0x0a]), { priors: {}, fallbackEncodings: ['iso-8859-15'] })
    expect(outcome).toMatchObject({ ok: false, reason: 'none', candidates: ['windows-1251', 'windows-1256', 'koi8-r'] })
  })

  it('accepts the same bytes when the encoding is explicit (no control gate)', () => {
    const outcome = sniffAndDecode(Buffer.from([0x80, 0x81, 0x82, 0x83, 0x0a]), { explicit: 'iso-8859-15', priors: {} })
    expect(outcome).toMatchObject({ ok: true, decision: { source: 'explicit' } })
  })
})

describe('sniffAndDecode — whole-buffer GB18030 regression pin', () => {
  it('decodes a 4-byte sequence straddling the 64 KiB chunk boundary exactly once', () => {
    // iconv-lite's GB18030 streaming decoder drops a UTF-16 code unit when a
    // 4-byte sequence straddles chunk boundaries; this library only ever
    // decodes whole buffers, and this test pins that contract.
    const text = 'x'.repeat(65_533) + '𠀀' + 'y'.repeat(70_000)
    const bytes = iconv.encode(text, 'gb18030')
    const outcome = sniffAndDecode(bytes, { priors: { localeCharset: 'gbk' } })
    expect(outcome).toMatchObject({ ok: true })
    expect(outcome.ok && outcome.text).toBe(text)
  })
})

describe('encodeForWrite', () => {
  it('round-trips legacy text and reproduces UTF-family BOMs', () => {
    const gbkResult = encodeForWrite('配置内容\n', 'gb18030')
    expect(gbkResult.ok && Buffer.from(gbkResult.bytes).equals(gbk('配置内容\n'))).toBe(true)
    const utf8Bom = encodeForWrite('内容\n', 'utf-8', { bom: true })
    expect(utf8Bom.ok && Buffer.from(utf8Bom.bytes).equals(Buffer.concat([UTF8_BOM, Buffer.from('内容\n')]))).toBe(true)
    const utf16le = encodeForWrite('内容\n', 'utf-16le', { bom: true })
    expect(utf16le.ok && Buffer.from(utf16le.bytes).equals(Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode('内容\n', 'utf-16le')]))).toBe(true)
  })

  it('reports the first unmappable character with line and column, never writing ?', () => {
    const text = '第一行\n第二行 ok\nemoji \u{1f600} trailing\n'
    const result = encodeForWrite(text, 'shiftjis')
    expect(result).toEqual({
      ok: false,
      unmappable: { char: '\u{1f600}', codePoint: 0x1f600, line: 3, column: 7 },
    })
  })

  it('refuses U+FFFD itself for a legacy target', () => {
    const result = encodeForWrite('bad \ufffd char', 'gbk')
    expect(result.ok).toBe(false)
  })
})

describe('display helpers', () => {
  it('annotates only non-UTF-8 decisions', () => {
    expect(encodingAnnotation('utf-8', 'utf8')).toBeUndefined()
    expect(encodingAnnotation('utf-8', 'bom')).toBeUndefined()
    expect(encodingAnnotation('gb18030', 'host')).toBe('[Encoding: GB18030 (host code page)]')
    expect(encodingAnnotation('shiftjis', 'explicit')).toBe('[Encoding: Shift_JIS (explicit)]')
    expect(encodingAnnotation('windows-1251', 'locale')).toBe('[Encoding: Windows-1251 (inferred from locale)]')
  })

  it('suggests near-miss names for an unknown encoding', () => {
    expect(suggestEncodings('gb')).toEqual(['gb18030', 'gbk'])
    expect(suggestEncodings('UTF')).toEqual(['utf-8', 'utf-16le', 'utf-16be'])
    expect(suggestEncodings('zzz')).toEqual([])
    expect(encodingExists('utf-16le')).toBe(true)
  })
})
