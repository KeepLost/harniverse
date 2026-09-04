/**
 * Cordis-free tests for the line-windowing module: offset/limit windows, byte
 * caps, per-line truncation, CRLF stripping, offset-past-EOF rejection, and the
 * capped line buffer for newline-free giant lines — all over an async-iterable
 * of decoded text chunks (so one code path serves whole-file and streamed reads).
 */

import { describe, expect, it } from 'vitest'
import { buildWindow, formatReadOutput, langFromPath, readMetaFromMeta, READ_MAX_BYTES, READ_MAX_LINE_LENGTH } from '../src/read-render.ts'
import type { ReadWindow } from '../src/read-render.ts'

const DEFAULT_CAPS = { maxLineLength: READ_MAX_LINE_LENGTH, maxBytes: READ_MAX_BYTES }
const READ_ALL: ReadWindow = { offset: 1, limit: 2000, ...DEFAULT_CAPS }

/** Yield `text` as one chunk (whole-file read shape). */
async function* whole(text: string): AsyncIterable<string> {
  yield text
}

/** Yield `text` split into fixed-size chunks (streamed read shape). */
async function* chunked(text: string, size: number): AsyncIterable<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size)
}

/** Yield a large logical line without constructing it as one test string. */
async function* repeatedLine(char: string, count: number, chunkSize: number): AsyncIterable<string> {
  for (let remaining = count; remaining > 0; remaining -= chunkSize) {
    yield char.repeat(Math.min(remaining, chunkSize))
  }
}

