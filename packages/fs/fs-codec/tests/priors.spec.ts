import { describe, expect, it } from 'vitest'
import { hostPriors, hostFilePrior, localeLanguagePrior, outputLegacyForCodePage } from '@deepseek-ai/dsh-fs-codec'

describe('hostPriors', () => {
  it('resolves POSIX locale facts from LC_ALL over LC_CTYPE over LANG', async () => {
    expect(await hostPriors({ platform: 'linux', env: { LC_ALL: 'zh_CN.GBK', LC_CTYPE: 'en_US.UTF-8', LANG: 'C' } }))
      .toEqual({ localeCharset: 'gbk', localeLanguage: 'zh', localeTerritory: 'CN' })
    expect(await hostPriors({ platform: 'linux', env: { LC_CTYPE: 'ru_RU.UTF-8', LANG: 'C' } }))
      .toEqual({ localeCharset: 'utf-8', localeLanguage: 'ru', localeTerritory: 'RU' })
    expect(await hostPriors({ platform: 'linux', env: { LANG: 'C' } })).toEqual({})
    expect(await hostPriors({ platform: 'linux', env: {} })).toEqual({})
  })

  it('reads the Win32 code pages through the injectable loader and drops UTF-8 ACP', async () => {
    expect(await hostPriors({ platform: 'win32', loadWin32CodePages: () => ({ acp: 936, oemcp: 936 }) }))
      .toEqual({ acp: 936, oemcp: 936 })
    expect(await hostPriors({ platform: 'win32', loadWin32CodePages: () => ({ acp: 65001, oemcp: 437 }) })).toEqual({})
    expect(await hostPriors({ platform: 'win32', loadWin32CodePages: () => undefined })).toEqual({})
  })

  it('ignores POSIX facts on win32 and Win32 facts on POSIX', async () => {
    expect(await hostPriors({ platform: 'win32', env: { LANG: 'zh_CN.GBK' }, loadWin32CodePages: () => ({ acp: 1252, oemcp: 850 }) }))
      .toEqual({ acp: 1252, oemcp: 850 })
    expect(await hostPriors({ platform: 'linux', env: { LANG: 'zh_CN.GBK' }, loadWin32CodePages: () => ({ acp: 936, oemcp: 936 }) }))
      .toEqual({ localeCharset: 'gbk', localeLanguage: 'zh', localeTerritory: 'CN' })
  })
})

describe('hostFilePrior', () => {
  it('maps Windows ANSI code pages', () => {
    expect(hostFilePrior({ acp: 936 })).toBe('gb18030')
    expect(hostFilePrior({ acp: 950 })).toBe('big5')
    expect(hostFilePrior({ acp: 932 })).toBe('shiftjis')
    expect(hostFilePrior({ acp: 949 })).toBe('cp949')
    expect(hostFilePrior({ acp: 1251 })).toBe('windows-1251')
    expect(hostFilePrior({ acp: 1252 })).toBe('windows-1252')
    expect(hostFilePrior({ acp: 65001 })).toBeUndefined()
    expect(hostFilePrior({ acp: 437 })).toBeUndefined()
  })

  it('maps POSIX charset spellings', () => {
    expect(hostFilePrior({ localeCharset: 'gbk' })).toBe('gb18030')
    expect(hostFilePrior({ localeCharset: 'big5' })).toBe('big5')
    expect(hostFilePrior({ localeCharset: 'eucjp' })).toBe('eucjp')
    expect(hostFilePrior({ localeCharset: 'koi8-r' })).toBe('koi8-r')
    expect(hostFilePrior({ localeCharset: 'utf-8' })).toBeUndefined()
    expect(hostFilePrior({ localeCharset: 'utf-8', localeLanguage: 'ru' })).toBeUndefined()
  })

  it('keeps CJK territory distinctions in the language prior', () => {
    expect(localeLanguagePrior({ localeCharset: 'utf-8', localeLanguage: 'zh', localeTerritory: 'HK' })).toBe('big5')
    expect(localeLanguagePrior({ localeCharset: 'utf-8', localeLanguage: 'zh', localeTerritory: 'CN' })).toBe('gb18030')
    expect(localeLanguagePrior({ localeCharset: 'utf-8', localeLanguage: 'ja' })).toBe('shiftjis')
    expect(localeLanguagePrior({ localeCharset: 'utf-8', localeLanguage: 'ko' })).toBe('cp949')
    expect(hostFilePrior({ localeCharset: 'utf-8', localeLanguage: 'zh', localeTerritory: 'HK' })).toBeUndefined()
  })
})

describe('localeLanguagePrior', () => {
  it('maps languages to their regional single-byte page', () => {
    expect(localeLanguagePrior({ localeCharset: 'utf-8', localeLanguage: 'ru', localeTerritory: 'RU' })).toBe('windows-1251')
    expect(localeLanguagePrior({ localeCharset: 'utf-8', localeLanguage: 'pl' })).toBe('windows-1250')
    expect(localeLanguagePrior({ localeCharset: 'utf-8', localeLanguage: 'el' })).toBe('windows-1253')
    expect(localeLanguagePrior({ localeCharset: 'utf-8', localeLanguage: 'tr' })).toBe('windows-1254')
    expect(localeLanguagePrior({ localeCharset: 'utf-8', localeLanguage: 'he' })).toBe('windows-1255')
    expect(localeLanguagePrior({ localeCharset: 'utf-8', localeLanguage: 'ar' })).toBe('windows-1256')
    expect(localeLanguagePrior({ localeCharset: 'utf-8', localeLanguage: 'vi' })).toBe('windows-1258')
    expect(localeLanguagePrior({ localeCharset: 'utf-8', localeLanguage: 'th' })).toBe('windows-874')
    expect(localeLanguagePrior({ localeCharset: 'utf-8', localeLanguage: 'de' })).toBe('windows-1252')
    expect(localeLanguagePrior({ localeCharset: 'utf-8', localeLanguage: 'xx' })).toBeUndefined()
    expect(localeLanguagePrior({ localeCharset: 'gbk', localeLanguage: 'zh' })).toBeUndefined()
    expect(localeLanguagePrior({})).toBeUndefined()
  })
})

describe('outputLegacyForCodePage', () => {
  it('orders OEM console pages before the ANSI page', () => {
    expect(outputLegacyForCodePage(866, 1251)).toEqual(['cp866', 'windows-1251'])
    expect(outputLegacyForCodePage(936, 936)).toEqual(['gb18030'])
    expect(outputLegacyForCodePage(65001, 1252)).toEqual(['windows-1252'])
    expect(outputLegacyForCodePage(undefined, undefined)).toEqual([])
  })
})
