import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  binSources, excludedEntry, findTopLevelAwaits, scanRepository, sourceCorpus,
} from './verify-no-top-level-await.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('module-scope await detection', () => {
  it('rejects the process-entry shape the rule exists for', () => {
    expect(findTopLevelAwaits('packages/demo/demo/src/index.ts', [
      'import { start } from "./start.ts"',
      '',
      'await start()',
      '',
    ].join('\n'))).toEqual([
      expect.objectContaining({ what: 'await expression', line: 3 }),
    ])
  })

  it('reports the offending line number and text', () => {
    expect(findTopLevelAwaits('packages/demo/demo/src/index.ts', [
      'const first = 1',
      '  await prepare(first)  ',
      'export const second = 2',
    ].join('\n'))).toEqual([
      { file: 'packages/demo/demo/src/index.ts', line: 2, what: 'await expression', text: 'await prepare(first)' },
    ])
  })

  it('accepts an await inside a function body, including a nested arrow in a top-level block', () => {
    expect(findTopLevelAwaits('packages/demo/demo/src/index.ts', [
      'export async function main(): Promise<void> {',
      '  await Promise.resolve()',
      '}',
      '',
      '{',
      '  const nested = async (): Promise<void> => { await Promise.resolve() }',
      '  void nested()',
      '}',
      '',
      'void main()',
    ].join('\n'))).toEqual([])
  })

  it('accepts an await in default and decorator parameter positions, which run at module scope only semantically', () => {
    expect(findTopLevelAwaits('packages/demo/demo/src/index.ts', [
      'export const make = async (input: Promise<string> = await Promise.resolve("x")): Promise<string> => input',
      'export const after = make()',
    ].join('\n'))).toEqual([])
  })

  it('rejects a module-scope for await loop', () => {
    expect(findTopLevelAwaits('packages/demo/demo/src/index.ts', [
      'for await (const item of items) consume(item)',
    ].join('\n'))).toEqual([
      expect.objectContaining({ what: 'for await loop', line: 1 }),
    ])
  })

  it('rejects a for await loop nested in a top-level block', () => {
    expect(findTopLevelAwaits('packages/demo/demo/src/index.ts', [
      'if (ready) {',
      '  for await (const item of items) consume(item)',
      '}',
    ].join('\n'))).toEqual([
      expect.objectContaining({ what: 'for await loop', line: 2 }),
    ])
  })

  it('rejects a module-scope await using declaration', () => {
    expect(findTopLevelAwaits('packages/demo/demo/src/index.ts', [
      'await using lock = openLock()',
    ].join('\n'))).toEqual([
      expect.objectContaining({ what: 'await using declaration', line: 1 }),
    ])
  })

  it('rejects a module-scope await in a TSX module', () => {
    expect(findTopLevelAwaits('packages/demo/demo/src/index.tsx', [
      'export const ready = await prepare()',
    ].join('\n'))).toEqual([
      expect.objectContaining({ file: 'packages/demo/demo/src/index.tsx', line: 1 }),
    ])
  })

  it('rejects an await inside a computed member name, which runs where the class is defined', () => {
    expect(findTopLevelAwaits('packages/demo/demo/src/index.ts', [
      'const table = { async key(): Promise<string> { return "k" } }',
      'class Holder {',
      '  [(await table.key())]: number = 1',
      '}',
      'export const holder = new Holder()',
    ].join('\n'))).toEqual([
      expect.objectContaining({ what: 'await expression', line: 3 }),
    ])
  })

  it('accepts the word await in strings, templates, and comments', () => {
    expect(findTopLevelAwaits('packages/demo/demo/src/index.ts', [
      'export const note = "await nothing"',
      'export const template = `for await (const x of y)`',
      '// await using nothing',
      'export const word = "await".length',
    ].join('\n'))).toEqual([])
  })

  it('accepts a synchronous using declaration', () => {
    expect(findTopLevelAwaits('packages/demo/demo/src/index.ts', [
      'using resource = openResource()',
    ].join('\n'))).toEqual([])
  })
})

describe('executable exclusion', () => {
  it('excludes a source that starts with a shebang line, and only that file', () => {
    const bins = new Set(['packages/demo/demo/src/cli.ts'])
    expect(excludedEntry('packages/demo/demo/src/cli.ts', '#!/usr/bin/env node\nvoid main()\n', bins)).toBe('shebang')
    expect(excludedEntry('packages/demo/demo/src/cli.ts', 'void main()\n', bins)).toBe('bin')
    expect(excludedEntry('packages/demo/demo/src/index.ts', 'export const value = 1\n', bins)).toBeUndefined()
  })

  it('excludes the sources of build outputs a manifest bin field names, in map and string forms', () => {
    expect(binSources('packages/demo/demo', { demo: 'lib/bin/demo.js' })).toEqual([
      'packages/demo/demo/src/bin/demo.ts',
      'packages/demo/demo/src/bin/demo.tsx',
    ])
    expect(binSources('packages/demo/demo', 'lib/cli.js')).toEqual([
      'packages/demo/demo/src/cli.ts',
      'packages/demo/demo/src/cli.tsx',
    ])
    expect(binSources('packages/demo/demo', { other: 'src/standalone.js' })).toEqual([])
    expect(binSources('packages/demo/demo', undefined)).toEqual([])
  })
})

describe('package source corpus', () => {
  it('covers every package source directory with TypeScript or TSX files', () => {
    const corpus = sourceCorpus()
    expect(corpus.length).toBeGreaterThan(0)
    expect(corpus).toEqual([...corpus].sort())
    for (const file of corpus) expect(file.startsWith('packages/') && file.includes('/src/')).toBe(true)
  })

  it('refuses a narrowed corpus pattern that would pass by scanning less', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-no-top-level-await-'))
    roots.push(root)
    mkdirSync(join(root, 'packages/demo/demo/src'), { recursive: true })
    writeFileSync(join(root, 'packages/demo/demo/src/index.ts'), 'export const value = 1\n')
    writeFileSync(join(root, 'packages/demo/demo/src/view.tsx'), 'export const view = 1\n')
    mkdirSync(join(root, 'packages/demo/other/src'), { recursive: true })
    writeFileSync(join(root, 'packages/demo/other/src/index.ts'), 'export const value = 2\n')

    expect(() => sourceCorpus(root, 'packages/demo/demo/src/**/*.{ts,tsx}')).toThrow(
      'leaves out package sources: packages/demo/other/src.',
    )
  })

  it('refuses an empty corpus', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-no-top-level-await-'))
    roots.push(root)
    mkdirSync(join(root, 'packages'), { recursive: true })

    expect(() => sourceCorpus(root)).toThrow('scanned an empty corpus')
  })
})

describe('repository scan', () => {
  it('reports the shipped corpus with no module-scope await and bins excluded by name', () => {
    const { checked, excluded, violations } = scanRepository()

    expect(checked).toBeGreaterThan(0)
    expect(excluded.every(entry => entry.reason === 'shebang' || entry.reason === 'bin')).toBe(true)
    expect(violations).toEqual([])
  })
})
