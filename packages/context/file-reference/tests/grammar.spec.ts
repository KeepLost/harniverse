import { describe, expect, it } from 'vitest'
import { activeAtToken, formatFileMention } from '../src/grammar.ts'

describe('active file token', () => {
  it.each([
    ['at the start of a line', '@src/a', 6, { prefix: '@src/a', query: 'src/a', quoted: false }],
    ['after preceding words', 'read @src/a', 11, { prefix: '@src/a', query: 'src/a', quoted: false }],
    ['with nothing typed yet', 'read @', 6, { prefix: '@', query: '', quoted: false }],
    ['inside an open quote', 'read @"a b', 10, { prefix: '@"a b', query: 'a b', quoted: true }],
    ['as an empty open quote', 'read @"', 7, { prefix: '@"', query: '', quoted: true }],
  ])('recognizes a token %s', (_name, line, cursor, expected) => {
    expect(activeAtToken(line, cursor)).toEqual(expected)
  })

  it.each([
    ['no at sign at all', 'read src/a', 10],
    ['an at sign inside a word', 'mail a@b.test', 13],
    ['a token that already ended', 'read @src/a and more', 20],
    ['a closed quote', 'read @"a b" more', 16],
  ])('reports no token for %s', (_name, line, cursor) => {
    expect(activeAtToken(line, cursor)).toBeUndefined()
  })

  it('reads the token at the cursor rather than the end of the line', () => {
    // The editor may hold text after the cursor; only what precedes it is typed.
    expect(activeAtToken('read @src and later text', 9))
      .toEqual({ prefix: '@src', query: 'src', quoted: false })
  })
})

describe('file mention formatting', () => {
  it.each([
    ['a plain file', { path: 'src/index.ts', kind: 'file' as const }, false, '@src/index.ts'],
    ['a directory', { path: 'src', kind: 'directory' as const }, false, '@src/'],
    ['a file with spaces', { path: 'docs/a b.md', kind: 'file' as const }, false, '@"docs/a b.md"'],
    ['a directory with spaces', { path: 'my docs', kind: 'directory' as const }, false, '@"my docs/'],
    ['a quoted file', { path: 'notes.md', kind: 'file' as const }, true, '@"notes.md"'],
    ['a quoted directory', { path: 'src', kind: 'directory' as const }, true, '@"src/'],
  ])('formats %s', (_name, candidate, preserveQuote, expected) => {
    expect(formatFileMention(candidate, preserveQuote)).toBe(expected)
  })

  it.each([
    ['a newline', 'bad\nname'],
    ['a carriage return', 'bad\rname'],
    ['a tab', 'bad\tname'],
    ['a NUL byte', 'bad\u0000name'],
    ['a DEL byte', 'bad\u007fname'],
    ['a C1 control byte', 'bad\u009fname'],
    ['an embedded quote', 'bad"name'],
  ])('refuses a path carrying %s', (_name, path) => {
    // A mention is ordinary prompt text, so a path that could break out of its
    // own quoting is refused rather than escaped.
    expect(formatFileMention({ path, kind: 'file' }, false)).toBeUndefined()
    expect(formatFileMention({ path, kind: 'directory' }, false)).toBeUndefined()
  })

  it('leaves a directory continuation unterminated so completion can continue', () => {
    // A closing quote would end a path the caller may still be extending.
    expect(formatFileMention({ path: 'a b', kind: 'directory' }, true)).toBe('@"a b/')
    expect(formatFileMention({ path: 'a b', kind: 'file' }, true)).toBe('@"a b"')
  })
})
