/**
 * Strict decode and the ordered candidate walk. iconv-lite 0.7.3 has no strict
 * mode — decode emits U+FFFD for invalid bytes and encode writes `?` for
 * unmappable characters — so strictness here is the U+FFFD veto plus a
 * byte-identical re-encode, and every decode runs over one whole buffer
 * (iconv's GB18030 streaming decoder drops a code unit when a 4-byte sequence
 * straddles a chunk boundary).
 * @module @deepseek-ai/dsh-fs-codec/decode
 */

import iconv from 'iconv-lite'
import type { EncodingSource, SniffOptions, SniffOutcome } from './types.ts'
import { hostFilePrior, localeLanguagePrior } from './priors.ts'

/** Byte order marks this library recognizes, longest signature first. UTF-32 is out of scope. */
const BOM_TABLE: readonly { readonly bytes: readonly number[]; readonly encoding: string }[] = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8' },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le' },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be' },
]

/**
 * Sniff a byte order mark. A UTF-16LE BOM also clears the NUL binary gate for
 * the rest of the walk (UTF-16 text of ASCII range legitimately contains NULs).
 */
export function sniffBom(bytes: Uint8Array): { encoding: string; bom: true } | undefined {
  for (const entry of BOM_TABLE) {
    if (entry.bytes.every((byte, index) => bytes.at(index) === byte)) {
      return { encoding: entry.encoding, bom: true }
    }
  }
  return undefined
}

/** Whether the byte is a UTF-8 continuation byte (10xxxxxx). */
export function isUtf8Continuation(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x80 && byte <= 0xbf
}

/** Announced length of a complete UTF-8 sequence for a lead byte (0 ASCII, -1 invalid). */
function utf8SequenceLength(lead: number): number {
  if (lead < 0x80) return 1
  if (lead >= 0xc2 && lead <= 0xdf) return 2
  if (lead >= 0xe0 && lead <= 0xef) return 3
  if (lead >= 0xf0 && lead <= 0xf4) return 4
  return -1
}

/**
 * Byte length a caller may safely consume so the next read starts on a UTF-8
 * sequence boundary: a trailing lead byte without its continuations, or a
 * lead plus an incomplete run, stays unconsumed. Every ASCII-compatible
 * legacy lead byte is either a UTF-8 lead or a continuation-range byte, so
 * this boundary also never splits a dangling legacy sequence.
 */
export function utf8BoundaryEnd(bytes: Uint8Array): number {
  const last = bytes.length - 1
  if (last < 0) return 0
  const lastByte = bytes[last]
  if (lastByte === undefined || !isUtf8Continuation(lastByte)) {
    return lastByte !== undefined && utf8SequenceLength(lastByte) > 1 ? bytes.length - 1 : bytes.length
  }
  let index = last
  while (index > 0 && isUtf8Continuation(bytes[index - 1])) index -= 1
  const lead = index > 0 ? bytes[index - 1] : undefined
  const announced = lead === undefined ? -1 : utf8SequenceLength(lead)
  const available = bytes.length - index + 1
  if (announced < 0 || available < announced) return Math.max(0, index - 1)
  return bytes.length
}

/** Bytes of the BOM to reproduce on write-back for an encoding, if any. */
export function bomBytesFor(encoding: string): Uint8Array | undefined {
  const entry = BOM_TABLE.find(candidate => candidate.encoding === encoding)
  return entry === undefined ? undefined : Uint8Array.from(entry.bytes)
}

/**
 * Whether iconv-lite knows the encoding name (accepts its alias spellings).
 * @param name - the caller-supplied encoding name.
 */
export function encodingExists(name: string): boolean {
  return iconv.encodingExists(name)
}

/**
 * Strict decode of a whole buffer: any U+FFFD in the result vetoes the
 * candidate. iconv's BOM handling stays off — this library owns BOM bytes.
 * @param bytes - the complete buffer to decode.
 * @param encoding - canonical or alias iconv-lite encoding name.
 * @returns the decoded text, or `undefined` when the decode is not clean.
 */
export function decodeStrict(bytes: Uint8Array, encoding: string): string | undefined {
  const text = iconv.decode(bytes, encoding, { stripBOM: false })
  return text.includes('\ufffd') ? undefined : text
}

/**
 * Byte round-trip gate: re-encoding the decoded text must reproduce the
 * original bytes exactly, so files sitting on non-round-trippable code points
 * are rejected rather than silently rewritten.
 */
