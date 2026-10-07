/**
 * Locale/prior mapping tables: POSIX parsing arms, charset and language
 * priors, and the OEM/ANSI output list.
 */
import { describe, expect, it } from 'vitest'
import { hostPriors, hostPriorsSync, hostFilePrior, localeLanguagePrior, outputLegacyForCodePage, bomBytesFor, sniffAndDecode } from '@deepseek-ai/dsh-fs-codec'

describe('hostPriorsSync — POSIX locale parsing', () => {
  it('parses language, territory, and charset arms', () => {
    expect(hostPriorsSync({ platform: 'linux', env: { LC_ALL: 'zh' } })).toEqual({ localeLanguage: 'zh' })
    expect(hostPriorsSync({ platform: 'linux', env: { LC_CTYPE: 'en_US' } })).toEqual({ localeLanguage: 'en', localeTerritory: 'US' })
    expect(hostPriorsSync({ platform: 'linux', env: { LANG: '.gbk' } })).toEqual({ localeCharset: 'gbk' })
    expect(hostPriorsSync({ platform: 'linux', env: { LC_ALL: 'POSIX' } })).toEqual({})
    expect(hostPriorsSync({ platform: 'linux', env: { LC_ALL: '' } })).toEqual({})
    expect(hostPriorsSync({ platform: 'linux', env: {} })).toEqual({})
  })
})

describe('hostPriors — POSIX locale precedence', () => {
  it('falls through LC_ALL to LC_CTYPE to LANG to nothing', async () => {
    expect(await hostPriors({ platform: 'linux', env: { LC_CTYPE: 'ru_RU.koi8r' } }))
      .toEqual({ localeCharset: 'koi8r', localeLanguage: 'ru', localeTerritory: 'RU' })
    expect(await hostPriors({ platform: 'linux', env: { LANG: 'ja_JP.UTF-8' } }))
      .toEqual({ localeCharset: 'utf-8', localeLanguage: 'ja', localeTerritory: 'JP' })
    expect(await hostPriors({ platform: 'linux', env: {} })).toEqual({})
  })
})

describe('bare no-dependency resolution', () => {
  it('reads the ambient platform and environment', async () => {
    const beforeWarm = hostPriorsSync()
    expect(typeof beforeWarm).toBe('object')
    const resolved = await hostPriors()
    if (process.platform === 'win32') {
      // Windows reads GetACP/GetOEMCP through koffi, so the sync form is `{}`
      // until the async form has warmed the cache, and the async form returns
      // the machine's numeric code pages (or `{}` for a UTF-8 ACP / koffi miss).
      // Locale environment variables are never consulted there.
      expect(Object.keys(resolved).every(key => key === 'acp' || key === 'oemcp')).toBe(true)
      if (resolved.acp !== undefined) {
        expect(Number.isInteger(resolved.acp)).toBe(true)
        expect(Number.isInteger(resolved.oemcp)).toBe(true)
        expect(hostPriorsSync()).toEqual(resolved)
      }
    } else {
      // POSIX parses the same environment synchronously and asynchronously.
      expect(resolved).toEqual(beforeWarm)
      expect(hostPriorsSync()).toEqual(resolved)
    }
  })

  it('falls back to the process environment for the POSIX branch on every host', async () => {
    // Forcing the POSIX branch keeps the ambient-env fallback covered on
    // Windows too, where the unforced call takes the Win32 branch instead.
    expect(hostPriorsSync({ platform: 'linux' })).toEqual(hostPriorsSync({ platform: 'linux', env: process.env }))
    expect(await hostPriors({ platform: 'linux' })).toEqual(await hostPriors({ platform: 'linux', env: process.env }))
  })
})