describe('buildWindow', () => {
  it('numbers lines and reports total for a whole-file read', async () => {
    const result = await buildWindow(whole('one\ntwo\nthree'), READ_ALL, 'f')
    expect(result.lines).toEqual([
      { number: 1, text: 'one' },
      { number: 2, text: 'two' },
      { number: 3, text: 'three' },
    ])
    expect(result.totalLines).toBe(3)
    expect(result.truncatedByBytes).toBe(false)
  })

  it('applies offset/limit', async () => {
    const result = await buildWindow(whole('one\ntwo\nthree\nfour'), { offset: 2, limit: 2, ...DEFAULT_CAPS }, 'f')
    expect(result.lines.map(l => l.number)).toEqual([2, 3])
    expect(result.totalLines).toBe(4)
  })

  it('strips CRLF', async () => {
    const result = await buildWindow(whole('one\r\ntwo\r\n'), READ_ALL, 'f')
    expect(result.lines.map(l => l.text)).toEqual(['one', 'two'])
  })

  it('truncates an over-long line', async () => {
    const result = await buildWindow(whole('x'.repeat(3000)), READ_ALL, 'f')
    expect(result.lines[0]).toEqual({
      number: 1, text: 'x'.repeat(READ_MAX_LINE_LENGTH),
      startByte: 0, endByte: READ_MAX_LINE_LENGTH, complete: false,
    })
    expect(result.next).toEqual({ offset: 1, lineByteOffset: READ_MAX_LINE_LENGTH })
    expect(result.totalLines).toBeUndefined()
  })

  it('caps output bytes and reports truncatedByBytes', async () => {
    const big = Array.from({ length: 2000 }, () => 'y'.repeat(100)).join('\n')
    const result = await buildWindow(whole(big), READ_ALL, 'f')
    expect(result.truncatedByBytes).toBe(true)
  })

  it('reads an empty file at offset 1 as zero lines', async () => {
    const result = await buildWindow(whole(''), READ_ALL, 'f')
    expect(result.lines).toEqual([])
    expect(result.totalLines).toBe(0)
  })

  it('rejects an offset past EOF', async () => {
    await expect(buildWindow(whole('one\ntwo'), { offset: 9, limit: 1, ...DEFAULT_CAPS }, 'f')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('flushes a final line with no trailing newline', async () => {
    const result = await buildWindow(whole('one\ntwo'), READ_ALL, 'f')
    expect(result.lines.map(l => l.text)).toEqual(['one', 'two'])
  })

  it('handles a trailing newline (no dangling empty line)', async () => {
    const result = await buildWindow(whole('one\ntwo\n'), READ_ALL, 'f')
    expect(result.lines.map(l => l.text)).toEqual(['one', 'two'])
    expect(result.totalLines).toBe(2)
  })

  describe('caps are per-request (the plugin config reaches the window)', () => {
    it('returns a same-line cursor at a custom maxLineLength', async () => {
      const result = await buildWindow(whole('abcdefghij'), { offset: 1, limit: 10, maxLineLength: 5, maxBytes: READ_MAX_BYTES }, 'f')
      expect(result.lines[0]).toEqual({ number: 1, text: 'abcde', startByte: 0, endByte: 5, complete: false })
      expect(result.next).toEqual({ offset: 1, lineByteOffset: 5 })
    })

    it('caps output at a custom maxBytes', async () => {
      const result = await buildWindow(whole('aaaa\nbbbb\ncccc'), { offset: 1, limit: 10, maxLineLength: 2000, maxBytes: 9 }, 'f')
      expect(result.lines.map(l => l.text)).toEqual(['aaaa', 'bbbb'])
      expect(result.totalLines).toBe(3)
      expect(result.truncatedByBytes).toBe(true)
    })
  })

  describe('chunked input (streamed read shape)', () => {
    it('windows identically when text arrives in small chunks', async () => {
      const result = await buildWindow(chunked('one\ntwo\nthree', 2), { offset: 2, limit: 1, ...DEFAULT_CAPS }, 'f')
      expect(result.lines).toEqual([{ number: 2, text: 'two' }])
      expect(result.totalLines).toBe(3)
    })

    it('caps a newline-free giant line split across chunks without unbounded buffering', async () => {
      const result = await buildWindow(chunked('z'.repeat(5000), 256), READ_ALL, 'f')
      expect(result.lines[0]).toEqual({
        number: 1, text: 'z'.repeat(READ_MAX_LINE_LENGTH),
        startByte: 0, endByte: READ_MAX_LINE_LENGTH, complete: false,
      })
    })

    it('returns a strictly advancing cursor for a 24 MiB newline-free line', async () => {
      const first = await buildWindow(
        repeatedLine('z', 24 * 1024 * 1024, 64 * 1024),
        { offset: 1, lineByteOffset: 0, limit: 1, maxLineLength: 2000, maxBytes: READ_MAX_BYTES },
        'huge.txt',
      )
      expect(first.lines).toEqual([{
        number: 1,
        text: 'z'.repeat(2000),
        startByte: 0,
        endByte: 2000,
        complete: false,
      }])
      expect(first.next).toEqual({ offset: 1, lineByteOffset: 2000 })

      const second = await buildWindow(
        repeatedLine('z', 24 * 1024 * 1024, 64 * 1024),
        { offset: 1, lineByteOffset: first.next!.lineByteOffset, limit: 1, maxLineLength: 2000, maxBytes: READ_MAX_BYTES },
        'huge.txt',
      )
      expect(second.lines[0]).toMatchObject({ startByte: 2000, endByte: 4000, complete: false })
      expect(second.next).toEqual({ offset: 1, lineByteOffset: 4000 })
    }, 15_000)

    it('uses UTF-8 byte cursors and rejects a cursor inside a multibyte code point', async () => {
      const first = await buildWindow(
        whole('a😀b'),
        { offset: 1, lineByteOffset: 0, limit: 1, maxLineLength: 2, maxBytes: 100 },
        'unicode.txt',
      )
      expect(first.lines).toEqual([{
        number: 1, text: 'a😀', startByte: 0, endByte: 5, complete: false,
      }])
      expect(first.next).toEqual({ offset: 1, lineByteOffset: 5 })

      await expect(buildWindow(
        whole('a😀b'),
        { offset: 1, lineByteOffset: 2, limit: 1, maxLineLength: 2, maxBytes: 100 },
        'unicode.txt',
      )).rejects.toThrow('UTF-8 boundary')
    })

    it('keeps a supplementary code point split across provider chunks intact', async () => {
      const result = await buildWindow(
        ['a\ud83d', '\ude00b'],
        { offset: 1, limit: 1, maxLineLength: 2, maxBytes: 100 },
        'unicode-split.txt',
      )
      expect(result.lines).toEqual([{
        number: 1, text: 'a😀', startByte: 0, endByte: 5, complete: false,
      }])
      expect(result.next).toEqual({ offset: 1, lineByteOffset: 5 })
    })

    it('does not concatenate an oversized provider chunk before bounding the retained fragment', async () => {
      const result = await buildWindow(
        whole('x'.repeat(2 * 1024 * 1024)),
        { offset: 1, lineByteOffset: 0, limit: 1, maxLineLength: 32, maxBytes: 100 },
        'one-chunk.txt',
      )
      expect(result.lines[0]).toEqual({ number: 1, text: 'x'.repeat(32), startByte: 0, endByte: 32, complete: false })
    })

    it('caps output bytes mid-stream', async () => {
      const big = Array.from({ length: 2000 }, () => 'y'.repeat(100)).join('\n')
      const result = await buildWindow(chunked(big, 512), READ_ALL, 'f')
      expect(result.totalLines).toBeUndefined()
      expect(result.truncatedByBytes).toBe(true)
    })

    it('flushes a final newline-terminated line across a chunk boundary', async () => {
      const result = await buildWindow(chunked('one\ntwo\n', 3), READ_ALL, 'f')
      expect(result.lines.map(l => l.text)).toEqual(['one', 'two'])
    })
  })

  describe('legacy and boundary line endings', () => {
    it('keeps a lone carriage return as line content rather than a line break', async () => {
      const result = await buildWindow(whole('one\rtwo\nthree'), READ_ALL, 'f')
      expect(result.lines).toEqual([
        { number: 1, text: 'one\rtwo' },
        { number: 2, text: 'three' },
      ])
      expect(result.totalLines).toBe(2)
    })

    it('keeps a carriage return that ends the file as line content', async () => {
      const result = await buildWindow(whole('one\r'), READ_ALL, 'f')
      expect(result.lines).toEqual([{ number: 1, text: 'one\r' }])
      expect(result.totalLines).toBe(1)
    })

    it('keeps a carriage return split from its newline across chunks as one break', async () => {
      const result = await buildWindow(['one\r', '\ntwo'], READ_ALL, 'f')
      expect(result.lines.map(l => l.text)).toEqual(['one', 'two'])
    })

    it('keeps an unpaired high surrogate that ends the file', async () => {
      const result = await buildWindow(['a\ud83d'], READ_ALL, 'f')
      expect(result.lines).toEqual([{ number: 1, text: 'a\ud83d' }])
    })
  })

  describe('byte caps below one code point', () => {
    it('refuses a byte cap that cannot return the first code point of the first line', async () => {
      await expect(buildWindow(whole('é'), { offset: 1, limit: 10, maxLineLength: 2000, maxBytes: 1 }, 'f'))
        .rejects.toThrow('readMaxBytes is too small to return one UTF-8 code point')
    })

    it('reports the next line as the cursor when the byte cap falls exactly between lines', async () => {
      const result = await buildWindow(whole('aaaa\nbbbb'), { offset: 1, limit: 10, maxLineLength: 2000, maxBytes: 4 }, 'f')
      expect(result.lines).toEqual([{ number: 1, text: 'aaaa' }])
      expect(result.next).toEqual({ offset: 2, lineByteOffset: 0 })
      expect(result.truncatedByBytes).toBe(true)
    })
  })

  describe('line_byte_offset range', () => {
    it('refuses a byte offset past the end of the requested line', async () => {
      await expect(buildWindow(
        whole('one\ntwo'),
        { offset: 1, lineByteOffset: 99, limit: 1, ...DEFAULT_CAPS },
        'short.txt',
      )).rejects.toThrow('line_byte_offset 99 is out of range for line 1 of "short.txt" (3 bytes)')
    })

    it('accepts a byte offset at the exact end of the requested line', async () => {
      const result = await buildWindow(
        whole('one\ntwo'),
        { offset: 1, lineByteOffset: 3, limit: 1, ...DEFAULT_CAPS },
        'short.txt',
      )
      expect(result.lines).toEqual([{ number: 1, text: '', startByte: 3, endByte: 3, complete: true }])
    })
  })
})

describe('formatReadOutput', () => {
  it('names the same-line byte cursor when a long line continues', () => {
    const rendered = formatReadOutput('a.txt', {
      offset: 1,
      lines: [{ number: 1, text: 'abc', startByte: 0, endByte: 3, complete: false }],
      next: { offset: 1, lineByteOffset: 3 },
    })
    expect(rendered).toContain('1 [bytes 0-3]: abc')
    expect(rendered).toContain('(Line 1 continues. Use offset=1 and line_byte_offset=3.)')
  })

  it('names the next line when more lines remain within a known total', () => {
    expect(formatReadOutput('a.txt', {
      offset: 1, lines: [{ number: 1, text: 'one' }], totalLines: 3, next: { offset: 2, lineByteOffset: 0 },
    })).toContain('(Showing lines 1-1 of 3. Use offset=2 to continue.)')
  })

  it('derives the continuation from the last returned line when no cursor is given', () => {
    expect(formatReadOutput('a.txt', {
      offset: 1, lines: [{ number: 1, text: 'one' }], totalLines: 3,
    })).toContain('(Showing lines 1-1 of 3. Use offset=2 to continue.)')
  })

  it('reports end of file when the window reached the known total', () => {
    expect(formatReadOutput('a.txt', {
      offset: 1, lines: [{ number: 1, text: 'one' }], totalLines: 1,
    })).toContain('(End of file - total 1 lines)')
  })

  it('states that content may remain when the total is unknown', () => {
    const rendered = formatReadOutput('a.txt', { offset: 1, lines: [{ number: 1, text: 'one' }] })
    expect(rendered).toContain('(More file content may remain.)')
  })

  it('renders an empty window as the footer alone and escapes the path', () => {
    expect(formatReadOutput('a<&>b.txt', { offset: 1, lines: [], totalLines: 0 }))
      .toBe(`<path>a&lt;&amp;&gt;b.txt</path>
<type>file</type>
<content>
(End of file - total 0 lines)
</content>`)
  })
})

describe('langFromPath', () => {
  it('maps a known extension to its language hint, case-insensitively', () => {
    expect(langFromPath('src/a.ts')).toBe('ts')
    expect(langFromPath('src/a.TSX')).toBe('tsx')
    expect(langFromPath('/abs/module.mjs')).toBe('js')
    expect(langFromPath('conf.yml')).toBe('yaml')
    expect(langFromPath('README.md')).toBe('md')
  })

  it('reads the extension after the last path segment and last dot', () => {
    expect(langFromPath('a.py.bak')).toBeUndefined()
    expect(langFromPath('archive.tar.gz')).toBeUndefined()
    expect(langFromPath('/dir.py/plain')).toBeUndefined()
    expect(langFromPath('C:\\src\\main.rs')).toBe('rs')
  })

  it('returns undefined for a dotfile, an extensionless name, and an unknown extension', () => {
    expect(langFromPath('.gitignore')).toBeUndefined()
    expect(langFromPath('/etc/hosts')).toBeUndefined()
    expect(langFromPath('data.unknownext')).toBeUndefined()
    expect(langFromPath('trailingdot.')).toBeUndefined()
  })

  it('returns undefined for a filename whose extension is an Object.prototype key', () => {
    // Own-property lookup only: these must not resolve to the inherited member
    // (a function/object), which would fail the tool-output JSON validation.
    expect(langFromPath('foo.constructor')).toBeUndefined()
    expect(langFromPath('foo.__proto__')).toBeUndefined()
    expect(langFromPath('foo.toString')).toBeUndefined()
    expect(langFromPath('foo.hasOwnProperty')).toBeUndefined()
  })
})

describe('readMetaFromMeta', () => {
  const good = { path: '/abs/a.ts', offset: 1, lines: [{ number: 1, text: 'x' }], totalLines: 1, lang: 'ts' }

  it('narrows a well-formed read meta, with and without a lang hint', () => {
    expect(readMetaFromMeta(good)).toEqual(good)
    const noLang = { path: '/abs/a', offset: 1, lines: [], totalLines: 0 }
    expect(readMetaFromMeta(noLang)).toEqual(noLang)
  })

  it('narrows an empty window at a positive offset (byte cap below the first selected line)', () => {
    const empty = { path: '/abs/a', offset: 5, lines: [], totalLines: 9 }
    expect(readMetaFromMeta(empty)).toEqual(empty)
  })

  it('returns undefined for absent, non-object, or array meta', () => {
    expect(readMetaFromMeta(undefined)).toBeUndefined()
    expect(readMetaFromMeta(null)).toBeUndefined()
    expect(readMetaFromMeta('nope')).toBeUndefined()
    expect(readMetaFromMeta([good])).toBeUndefined()
  })

  it('returns undefined when a field is missing or the wrong type (defensive narrowing)', () => {
    expect(readMetaFromMeta({ ...good, path: 5 })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, offset: '1' })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, totalLines: '1' })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, lines: 'nope' })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, lines: [{ number: '1', text: 'x' }] })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, lines: [{ number: 1 }] })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, lines: [null] })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, lang: 5 })).toBeUndefined()
  })

  it('rejects an offset that is not a 1-based integer', () => {
    expect(readMetaFromMeta({ ...good, offset: 0 })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, offset: 1.5 })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, offset: NaN })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, offset: Infinity })).toBeUndefined()
  })

  it('rejects a first line number below offset', () => {
    expect(readMetaFromMeta({ ...good, offset: 2, lines: [{ number: 1, text: 'x' }], totalLines: 2 })).toBeUndefined()
  })

  it('rejects a line number that is not a 1-based integer', () => {
    expect(readMetaFromMeta({ ...good, lines: [{ number: 0, text: 'x' }], totalLines: 1 })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, lines: [{ number: 1.5, text: 'x' }], totalLines: 2 })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, lines: [{ number: NaN, text: 'x' }], totalLines: 1 })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, lines: [{ number: Infinity, text: 'x' }], totalLines: 1 })).toBeUndefined()
  })

  it('rejects a totalLines that is not a non-negative integer', () => {
    expect(readMetaFromMeta({ ...good, totalLines: -1 })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, totalLines: 1.5 })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, totalLines: NaN })).toBeUndefined()
  })

  it('narrows a continuation cursor and keeps it on the result', () => {
    const withNext = { ...good, totalLines: 2, next: { offset: 2, lineByteOffset: 0 } }
    expect(readMetaFromMeta(withNext)).toEqual(withNext)
    const sameLine = { ...good, next: { offset: 1, lineByteOffset: 5 } }
    expect(readMetaFromMeta(sameLine)).toEqual(sameLine)
  })

  it('returns undefined for a continuation cursor that is not a cursor object', () => {
    for (const next of ['nope', 7, null, [2, 0], true]) {
      expect(readMetaFromMeta({ ...good, next })).toBeUndefined()
    }
  })

  it('returns undefined for a continuation offset that is not a 1-based integer', () => {
    for (const offset of ['2', 0, -1, 1.5, NaN, Infinity, undefined]) {
      expect(readMetaFromMeta({ ...good, next: { offset, lineByteOffset: 0 } })).toBeUndefined()
    }
  })

  it('returns undefined for a continuation byte offset that is not a non-negative integer', () => {
    for (const lineByteOffset of ['0', -1, 1.5, NaN, Infinity, undefined]) {
      expect(readMetaFromMeta({ ...good, next: { offset: 1, lineByteOffset } })).toBeUndefined()
    }
  })

  it('rejects lines that do not strictly increase or exceed totalLines', () => {
    const twoLines = { path: '/abs/a', offset: 1, lang: 'ts' }
    // Duplicate line numbers.
    expect(readMetaFromMeta({ ...twoLines, lines: [{ number: 1, text: 'a' }, { number: 1, text: 'b' }], totalLines: 2 })).toBeUndefined()
    // Out-of-order line numbers.
    expect(readMetaFromMeta({ ...twoLines, lines: [{ number: 2, text: 'b' }, { number: 1, text: 'a' }], totalLines: 2 })).toBeUndefined()
    // A line number past totalLines.
    expect(readMetaFromMeta({ ...twoLines, lines: [{ number: 3, text: 'c' }], totalLines: 2 })).toBeUndefined()
  })
})
