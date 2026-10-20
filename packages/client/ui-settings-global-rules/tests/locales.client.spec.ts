/**
 * Locale dictionaries: the English mirror carries exactly the Chinese
 * key set, and the shipped Chinese copy is the authoritative product copy.
 */

import { describe, expect, it } from 'vitest'
import { en, NS, zh } from '../src/client/locales.ts'

describe('settings.global-rules dictionaries', () => {
  it('declares the namespace it registers', () => {
    expect(NS).toBe('settings.global-rules')
  })

  it('mirrors the Chinese key set in English', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('ships non-empty product copy for every key', () => {
    for (const [key, copy] of Object.entries(zh)) {
      expect(copy.length, key).toBeGreaterThan(0)
    }
  })
})