function roundTrips(text: string, encoding: string, bytes: Uint8Array): boolean {
  const reencoded = iconv.encode(text, encoding)
  if (reencoded.length !== bytes.length) return false
  for (let index = 0; index < bytes.length; index++) {
    if (reencoded[index] !== bytes[index]) return false
  }
  return true
}

/**
 * Single-byte code pages decode almost any byte soup, so an auto-detected
 * legacy candidate additionally tolerates at most one stray control character
 * (C0 other than tab/LF/CR/FF/VT, DEL, or the C1 range) or 1% of the text,
 * whichever is larger — a binary file decoded as text bristles with controls.
 */
function passesControlRatio(text: string): boolean {
  let controls = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    const isControl = (code < 0x20 && code !== 9 && code !== 10 && code !== 11 && code !== 12 && code !== 13)
      || code === 0x7f
      || (code >= 0x80 && code <= 0x9f && code !== 0xad)
    if (isControl && ++controls > Math.max(1, Math.floor(text.length / 100))) return false
  }
  return true
}

/** Encodings whose auto-detected single-byte decode must pass the control-character ratio. */
const SINGLE_BYTE_ENCODINGS: ReadonlySet<string> = new Set([
  'ascii', 'latin1', 'iso-8859-1', 'iso-8859-2', 'iso-8859-3', 'iso-8859-4', 'iso-8859-5', 'iso-8859-6',
  'iso-8859-7', 'iso-8859-8', 'iso-8859-9', 'iso-8859-10', 'iso-8859-11', 'iso-8859-13', 'iso-8859-14',
  'iso-8859-15', 'iso-8859-16', 'windows-874', 'windows-1250', 'windows-1251', 'windows-1252', 'windows-1253',
  'windows-1254', 'windows-1255', 'windows-1256', 'windows-1257', 'windows-1258', 'koi8-r', 'koi8-u', 'koi8-ru',
  'cp437', 'cp720', 'cp737', 'cp775', 'cp808', 'cp850', 'cp852', 'cp855', 'cp856', 'cp857', 'cp858', 'cp860',
  'cp861', 'cp862', 'cp863', 'cp864', 'cp865', 'cp866', 'cp869', 'cp874', 'cp875', 'tis620', 'macroman',
  'macintosh', 'maccroatian', 'maccentraleeurope', 'maccyrillic', 'maciceland', 'macromania', 'macgreek',
  'macturkish', 'macukraine', 'armscii8', 'rk1048', 'pt154', 'georgianacademy', 'georgianps', 'tcvn', 'viscii',
  'hproman8', 'mik',
])

/**
 * Validate one candidate against a whole buffer: strict decode, byte
 * round-trip, and — for auto-detected single-byte pages — the control ratio.
 */
function tryCandidate(
  bytes: Uint8Array,
  encoding: string,
  bom: boolean,
  opts: { roundTrip: boolean; controlRatio: boolean },
): string | undefined {
  const bomLength = bom ? (bomBytesFor(encoding)?.length ?? 0) : 0
  const body = bytes.subarray(bomLength)
  const text = decodeStrict(body, encoding)
  if (text === undefined) return undefined
  if (opts.roundTrip && !roundTrips(text, encoding, body)) return undefined
  if (opts.controlRatio && SINGLE_BYTE_ENCODINGS.has(encoding) && !passesControlRatio(text)) return undefined
  return text
}

/** Dominant line-ending style of decoded text (sampled like fsio's edit read). */
function detectEol(text: string): 'LF' | 'CRLF' {
  const sample = text.slice(0, 4096)
  let crlf = 0
  let index = sample.indexOf('\r\n')
  while (index !== -1) {
    crlf += 1
    index = sample.indexOf('\r\n', index + 2)
  }
  let lf = sample.split('\n').length - 1 - crlf
  /* v8 ignore next -- every \r\n pair contains a \n, so the count never goes negative */
  if (lf < 0) lf = 0
  return crlf > lf ? 'CRLF' : 'LF'
}

/**
 * Fixed probe list reported to the model when every ordered candidate failed:
 * encodings that DO decode the bytes cleanly, most likely legacies first.
 */
const PROBE_ENCODINGS: readonly string[] = [
  'gb18030', 'big5', 'shiftjis', 'eucjp', 'cp949',
  'windows-1251', 'windows-1252', 'windows-1250', 'windows-1253', 'windows-1255',
  'windows-1256', 'windows-874', 'koi8-r', 'iso-8859-15',
]

