/**
 * Model- and user-facing encoding names, source labels, and name suggestions.
 * @module @deepseek-ai/dsh-fs-codec/display
 */

import type { EncodingSource } from './types.ts'

/** Canonical iconv-lite name → display spelling used in model-visible annotations. */
const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  'utf-8': 'UTF-8',
  'utf-16le': 'UTF-16LE',
  'utf-16be': 'UTF-16BE',
  gb18030: 'GB18030',
  gbk: 'GBK',
  gb2312: 'GB2312',
  big5: 'Big5',
  big5hkscs: 'Big5-HKSCS',
  cp950: 'Big5 (CP950)',
  shiftjis: 'Shift_JIS',
  cp932: 'Shift_JIS (CP932)',
  eucjp: 'EUC-JP',
  cp949: 'EUC-KR',
  euckr: 'EUC-KR',
  'windows-874': 'Windows-874',
  'koi8-r': 'KOI8-R',
  'koi8-u': 'KOI8-U',
}

/** Display spelling for an encoding name, falling back to the raw name. */
export function displayEncoding(encoding: string): string {
  if (DISPLAY_NAMES[encoding] !== undefined) return DISPLAY_NAMES[encoding]
  if (encoding.startsWith('windows-') || encoding.startsWith('iso-8859-')) return encoding.replace(/^./, character => character.toUpperCase())
  return encoding
}

/** Source enum → the human label carried in `[Encoding: …]` annotations. */
export const SOURCE_LABELS: Readonly<Record<EncodingSource, string>> = {
  explicit: 'explicit',
  sticky: 'previous read',
  bom: 'byte order mark',
  utf8: 'UTF-8',
  host: 'host code page',
  locale: 'inferred from locale',
  fallback: 'configured fallback',
}

/**
 * Render the model-visible encoding annotation for a decode decision. Returns
 * `undefined` for any UTF-8 decision (BOM or not) so untouched reads stay
 * byte-identical to a UTF-8-only harness.
 * @param encoding - canonical encoding name from the decision.
 * @param source - the decision's source.
 */
export function encodingAnnotation(encoding: string, source: EncodingSource): string | undefined {
  if (encoding === 'utf-8') return undefined
  return `[Encoding: ${displayEncoding(encoding)} (${SOURCE_LABELS[source]})]`
}

/** Common encoding names offered when a requested name is unknown. */
const COMMON_ENCODINGS: readonly string[] = [
  'utf-8', 'utf-16le', 'utf-16be', 'gb18030', 'gbk', 'big5', 'shiftjis', 'eucjp', 'cp949',
  'windows-1250', 'windows-1251', 'windows-1252', 'windows-1256', 'windows-874', 'koi8-r',
  'iso-8859-1', 'iso-8859-2', 'iso-8859-5', 'iso-8859-15',
]

/**
 * Near-miss suggestions for an unknown encoding name: case-insensitive prefix
 * or substring matches from the common list, in list order.
 * @param name - the rejected name.
 * @returns up to five suggestions; possibly empty when nothing looks close.
 */
export function suggestEncodings(name: string): string[] {
  const lowered = name.toLowerCase()
  return COMMON_ENCODINGS
    .filter(candidate => candidate.startsWith(lowered) || (lowered.length >= 2 && candidate.includes(lowered)))
    .slice(0, 5)
}