describe('hostFilePrior — charset spelling table', () => {
  it('keeps the CJK territory distinctions on the legacy-charset path', () => {
    expect(hostFilePrior({ localeCharset: 'big5', localeLanguage: 'zh', localeTerritory: 'TW' })).toBe('big5')
    expect(hostFilePrior({ localeCharset: 'big5', localeLanguage: 'zh', localeTerritory: 'MO' })).toBe('big5')
    expect(hostFilePrior({ localeCharset: 'big5', localeLanguage: 'zh', localeTerritory: 'CN' })).toBe('gb18030')
  })

  it('maps the POSIX spellings onto iconv names', () => {
    const spellings: [string, string | undefined][] = [
      ['gb2312', 'gb18030'], ['euccn', 'gb18030'], ['big5hkscs', 'big5'], ['pck', 'shiftjis'],
      ['ujis', 'eucjp'], ['koi8-r', 'koi8-r'], ['cp1251', 'windows-1251'], ['windows-1251', 'windows-1251'],
      ['iso88591', 'iso-8859-1'], ['iso-8859-1', 'iso-8859-1'], ['iso88592', 'iso-8859-2'],
      ['iso-8859-5', 'iso-8859-5'], ['iso885915', 'iso-8859-15'], ['not-a-charset', undefined],
    ]
    for (const [charset, expected] of spellings) {
      expect(hostFilePrior({ localeCharset: charset })).toBe(expected)
    }
  })
})

describe('localeLanguagePrior — language table arms', () => {
  it('covers the regional single-byte families', () => {
    const cases: [string, string | undefined][] = [
      ['be', 'windows-1251'], ['bg', 'windows-1251'], ['uk', 'windows-1251'],
      ['hr', 'windows-1250'], ['hu', 'windows-1250'], ['ro', 'windows-1250'], ['sk', 'windows-1250'],
      ['sl', 'windows-1250'], ['sq', 'windows-1250'], ['en', 'windows-1252'], ['fr', 'windows-1252'],
      ['de', 'windows-1252'], ['pt', 'windows-1252'], ['sv', 'windows-1252'], ['eu', 'windows-1252'],
      ['xx', undefined],
    ]
    for (const [language, expected] of cases) {
      expect(localeLanguagePrior({ localeCharset: 'utf-8', localeLanguage: language })).toBe(expected)
    }
    expect(localeLanguagePrior({ localeCharset: 'gbk', localeLanguage: 'ru' })).toBeUndefined()
  })
})

describe('outputLegacyForCodePage — OEM table arms', () => {
  it('maps OEM console pages and dedupes against the ANSI page', () => {
    for (const codePage of [437, 720, 737, 775, 850, 852, 855, 857, 858, 860, 861, 862, 863, 864, 865, 866, 869, 874, 875]) {
      expect(outputLegacyForCodePage(codePage, undefined).length).toBe(1)
    }
    expect(outputLegacyForCodePage(867, undefined)).toEqual([])
    expect(outputLegacyForCodePage(936, 936)).toEqual(['gb18030'])
    expect(outputLegacyForCodePage(1252, 1252)).toEqual(['windows-1252'])
    expect(outputLegacyForCodePage(65001, undefined)).toEqual([])
  })
})

describe('remaining decode arms', () => {
  it('bomBytesFor finds each family and rejects others', () => {
    expect(bomBytesFor('utf-8')).toEqual(Uint8Array.of(0xef, 0xbb, 0xbf))
    expect(bomBytesFor('utf-16le')).toEqual(Uint8Array.of(0xff, 0xfe))
    expect(bomBytesFor('utf-16be')).toEqual(Uint8Array.of(0xfe, 0xff))
    expect(bomBytesFor('gb18030')).toBeUndefined()
  })

  it('falls through a BOM whose family cannot decode the bytes', () => {
    // UTF-16LE BOM with a dangling half code unit: the BOM candidate vetoes,
    // strict UTF-8 fails, and no priors exist, so the walk rejects.
    const outcome = sniffAndDecode(Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x62]), { priors: {} })
    expect(outcome).toMatchObject({ ok: false, reason: 'none' })
  })

  it('dedupes a fallback naming the host prior and skips unknown fallback names', () => {
    const bytes = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a])
    expect(sniffAndDecode(bytes, { priors: { localeCharset: 'gbk' }, fallbackEncodings: ['gb18030', 'not-real'] }))
      .toMatchObject({ ok: true, decision: { source: 'host', encoding: 'gb18030' } })
  })

  it('drops a sticky decision that fails the byte round-trip', () => {
    // cp950 maps A4 51 to a character that re-encodes to different bytes.
    const outcome = sniffAndDecode(Buffer.from([0xa4, 0x51, 0x0a]), { priors: {}, sticky: { encoding: 'cp950', bom: false } })
    expect(outcome).toMatchObject({ ok: false, reason: 'none' })
  })
})