function viableProbes(bytes: Uint8Array, bom: boolean): string[] {
  const viable: string[] = []
  for (const encoding of PROBE_ENCODINGS) {
    if (tryCandidate(bytes, encoding, bom, { roundTrip: true, controlRatio: true }) !== undefined) {
      viable.push(encoding)
    }
  }
  return viable
}

/**
 * Run the ordered candidate walk over one whole buffer: explicit → sticky →
 * BOM (UTF family) → strict UTF-8 → host legacy page → locale language page →
 * configured fallbacks. A NUL byte without a UTF-16 BOM rejects as binary
 * before any decoding (the zero-regression gate). The explicit candidate wins
 * or fails by name — a requested encoding that cannot decode the bytes
 * cleanly reports `reason: 'explicit'` instead of falling through.
 * @param bytes - the complete file (or preview prefix) buffer.
 * @param options - the walk inputs; see {@link SniffOptions}.
 * @returns the decoded text with its decision, or the structured rejection.
 */
export function sniffAndDecode(bytes: Uint8Array, options: SniffOptions): SniffOutcome {
  const bom = sniffBom(bytes)
  const utf16 = bom?.encoding === 'utf-16le' || bom?.encoding === 'utf-16be'
  const sample = bytes.subarray(0, options.binarySampleBytes ?? bytes.length)
  if (!utf16 && sample.includes(0)) {
    return { ok: false, reason: 'binary', candidates: [] }
  }

  const settle = (text: string, encoding: string, source: EncodingSource, bomFlag: boolean): SniffOutcome => ({
    ok: true,
    text,
    decision: { encoding, source, bom: bomFlag, eol: detectEol(text) },
  })

  if (options.explicit !== undefined) {
    if (!encodingExists(options.explicit)) {
      return { ok: false, reason: 'explicit', encoding: options.explicit, candidates: [] }
    }
    const text = tryCandidate(bytes, options.explicit, bom !== undefined, { roundTrip: true, controlRatio: false })
    if (text !== undefined) return settle(text, options.explicit, 'explicit', bom !== undefined)
    return { ok: false, reason: 'explicit', encoding: options.explicit, candidates: viableProbes(bytes, false) }
  }

  if (options.sticky !== undefined && encodingExists(options.sticky.encoding)) {
    const stickyBom = options.sticky.bom
    const text = tryCandidate(bytes, options.sticky.encoding, stickyBom, { roundTrip: true, controlRatio: false })
    if (text !== undefined) return settle(text, options.sticky.encoding, 'sticky', stickyBom)
  }

  if (bom !== undefined) {
    const text = tryCandidate(bytes, bom.encoding, true, { roundTrip: true, controlRatio: false })
    if (text !== undefined) return settle(text, bom.encoding, 'bom', true)
  }

  const utf8Text = tryCandidate(bytes, 'utf-8', bom?.encoding === 'utf-8', { roundTrip: false, controlRatio: false })
  if (utf8Text !== undefined) return settle(utf8Text, 'utf-8', 'utf8', bom?.encoding === 'utf-8')

  const legacy: { encoding: string; source: EncodingSource }[] = []
  if (options.detect !== false) {
    // Legacy pages are total over byte soup; they gate on the whole buffer so
    // a far NUL cannot turn binary content into mojibake text.
    if (!utf16 && bytes.includes(0)) {
      return { ok: false, reason: 'binary', candidates: [] }
    }
    const host = hostFilePrior(options.priors)
    if (host !== undefined) legacy.push({ encoding: host, source: 'host' })
    const locale = localeLanguagePrior(options.priors)
    if (locale !== undefined && locale !== host) legacy.push({ encoding: locale, source: 'locale' })
    for (const encoding of options.fallbackEncodings ?? []) {
      if (!legacy.some(candidate => candidate.encoding === encoding)) legacy.push({ encoding, source: 'fallback' })
    }
  }
  for (const candidate of legacy) {
    if (!encodingExists(candidate.encoding)) continue
    const text = tryCandidate(bytes, candidate.encoding, false, { roundTrip: true, controlRatio: true })
    if (text !== undefined) return settle(text, candidate.encoding, candidate.source, false)
  }

  return { ok: false, reason: 'none', candidates: viableProbes(bytes, false) }
}
