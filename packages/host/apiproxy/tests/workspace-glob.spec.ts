/**
 * Workspace search glob contract: pattern scope follows shape (basename, path,
 * directory subtree), matching is case-insensitive, and walk pruning agrees
 * with matching so an anchored include list cannot spend scan budget elsewhere.
 */
import { describe, expect, it } from 'vitest'
import {
  compileGlobFilter, WORKSPACE_SEARCH_DEFAULT_EXCLUDES,
} from '../src/api/workspace-glob.ts'

describe('compileGlobFilter scope', () => {
  it('applies a separator-free pattern to the basename at any depth', () => {
    const filter = compileGlobFilter(['*.py'], 'pass')

    expect(filter.matches('main.py')).toBe(true)
    expect(filter.matches('deep/nested/tree/main.py')).toBe(true)
    expect(filter.matches('main.pyc')).toBe(false)
    expect(filter.matches('py/readme.md')).toBe(false)
  })

  it('applies a pattern containing a separator to the whole relative path', () => {
    const filter = compileGlobFilter(['src/**/*.ts'], 'pass')

    expect(filter.matches('src/client/app.ts')).toBe(true)
    expect(filter.matches('src/app.ts')).toBe(true)
    expect(filter.matches('tests/app.ts')).toBe(false)
  })

  it('accepts root-marked relative-path patterns', () => {
    const slash = compileGlobFilter(['/*.ts'], 'pass')
    const dot = compileGlobFilter(['./src/**'], 'pass')

    expect([slash.matches('app.ts'), slash.matches('src/app.ts')]).toEqual([true, false])
    expect([dot.matches('src/app.ts'), dot.matches('nested/src/app.ts')]).toEqual([true, false])
  })

  it('keeps rooted trailing-directory patterns at the workspace root', () => {
    const dot = compileGlobFilter(['./src/'], 'reject')
    const slash = compileGlobFilter(['/dist/'], 'reject')

    expect([dot.matches('src/app.ts'), dot.matches('nested/src/app.ts')]).toEqual([true, false])
    expect([dot.matchesDirectory('src'), dot.matchesDirectory('nested/src')]).toEqual([true, false])
    expect([slash.matches('dist/app.js'), slash.matches('packages/dist/app.js')]).toEqual([true, false])
    expect([slash.matchesDirectory('dist'), slash.matchesDirectory('packages/dist')]).toEqual([true, false])
  })

  it('prunes every directory for a root subtree exclusion', () => {
    const slash = compileGlobFilter(['/**'], 'reject')
    const dot = compileGlobFilter(['./**'], 'reject')

    expect(slash.matchesDirectory('')).toBe(true)
    expect(slash.matchesDirectory('src')).toBe(true)
    expect(dot.matchesDirectory('nested')).toBe(true)
  })

  it('covers a directory subtree for a trailing-separator pattern', () => {
    const filter = compileGlobFilter(['dist/'], 'reject')

    expect(filter.matches('dist/bundle.js')).toBe(true)
    expect(filter.matches('dist/nested/bundle.js')).toBe(true)
    expect(filter.matchesDirectory('dist')).toBe(true)
    expect(filter.matches('dist')).toBe(false)
    expect(filter.matches('distribution/bundle.js')).toBe(false)
  })

  it('covers the root and direct files for a recursive trailing-separator pattern', () => {
    const filter = compileGlobFilter(['dist/**/'], 'reject')

    expect(filter.matchesDirectory('dist')).toBe(true)
    expect(filter.matches('dist/index.js')).toBe(true)
    expect(filter.matches('dist/nested/index.js')).toBe(true)
    expect(filter.matches('packages/dist/index.js')).toBe(false)
  })

  it('applies a bare directory name at any depth and an anchored one only there', () => {
    const anywhere = compileGlobFilter(['node_modules/'], 'reject')
    const anchored = compileGlobFilter(['src/generated/'], 'reject')

    expect(anywhere.matches('packages/app/node_modules/dep/index.js')).toBe(true)
    expect(anywhere.matchesDirectory('packages/app/node_modules')).toBe(true)
    expect(anchored.matches('src/generated/api.ts')).toBe(true)
    expect(anchored.matches('packages/src/generated/api.ts')).toBe(false)
  })
})

