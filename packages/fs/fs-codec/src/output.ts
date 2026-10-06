/**
 * Collected-subprocess-output decoding. The whole retained window is judged
 * line by line on each read: a line that is valid UTF-8 decodes as UTF-8, and
 * only an invalid line falls back to the stream's legacy code pages (Windows
 * OEM/ANSI or a POSIX locale charset). A line made invalid merely because the
 * read boundary sliced a multi-byte character (leading continuation byte) is
 * NOT treated as legacy — it decodes as UTF-8. An incomplete trailing sequence
 * is held back for the next read, so `nextOffset` may sit before the newest
 * retained byte. Nothing ever feeds iconv a partial stream.
 * @module @deepseek-ai/dsh-fs-codec/output
 */

import { decodeStrict, utf8BoundaryEnd } from './decode.ts'
import type { OutputDecodingSpec } from './types.ts'

/** Whether the byte is a UTF-8 continuation byte (10xxxxxx). */
function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x80 && byte <= 0xbf
}

/** Bytes to hold back so the next read starts on a UTF-8 sequence boundary. */
function trailingIncompleteUtf8(bytes: Uint8Array): number {
  return bytes.length - utf8BoundaryEnd(bytes)
}

/** Decode one line per the mixed spec: strict UTF-8 first, legacy pages only when it fails. */
function decodeMixedLine(line: Uint8Array, legacy: readonly string[]): string {
  const utf8 = decodeStrict(line, 'utf-8')
  if (utf8 !== undefined) return utf8
  for (const encoding of legacy) {
    const decoded = decodeStrict(line, encoding)
    if (decoded !== undefined) return decoded
  }
  return Buffer.from(line).toString('utf8')
}

/** Result of one output-window decode. */
export interface OutputDecodeResult {
  /** Decoded text for the bytes up to `consumedTo`. */
  text: string
  /** Byte length of `buffer` the decode consumed; `buffer.length - consumedTo` is held for the next read. */
  consumedTo: number
}

/**
 * Decode one retained output window per the spec. With `final` unset, an
 * incomplete trailing sequence (or, under `mixed`, an unterminated line whose
 * tail is not valid UTF-8 and may still be a partial legacy sequence) stays
 * unread until more bytes or stream end arrive.
 *
 * Under `mixed`, a window whose first byte is a UTF-8 continuation byte was
 * sliced mid-sequence by a FOREIGN offset (a caller-provided `fromByte` this
 * collector never returned); its first line decodes as UTF-8 rather than
 * falling back to a legacy page whose lead bytes overlap the continuation
 * range. Pass `alignedSlice: true` when the offset came from this decoder's
 * own aligned `nextOffset`, which never slices a sequence.
 * @param buffer - the complete retained window starting at the caller's read offset.
 * @param spec - UTF-8 or per-line mixed decoding.
 * @param opts - whether the stream has ended, and whether the window starts on a sequence boundary this decoder produced.
 * @returns the decoded text and how many bytes it covers.
 */
export function decodeOutputWindow(
  buffer: Uint8Array,
  spec: OutputDecodingSpec,
  opts: { final: boolean; alignedSlice?: boolean },
): OutputDecodeResult {
  if (buffer.length === 0) return { text: '', consumedTo: 0 }
  if (spec.kind === 'utf-8') {
    const held = opts.final ? 0 : trailingIncompleteUtf8(buffer)
    const end = buffer.length - held
    return { text: Buffer.from(buffer.subarray(0, end)).toString('utf8'), consumedTo: end }
  }
  if (opts.final) {
    return { text: decodeMixedWindow(buffer, spec.legacy, opts.alignedSlice === true), consumedTo: buffer.length }
  }
  let end = buffer.length - trailingIncompleteUtf8(buffer)
  const lastNewline = buffer.lastIndexOf(0x0a)
  if (lastNewline + 1 < end) {
    const unterminated = buffer.subarray(lastNewline + 1, end)
    if (decodeStrict(unterminated, 'utf-8') === undefined) end = lastNewline + 1
  }
  return { text: decodeMixedWindow(buffer.subarray(0, end), spec.legacy, opts.alignedSlice === true), consumedTo: end }
}

/** Decode a complete window per line, honoring the foreign-slice rule for the first line. */
function decodeMixedWindow(window: Uint8Array, legacy: readonly string[], alignedSlice: boolean): string {
  const parts: string[] = []
  let lineStart = 0
  while (lineStart < window.length) {
    const newline = window.indexOf(0x0a, lineStart)
    const lineEnd = newline === -1 ? window.length : newline + 1
    const line = window.subarray(lineStart, lineEnd)
    if (lineStart === 0 && !alignedSlice && isContinuation(window[0])) {
      parts.push(Buffer.from(line).toString('utf8'))
    } else {
      parts.push(decodeMixedLine(line, legacy))
    }
    lineStart = lineEnd
  }
  return parts.join('')
}
