/**
 * Pure read presentation: turn provider-decoded text into a bounded, line-numbered window and
 * model-facing envelope. Chunk scanning caps the current line, so even one newline-free giant
 * line cannot grow memory without bound.
 * @module @deepseek-ai/dsh-tool-fs/read-render
 */

import { FsError } from '@deepseek-ai/dsh-fs'

/** Default maximum characters returned for a single line (the `readMaxLineLength` config). */
export const READ_MAX_LINE_LENGTH = 2000

/** Default maximum bytes returned for selected file lines (the `readMaxBytes` config). */
export const READ_MAX_BYTES = 40 * 1024

/** Resolved read window. The consumer applies its defaults/caps before calling. */
export interface ReadWindow {
  /** 1-based first line to return. */
  offset: number
  /** Maximum number of lines to return. */
  limit: number
  /** Maximum characters returned for a single line; overflow is truncated with a suffix. */
  maxLineLength: number
  /** Maximum bytes of selected output; overflow stops the scan and marks `truncatedByBytes`. */
  maxBytes: number
  /** 0-based UTF-8 byte offset within the first selected logical line. */
  lineByteOffset?: number
}

/** One line returned from a text file. */
export interface FileTextLine {
  /** 1-based line number in the file. */
  number: number
  /** Line text without its trailing newline. */
  text: string
  /** UTF-8 byte range, present when this is a partial logical line. */
  startByte?: number
  endByte?: number
  complete?: boolean
}

/** Explicit continuation accepted by the next read call. */
export interface ReadCursor {
  offset: number
  lineByteOffset: number
}

/** The windowed result {@link buildWindow} produces from a file's decoded text. */
export interface WindowResult {
  /** Returned lines, already numbered. */
  lines: FileTextLine[]
  /** Exact total line count when this page reached EOF; omitted for an early partial-line page. */
  totalLines?: number
  /** Whether selected output hit the byte cap. */
  truncatedByBytes: boolean
  /** Exact next position when unread selected content remains. */
  next?: ReadCursor
}

/** Outcome of a bounded text read — what {@link formatReadOutput} renders. */
export interface FileReadOutcome {
  /** 1-based first line requested. */
  offset: number
  /** Returned lines, already numbered. */
  lines: FileTextLine[]
  /** Exact total line count when known. */
  totalLines?: number
  /** Whether selected output hit the byte cap. */
  truncatedByBytes?: true
  next?: ReadCursor
}

interface WindowAccumulator {
  lines: FileTextLine[]
  totalLines: number
  outputBytes: number
  truncatedByBytes: boolean
  next?: ReadCursor
}

function newAccumulator(): WindowAccumulator {
  return { lines: [], totalLines: 0, outputBytes: 0, truncatedByBytes: false }
}

function finish(acc: WindowAccumulator, request: ReadWindow, displayPath: string): WindowResult {
  if (!acc.truncatedByBytes && request.offset > acc.totalLines && !(acc.totalLines === 0 && request.offset === 1)) {
    throw new FsError(`offset ${request.offset} is out of range for "${displayPath}" (${acc.totalLines} lines)`, 'FS_NOT_FOUND')
  }
  if (acc.next === undefined) {
    const last = acc.lines.at(-1)?.number
    if (last !== undefined && last < acc.totalLines) acc.next = { offset: last + 1, lineByteOffset: 0 }
  }
  return {
    lines: acc.lines,
    totalLines: acc.totalLines,
    truncatedByBytes: acc.truncatedByBytes,
    ...acc.next === undefined ? {} : { next: acc.next },
  }
}

const STOP_AFTER_PARTIAL_LINE = new Error('stop after partial line')

/**
 * Build one window from streamed or whole-file chunks, enforcing line and byte caps while still
 * scanning to an exact total line count when EOF is reached. A partial-line page stops as soon as
 * its continuation is known and omits `totalLines` rather than scanning the unused remainder.
 * @param chunks - decoded text chunks in file order; chunk boundaries carry no meaning.
 * @param request - the resolved window; the caller has already applied its defaults and caps.
 * @param displayPath - the caller-facing path used in the offset-out-of-range error.
 * @returns the numbered window lines, the total line count seen, and the byte-cap truncation flag.
 */