describe('compileGlobFilter syntax', () => {
  it('matches case-insensitively, like the name query it scopes', () => {
    expect(compileGlobFilter(['*.PY'], 'pass').matches('Main.py')).toBe(true)
  })

  it('expands brace alternation and character classes', () => {
    const braces = compileGlobFilter(['*.{ts,tsx}'], 'pass')
    const classes = compileGlobFilter(['test[0-9].py'], 'pass')
    const negated = compileGlobFilter(['[!_]*.ts'], 'pass')

    expect([braces.matches('a.ts'), braces.matches('a.tsx'), braces.matches('a.js')]).toEqual([true, true, false])
    expect([classes.matches('test4.py'), classes.matches('testx.py')]).toEqual([true, false])
    expect([negated.matches('app.ts'), negated.matches('_private.ts')]).toEqual([true, false])
  })

  it('keeps `*` inside one segment and lets `**` cross separators', () => {
    const single = compileGlobFilter(['src/*.ts'], 'pass')
    const double = compileGlobFilter(['src/**'], 'pass')

    expect([single.matches('src/app.ts'), single.matches('src/client/app.ts')]).toEqual([true, false])
    expect(double.matches('src/client/deep/app.ts')).toBe(true)
    expect(double.matchesDirectory('src')).toBe(true)
    expect(double.matchesDirectory('dist')).toBe(false)
  })

  it('prunes path-scoped patterns after their last possible file directory', () => {
    const direct = compileGlobFilter(['/*.ts'], 'pass')
    const nested = compileGlobFilter(['*/foo.ts'], 'pass')
    const directory = compileGlobFilter(['foo/bar/'], 'pass')

    expect(direct.mayContainMatch('src')).toBe(false)
    expect(nested.mayContainMatch('src')).toBe(true)
    expect(nested.mayContainMatch('src/deep')).toBe(false)
    expect(directory.mayContainMatch('foo')).toBe(true)
    expect(directory.mayContainMatch('foo/other')).toBe(false)
  })

  it('prunes the directory root covered by a path subtree exclusion', () => {
    const filter = compileGlobFilter(['dist/**', 'packages/*/generated/**'], 'reject')

    expect(filter.matchesDirectory('dist')).toBe(true)
    expect(filter.matchesDirectory('packages/app/generated')).toBe(true)
    expect(filter.matchesDirectory('packages/app/src')).toBe(false)
  })

  it('matches `?` against exactly one non-separator character', () => {
    const filter = compileGlobFilter(['a?.ts'], 'pass')

    expect([filter.matches('ab.ts'), filter.matches('abc.ts'), filter.matches('a.ts')]).toEqual([true, false, false])
  })

  it('treats a regular-expression metacharacter as a literal', () => {
    const filter = compileGlobFilter(['a+b(1).ts'], 'pass')

    expect(filter.matches('a+b(1).ts')).toBe(true)
    expect(filter.matches('aab1.ts')).toBe(false)
  })

  it('treats an unterminated brace or class as a literal character', () => {
    expect(compileGlobFilter(['a{b.ts'], 'pass').matches('a{b.ts')).toBe(true)
    expect(compileGlobFilter(['a[b.ts'], 'pass').matches('a[b.ts')).toBe(true)
  })

  it('treats a malformed character range as a literal pattern', () => {
    const filter = compileGlobFilter(['[z-a].ts'], 'pass')

    expect(filter.matches('[z-a].ts')).toBe(true)
    expect(filter.matches('z.ts')).toBe(false)
  })

  it('treats an empty negated class as a literal pattern', () => {
    const filter = compileGlobFilter(['[!]'], 'pass')

    expect(filter.matches('[!]')).toBe(true)
    expect(filter.matches('a')).toBe(false)
  })

  it('treats an unterminated class inside an alternation as a literal pattern', () => {
    const filter = compileGlobFilter(['{a,[b}'], 'pass')

    expect(filter.matches('{a,[b}')).toBe(true)
    expect(filter.matches('a')).toBe(false)
    expect(filter.matches('[b')).toBe(false)
  })

  it('treats a nested character class as a literal pattern', () => {
    const filter = compileGlobFilter(['[a[b]'], 'pass')

    expect(filter.matches('[a[b]')).toBe(true)
    expect(filter.matches('a')).toBe(false)
  })

  it('matches long wildcard runs without regex backtracking', () => {
    const raw = `${'**'.repeat(20)}Z`
    const filter = compileGlobFilter([raw], 'pass')

    expect(filter.matches(`${'x'.repeat(255)}Z`)).toBe(true)
  })
})

