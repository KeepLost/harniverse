/**
 * Host priors: the machine facts the ordered candidate walk derives legacy
 * encodings from. Windows reads `GetACP`/`GetOEMCP` through a lazily loaded
 * koffi binding; POSIX parses `LC_ALL > LC_CTYPE > LANG`.
 * @module @deepseek-ai/dsh-fs-codec/priors
 */

import type { HostPriors, HostPriorsDeps } from './types.ts'

type Win32CodePages = { acp: number; oemcp: number }

let win32CodePages: Win32CodePages | undefined | false

/**
 * Lazily bind `GetACP`/`GetOEMCP` from kernel32 through koffi. Non-Windows
 * processes never load the library; a koffi failure records `false` so the
 * miss is cached rather than retried per call.
 */
async function loadWin32CodePagesDefault(): Promise<Win32CodePages | undefined> {
  if (win32CodePages !== undefined) {
    return win32CodePages === false ? undefined : win32CodePages
  }
  try {
    const koffi = (await import('koffi')).default
    const kernel32 = koffi.load('kernel32.dll')
    const getAcp = kernel32.func('uint32_t __stdcall GetACP()') as () => number
    const getOemcp = kernel32.func('uint32_t __stdcall GetOEMCP()') as () => number
    win32CodePages = { acp: getAcp(), oemcp: getOemcp() }
  } catch {
    win32CodePages = false
  }
  return win32CodePages === false ? undefined : win32CodePages
}

/**
 * Resolve the host priors synchronously. POSIX locales parse synchronously;
 * Windows returns the cached `GetACP`/`GetOEMCP` values when a prior
 * {@link hostPriors} call has finished loading koffi and `{}` before that —
 * call {@link hostPriors} (or fire-and-forget it at startup) to warm the
 * binding when the synchronous form must not miss.
 * @param deps - injectable platform/env probe for tests.
 * @returns the resolvable priors without awaiting anything.
 */
export function hostPriorsSync(deps: HostPriorsDeps = {}): HostPriors {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') {
    if (win32CodePages === undefined || win32CodePages === false) return {}
    return { acp: win32CodePages.acp, oemcp: win32CodePages.oemcp }
  }
  const env = deps.env ?? process.env
  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG
  if (locale === undefined) return {}
  const { language, territory, charset } = parseLocaleValue(locale)
  return {
    ...(charset !== undefined ? { localeCharset: charset } : {}),
    ...(language !== undefined ? { localeLanguage: language } : {}),
    ...(territory !== undefined ? { localeTerritory: territory } : {}),
  }
}

/** Split a POSIX locale value (`zh_CN.GBK`, `en_US.UTF-8`) into language, territory, and charset. */
function parseLocaleValue(value: string | undefined): { language?: string; territory?: string; charset?: string } {
  if (value === undefined || value === '' || value === 'C' || value === 'POSIX') return {}
  const dotParts = value.split('.', 2)
  const localePart = dotParts[0] as string
  const charsetPart = dotParts.length > 1 ? dotParts[1] as string : ''
  const parts = localePart.split('_', 2)
  const language = parts[0] as string
  const territory = parts.length > 1 ? parts[1] as string : ''
  const charset = charsetPart
  return {
    ...(language !== '' ? { language: language.toLowerCase() } : {}),
    ...(territory !== '' ? { territory: territory.toUpperCase() } : {}),
    ...(charset !== '' ? { charset: charset.toLowerCase() } : {}),
  }
}

/**
 * Resolve the host priors from the executing machine.
 * @param deps - injectable platform/env/Win32 probe for tests.
 * @returns the resolved priors; empty when nothing legacy is derivable.
 */
export async function hostPriors(deps: HostPriorsDeps = {}): Promise<HostPriors> {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') {
    const pages = await (deps.loadWin32CodePages ?? loadWin32CodePagesDefault)()
    if (pages === undefined || pages.acp === 65001) return {}
    return { acp: pages.acp, oemcp: pages.oemcp }
  }
  const env = deps.env ?? process.env
  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG
  if (locale === undefined) return {}
  const { language, territory, charset } = parseLocaleValue(locale)
  return {
    ...(charset !== undefined ? { localeCharset: charset } : {}),
    ...(language !== undefined ? { localeLanguage: language } : {}),
    ...(territory !== undefined ? { localeTerritory: territory } : {}),
  }
}

/** Windows ANSI code page → file-encoding prior. OEM console pages are output-only and absent. */
const ACP_PRIORS: Readonly<Record<number, string>> = {
  874: 'windows-874',
  932: 'shiftjis',
  936: 'gb18030',
  949: 'cp949',
  950: 'big5',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
}