export async function buildWindow(
  chunks: AsyncIterable<string> | Iterable<string>,
  request: ReadWindow,
  displayPath: string,
): Promise<WindowResult> {
  const acc = newAccumulator()
  const requestedByteOffset = request.lineByteOffset ?? 0
  let currentLine = 1
  let lineBytes = 0
  let retainedText = ''
  let retainedBytes = 0
  let retainedChars = 0
  let lineTruncated = false
  let lineTruncatedByBytes = false
  let pendingCarriageReturn = false
  let pendingHighSurrogate = ''

  const selected = (): boolean => currentLine >= request.offset && acc.lines.length < request.limit && acc.next === undefined
  const cursorForLine = (): number => currentLine === request.offset ? requestedByteOffset : 0

  function consumeCodePoint(codePoint: string): void {
    const bytes = Buffer.byteLength(codePoint, 'utf8')
    const cursor = cursorForLine()
    if (currentLine === request.offset && lineBytes < cursor) {
      if (lineBytes + bytes > cursor) throw new Error('line_byte_offset must be at a UTF-8 boundary')
      lineBytes += bytes
      return
    }
    if (selected() && !lineTruncated) {
      const delimiter = acc.lines.length > 0 ? 1 : 0
      if (retainedChars >= request.maxLineLength) {
        lineTruncated = true
      } else if (acc.outputBytes + delimiter + retainedBytes + bytes > request.maxBytes) {
        lineTruncated = true
        lineTruncatedByBytes = true
      } else {
        retainedText += codePoint
        retainedBytes += bytes
        retainedChars++
      }
      if (lineTruncated) {
        if (retainedBytes === 0 && acc.lines.length === 0) {
          throw new Error('readMaxBytes is too small to return one UTF-8 code point')
        }
        // A byte cap reached exactly between lines has no intra-line payload to
        // return. Keep scanning for the exact line count and let flushLine emit
        // the next-line cursor; early termination is reserved for a real
        // partial-line page.
        if (retainedBytes === 0) {
          lineBytes += bytes
          return
        }
        acc.lines.push({
          number: currentLine,
          text: retainedText,
          startByte: cursor,
          endByte: cursor + retainedBytes,
          complete: false,
        })
        acc.outputBytes += delimiter + retainedBytes
        acc.next = { offset: currentLine, lineByteOffset: cursor + retainedBytes }
        acc.truncatedByBytes ||= lineTruncatedByBytes
        throw STOP_AFTER_PARTIAL_LINE
      }
    }
    lineBytes += bytes
  }

  function flushLine(): void {
    const cursor = cursorForLine()
    if (currentLine === request.offset && cursor > lineBytes) {
      throw new FsError(
        `line_byte_offset ${cursor} is out of range for line ${currentLine} of "${displayPath}" (${lineBytes} bytes)`,
        'FS_NOT_FOUND',
      )
    }
    acc.totalLines++
    if (selected()) {
      const delimiter = acc.lines.length > 0 ? 1 : 0
      if (lineTruncated) {
        if (retainedBytes === 0 && acc.lines.length === 0) {
          throw new Error('readMaxBytes is too small to return one UTF-8 code point')
        }
        if (retainedBytes > 0) {
          acc.lines.push({
            number: currentLine,
            text: retainedText,
            startByte: cursor,
            endByte: cursor + retainedBytes,
            complete: false,
          })
          acc.outputBytes += delimiter + retainedBytes
        }
        acc.next = { offset: currentLine, lineByteOffset: cursor + retainedBytes }
        acc.truncatedByBytes ||= lineTruncatedByBytes
      } else {
        acc.lines.push(cursor > 0
          ? { number: currentLine, text: retainedText, startByte: cursor, endByte: lineBytes, complete: true }
          : { number: currentLine, text: retainedText })
        acc.outputBytes += delimiter + retainedBytes
      }
    }
    currentLine++
    lineBytes = 0
    retainedText = ''
    retainedBytes = 0
    retainedChars = 0
    lineTruncated = false
    lineTruncatedByBytes = false
  }

  try {
    for await (const rawChunk of chunks) {
      let chunk = pendingHighSurrogate + rawChunk
      pendingHighSurrogate = ''
      const trailing = chunk.charCodeAt(chunk.length - 1)
      if (trailing >= 0xd800 && trailing <= 0xdbff) {
        pendingHighSurrogate = chunk.at(-1) ?? ''
        chunk = chunk.slice(0, -1)
      }
      for (const codePoint of chunk) {
        if (pendingCarriageReturn) {
          pendingCarriageReturn = false
          if (codePoint === '\n') {
            flushLine()
            continue
          }
          consumeCodePoint('\r')
        }
        if (codePoint === '\r') {
          pendingCarriageReturn = true
        } else if (codePoint === '\n') {
          flushLine()
        } else {
          consumeCodePoint(codePoint)
        }
      }
    }
    if (pendingHighSurrogate !== '') consumeCodePoint(pendingHighSurrogate)
  } catch (error: unknown) {
    if (error !== STOP_AFTER_PARTIAL_LINE) throw error
    return {
      lines: acc.lines,
      truncatedByBytes: acc.truncatedByBytes,
      // oxlint-disable-next-line typescript/no-non-null-assertion -- the stop sentinel is thrown only after assigning a cursor
      next: acc.next!,
    }
  }
  if (pendingCarriageReturn) consumeCodePoint('\r')
  if (lineBytes > 0) flushLine()
  return finish(acc, request, displayPath)
}

