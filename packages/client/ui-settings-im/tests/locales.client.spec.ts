import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

/** Placeholder names a template interpolates, sorted. */
const params = (template: string): string[] => [...template.matchAll(/\{(\w+)\}/g)].map(match => match[1]!).sort()

describe('settings.im dictionaries', () => {
  it('carry the same key set in both languages', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('interpolate the same parameters in both languages', () => {
    for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(params(en[key]), key).toEqual(params(zh[key]))
    }
  })

  it('leave no entry blank', () => {
    for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(zh[key].trim(), key).not.toBe('')
      expect(en[key].trim(), key).not.toBe('')
    }
  })
})
