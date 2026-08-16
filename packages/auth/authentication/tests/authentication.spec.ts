import { describe, expect, it } from 'vitest'
import { authenticationTokenId, authenticationTokenName } from '../src/index.ts'

describe('authentication token identities', () => {
  it('brands unambiguous lowercase token names', () => {
    expect(authenticationTokenName('laptop')).toBe('laptop')
    expect(authenticationTokenName('ci-runner.2')).toBe('ci-runner.2')
  })

  it('rejects ambiguous or unsafe token names', () => {
    for (const value of ['', 'Phone', '-leading', 'with space', 'a'.repeat(65)]) {
      expect(() => authenticationTokenName(value)).toThrow(TypeError)
    }
  })

  it('rejects an empty provider token id', () => {
    expect(authenticationTokenId('opaque')).toBe('opaque')
    expect(() => authenticationTokenId('')).toThrow(TypeError)
  })
})