/**
 * Format a read outcome as one OpenCode-style line-numbered text block body.
 * @param displayPath - the backend-resolved path rendered in the envelope's `<path>` element.
 * @param outcome - the windowed read to render.
 * @returns the model-facing envelope: numbered lines plus a continuation or end-of-file footer.
 */
export function formatReadOutput(displayPath: string, outcome: FileReadOutcome): string {
  const endLine = outcome.lines.at(-1)?.number ?? Math.max(0, outcome.offset - 1)
  let footer: string
  if (outcome.next !== undefined && outcome.next.lineByteOffset > 0) {
    footer = `(Line ${outcome.next.offset} continues. Use offset=${outcome.next.offset} and line_byte_offset=${outcome.next.lineByteOffset}.)`
  } else if (outcome.next !== undefined && outcome.totalLines !== undefined) {
    footer = `(Showing lines ${outcome.offset}-${endLine} of ${outcome.totalLines}. Use offset=${outcome.next.offset} to continue.)`
  } else if (outcome.totalLines !== undefined && endLine < outcome.totalLines) {
    footer = `(Showing lines ${outcome.offset}-${endLine} of ${outcome.totalLines}. Use offset=${endLine + 1} to continue.)`
  } else if (outcome.totalLines !== undefined) {
    footer = `(End of file - total ${outcome.totalLines} lines)`
  } else {
    footer = '(More file content may remain.)'
  }
  const body = outcome.lines.length > 0
    ? `${outcome.lines.map((line) => {
      if (line.startByte === undefined || line.endByte === undefined) return `${line.number}: ${line.text}`
      return `${line.number} [bytes ${line.startByte}-${line.endByte}]: ${line.text}`
    }).join('\n')}\n\n${footer}`
    : footer
  return `<path>${escapeXml(displayPath)}</path>
<type>file</type>
<content>
${body}
</content>`
}

/** Escape a path before placing it in the model-facing XML-like envelope. */
function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Lowercased file-extension to syntax-highlighting language hint. Keys are the
 * extension without its dot; a UI treats an absent key as plain text. The map is
 * intentionally small — common source, config, and markup extensions a
 * line-numbered code view benefits from highlighting — not an exhaustive registry.
 */
const LANG_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'ts', tsx: 'tsx', mts: 'ts', cts: 'ts',
  js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  json: 'json', jsonc: 'json',
  py: 'py', rb: 'rb', go: 'go', rs: 'rs', java: 'java',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cxx: 'cpp',
  cs: 'cs', kt: 'kotlin', swift: 'swift', php: 'php',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini',
  md: 'md', markdown: 'md', mdx: 'mdx',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', xml: 'xml', lua: 'lua',
}

/**
 * Derive a syntax-highlighting language hint from a read path's file extension.
 * Pure and case-insensitive on the extension; a dotfile with no extension
 * (`.gitignore`) and an unknown extension both yield `undefined`.
 * @param path - the model-facing path the read reported.
 * @returns the language hint for {@link LANG_BY_EXTENSION}, or `undefined` when the extension maps to none.
 */
