import { describe, expect, it } from 'vitest'
import { createLazyRequire } from '../src/index.ts'
import { createRequire } from 'node:module'

describe('createLazyRequire', () => {
  it('resolves the specifier relative to the caller parent URL on first use only', () => {
    const load = createLazyRequire<{ join: (a: string, b: string) => string }>('node:path', import.meta.url)
    const first = load()
    expect(first.join('a', 'b')).toBe('a/b')
    expect(load()).toBe(first)
  })

  it('does not touch the module system before the first call', () => {
    const specifier = `./nonexistent-${Date.now()}.cjs`
    const require = createRequire(import.meta.url)
    const load = createLazyRequire(specifier, import.meta.url)
    expect(() => require.resolve(specifier)).toThrow()
    // Constructing the loader must not attempt or observe any load.
    const unused = load
    void unused
    expect(() => load()).toThrow(/Cannot find module/)
  })

  it('keeps a failed load uncached so a corrected installation can be retried', () => {
    const specifier = './missing-retry-target.cjs'
    const load = createLazyRequire<{ marker: true }>(specifier, new URL('./fixtures/missing/anchor.cjs', import.meta.url))
    expect(() => load()).toThrow(/Cannot find module/)
    // After the underlying file appears, the same loader recovers.
    const loadPresent = createLazyRequire<{ marker: true }>('./present-target.cjs', new URL('./fixtures/anchor.cjs', import.meta.url))
    expect(loadPresent().marker).toBe(true)
  })
})