describe('compileGlobFilter empty lists', () => {
  it('passes everything for an absent include list and nothing for an absent exclude list', () => {
    expect(compileGlobFilter(undefined, 'pass').matches('anything.py')).toBe(true)
    expect(compileGlobFilter(undefined, 'reject').matches('anything.py')).toBe(false)
    expect(compileGlobFilter([], 'pass').empty).toBe(true)
  })

  it('drops a pattern with no usable body', () => {
    expect(compileGlobFilter(['   ', '/'], 'pass').empty).toBe(true)
    expect(compileGlobFilter(['  *.py  '], 'pass').matches('main.py')).toBe(true)
  })
})

describe('compileGlobFilter walk pruning', () => {
  it('lets an unanchored include list reach every directory', () => {
    const filter = compileGlobFilter(['*.py'], 'pass')

    expect(filter.mayContainMatch('')).toBe(true)
    expect(filter.mayContainMatch('deep/nested')).toBe(true)
  })

  it('prunes directories outside an anchored include list', () => {
    const filter = compileGlobFilter(['src/client/**/*.ts'], 'pass')

    expect(filter.mayContainMatch('')).toBe(true)
    expect(filter.mayContainMatch('src')).toBe(true)
    expect(filter.mayContainMatch('src/client')).toBe(true)
    expect(filter.mayContainMatch('src/client/deep')).toBe(true)
    expect(filter.mayContainMatch('tests')).toBe(false)
    expect(filter.mayContainMatch('src/host')).toBe(false)
  })

  it('prunes anchored includes case-insensitively like their matchers', () => {
    const filter = compileGlobFilter(['src/**'], 'pass')

    expect(filter.matches('SRC/main.ts')).toBe(true)
    expect(filter.mayContainMatch('SRC')).toBe(true)
    expect(filter.mayContainMatch('ſrc')).toBe(true)
    expect(filter.mayContainMatch('Tests')).toBe(false)
  })

  it('keeps every anchor reachable when one pattern is unanchored', () => {
    const filter = compileGlobFilter(['src/**/*.ts', '*.md'], 'pass')

    expect(filter.mayContainMatch('docs')).toBe(true)
  })
})

describe('WORKSPACE_SEARCH_DEFAULT_EXCLUDES', () => {
  it('skips dependency and build trees at any depth while keeping source', () => {
    const filter = compileGlobFilter(WORKSPACE_SEARCH_DEFAULT_EXCLUDES, 'reject')

    expect(filter.matchesDirectory('node_modules')).toBe(true)
    expect(filter.matchesDirectory('packages/app/node_modules')).toBe(true)
    expect(filter.matchesDirectory('packages/app/dist')).toBe(true)
    expect(filter.matches('packages/app/lib/index.js')).toBe(true)
    expect(filter.matchesDirectory('packages/app/src')).toBe(false)
    expect(filter.matches('packages/app/src/index.ts')).toBe(false)
  })
})
