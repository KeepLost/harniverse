/**
 * Encode text back to a file's original bytes. iconv-lite's encoder never
 * throws — it substitutes `?` for unmappable characters — so unmappability is
 * detected by decoding the encoded form back and comparing text; the first
 * mismatching code point is reported with its line and column and the caller
 * must refuse the write (`FS_UNMAPPABLE`), never publish `?` bytes.
 * @module @deepseek-ai/dsh-fs-codec/encode
 */

import iconv from 'iconv-lite'
import { bomBytesFor } from './decode.ts'
import type { EncodeForWriteOptions, EncodeOutcome } from './types.ts'

/** Find the first code-point mismatch between the original and re-decoded text. */
function firstMismatch(original: string, redecoded: string): number {
  const originalPoints = Array.from(original)
  const redecodedPoints = Array.from(redecoded)
  const comparable = Math.min(originalPoints.length, redecodedPoints.length)
  let offset = 0
  for (let index = 0; index < comparable; index++) {
    const point = originalPoints[index] as string
    if (point !== redecodedPoints[index]) return offset
    offset += point.length
  }
  /* v8 ignore next -- iconv's '?' substitution always surfaces inside the loop before either side runs out */
  return offset
}

/**
 * Encode whole text for a guarded write-back.
 * @param text - the complete (edited) text to encode.
 * @param encoding - canonical iconv-lite encoding name from the read decision.
 * @param options - whether to reproduce the original byte order mark.
 * @returns the encoded bytes, or the first character the encoding cannot represent.
 */
export function encodeForWrite(text: string, encoding: string, options: EncodeForWriteOptions = {}): EncodeOutcome {
  const body = iconv.encode(text, encoding)
  const redecoded = iconv.decode(body, encoding, { stripBOM: false })
  if (redecoded !== text) {
    const utf16Index = firstMismatch(text, redecoded)
    let line = 1
    let column = 1
    for (const point of Array.from(text.slice(0, utf16Index))) {
      if (point === '\n') {
        line += 1
        column = 1
      } else {
        column += 1
      }
    }
    const codePoint = text.codePointAt(utf16Index) as number
    return { ok: false, unmappable: { char: String.fromCodePoint(codePoint), codePoint, line, column } }
  }
  const bom = options.bom ? bomBytesFor(encoding) : undefined
  if (bom === undefined) return { ok: true, bytes: body }
  const withBom = new Uint8Array(bom.length + body.length)
  withBom.set(bom, 0)
  withBom.set(body, bom.length)
  return { ok: true, bytes: withBom }
}