export function langFromPath(path: string): string | undefined {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  // A leading dot is a dotfile (no extension), not an empty extension.
  if (dot <= 0) return undefined
  const ext = base.slice(dot + 1).toLowerCase()
  // Own-property check only: a filename whose extension is an Object.prototype
  // key (`foo.constructor`, `foo.__proto__`) must map to no language, not to the
  // inherited member — otherwise a function would reach `lang` and fail the
  // tool-output JSON validation.
  return Object.hasOwn(LANG_BY_EXTENSION, ext) ? LANG_BY_EXTENSION[ext] : undefined
}

/**
 * The `read` tool's private `tool/result` `meta` payload: the structured
 * line-numbered window a capable UI renders as a code view. Attached opaquely (as
 * `unknown`) on the tool result and persisted with the session log — it must be
 * JSON-serializable (the session validates this at `append`), so `presentResult`
 * reproduces the read card on replay when the raw structured output is no longer
 * on the wire. The producing tool owns and narrows this opaque shape.
 */
export interface FsReadMeta {
  /** The read file's model-facing path. */
  path: string
  /** The 1-based first line the window requested, kept even when `lines` is empty. */
  offset: number
  /** The returned window's lines, each keeping its file line number. */
  lines: FileTextLine[]
  /** Exact total line count when the bounded stream reached EOF. */
  totalLines?: number
  next?: ReadCursor
  /** Syntax-highlighting language hint from the extension, or omitted for plain text. */
  lang?: string
}

/**
 * Whether `value` is a valid {@link FileTextLine} (defensive narrowing from
 * opaque `meta`). `number` must be a 1-based integer line number, since a card
 * rendered from a zero, fractional, or non-finite line number would violate the
 * 1-based numbering contract the read window promises.
 */
function isFileTextLine(value: unknown): value is FileTextLine {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { number, text, startByte, endByte, complete } = value as Record<string, unknown>
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || typeof text !== 'string') return false
  if (startByte === undefined && endByte === undefined && complete === undefined) return true
  return typeof startByte === 'number' && Number.isInteger(startByte) && startByte >= 0
    && typeof endByte === 'number' && Number.isInteger(endByte) && endByte >= startByte
    && typeof complete === 'boolean'
}

/**
 * Narrow opaque live or replayed result metadata to a structured read window.
 * Malformed metadata returns `undefined` so presentation can fall back to the
 * generic text card instead of throwing during replay. Beyond shape, the
 * semantic contract of a read window is enforced against replayed JSON that is
 * well-typed but out of range: `offset` must be a 1-based integer, an available
 * `totalLines` must be a non-negative integer, each line number must be a 1-based
 * integer no less than `offset`, and the line numbers must strictly increase.
 * When the bounded stream reached EOF, no line may exceed `totalLines`.
 * @param meta - result metadata.
 * @returns the validated read window, or `undefined` for absent, malformed, or semantically invalid data.
 */
export function readMetaFromMeta(meta: unknown): FsReadMeta | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const { path, offset, lines, totalLines, lang, next } = meta as Record<string, unknown>
  if (typeof path !== 'string' || typeof offset !== 'number') return undefined
  if (!Number.isInteger(offset) || offset < 1) return undefined
  if (totalLines !== undefined && (typeof totalLines !== 'number' || !Number.isInteger(totalLines) || totalLines < 0)) {
    return undefined
  }
  if (!Array.isArray(lines) || !lines.every(isFileTextLine)) return undefined
  if (lang !== undefined && typeof lang !== 'string') return undefined
  if (next !== undefined) {
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return undefined
    const { offset: nextOffset, lineByteOffset } = next as Record<string, unknown>
    if (typeof nextOffset !== 'number' || !Number.isInteger(nextOffset) || nextOffset < 1) return undefined
    if (typeof lineByteOffset !== 'number' || !Number.isInteger(lineByteOffset) || lineByteOffset < 0) return undefined
  }
  let previous = offset - 1
  for (const { number } of lines) {
    if (number <= previous || (totalLines !== undefined && number > totalLines)) return undefined
    previous = number
  }
  return {
    path, offset, lines,
    ...totalLines === undefined ? {} : { totalLines },
    ...next === undefined ? {} : { next: next as ReadCursor },
    ...lang === undefined ? {} : { lang },
  }
}
