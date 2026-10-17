/** The `settings.mcp` dictionaries: the English bundle keys the Chinese source of truth exactly, and both render params. */

import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

describe('settings.mcp dictionaries', () => {
  it('keys the English bundle by the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('ships non-empty copy for every key in both languages', () => {
    for (const text of Object.values(zh)) expect(text.length).toBeGreaterThan(0)
    for (const text of Object.values(en)) expect(text.length).toBeGreaterThan(0)
  })

  it('keeps {placeholder} params aligned between the two languages', () => {
    const params = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1] as string).sort()
    for (const key of Object.keys(zh)) expect(params(en[key as keyof typeof en])).toEqual(params(zh[key as keyof typeof zh]))
  })
})