/** POSIX charset spelling → file-encoding prior. */
const CHARSET_PRIORS: Readonly<Record<string, string>> = {
  gbk: 'gb18030',
  gb2312: 'gb18030',
  gb18030: 'gb18030',
  euccn: 'gb18030',
  big5: 'big5',
  big5hkscs: 'big5',
  sjis: 'shiftjis',
  shift_jis: 'shiftjis',
  pck: 'shiftjis',
  eucjp: 'eucjp',
  ujis: 'eucjp',
  euckr: 'cp949',
  cp949: 'cp949',
  koi8r: 'koi8-r',
  'koi8-r': 'koi8-r',
  cp1251: 'windows-1251',
  'windows-1251': 'windows-1251',
  iso88591: 'iso-8859-1',
  'iso-8859-1': 'iso-8859-1',
  iso88592: 'iso-8859-2',
  'iso-8859-2': 'iso-8859-2',
  iso88595: 'iso-8859-5',
  'iso-8859-5': 'iso-8859-5',
  iso885915: 'iso-8859-15',
  'iso-8859-15': 'iso-8859-15',
}

/** Locale language (and CJK territory) → encoding prior for UTF-8 locales. */
const LANGUAGE_PRIORS: Readonly<Record<string, string>> = {
  be: 'windows-1251',
  bg: 'windows-1251',
  ru: 'windows-1251',
  uk: 'windows-1251',
  cs: 'windows-1250',
  hr: 'windows-1250',
  hu: 'windows-1250',
  pl: 'windows-1250',
  ro: 'windows-1250',
  sk: 'windows-1250',
  sl: 'windows-1250',
  sq: 'windows-1250',
  el: 'windows-1253',
  tr: 'windows-1254',
  he: 'windows-1255',
  ar: 'windows-1256',
  vi: 'windows-1258',
  th: 'windows-874',
}

const WESTERN_LANGUAGES = new Set(['en', 'fr', 'de', 'es', 'it', 'nl', 'pt', 'da', 'nb', 'nn', 'sv', 'fi', 'is', 'eu', 'ca', 'gl'])

/** Resolve the file-encoding candidate carried by the host's ANSI/OEM prior, if any. */
export function hostFilePrior(priors: HostPriors): string | undefined {
  if (priors.acp !== undefined) return ACP_PRIORS[priors.acp]
  const charset = priors.localeCharset
  if (charset === undefined || charset === 'utf-8' || charset === 'utf8') return undefined
  if (priors.localeLanguage === 'zh') {
    if (priors.localeTerritory === 'TW' || priors.localeTerritory === 'HK' || priors.localeTerritory === 'MO') return 'big5'
    return 'gb18030'
  }
  return CHARSET_PRIORS[charset]
}

/** Resolve the encoding candidate inferred from the locale language alone (UTF-8 charset). */
export function localeLanguagePrior(priors: HostPriors): string | undefined {
  if (priors.acp !== undefined) return undefined
  const language = priors.localeLanguage
  if (language === undefined) return undefined
  if (priors.localeCharset !== undefined && priors.localeCharset !== 'utf-8' && priors.localeCharset !== 'utf8') return undefined
  if (language === 'zh') {
    if (priors.localeTerritory === 'TW' || priors.localeTerritory === 'HK' || priors.localeTerritory === 'MO') return 'big5'
    return 'gb18030'
  }
  if (language === 'ja') return 'shiftjis'
  if (language === 'ko') return 'cp949'
  return LANGUAGE_PRIORS[language] ?? (WESTERN_LANGUAGES.has(language) ? 'windows-1252' : undefined)
}

/** Windows code page → output-decoding legacy list member (`cp`-prefixed iconv name). */
const OUTPUT_CP_NAMES: Readonly<Record<number, string>> = {
  437: 'cp437',
  720: 'cp720',
  737: 'cp737',
  775: 'cp775',
  850: 'cp850',
  852: 'cp852',
  855: 'cp855',
  857: 'cp857',
  858: 'cp858',
  860: 'cp860',
  861: 'cp861',
  862: 'cp862',
  863: 'cp863',
  864: 'cp864',
  865: 'cp865',
  866: 'cp866',
  869: 'cp869',
  874: 'cp874',
  875: 'cp875',
}

/** Legacy output-decoding list for a code page: OEM consoles first, ANSI second. */
export function outputLegacyForCodePage(codePage: number | undefined, acp: number | undefined): string[] {
  const legacy: string[] = []
  if (codePage !== undefined && codePage !== 65001) {
    const name = OUTPUT_CP_NAMES[codePage] ?? ACP_PRIORS[codePage]
    if (name !== undefined) legacy.push(name)
  }
  if (acp !== undefined && acp !== 65001) {
    const name = ACP_PRIORS[acp]
    if (name !== undefined && !legacy.includes(name)) legacy.push(name)
  }
  return legacy
}
