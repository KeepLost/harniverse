import { describe, expect, it } from 'vitest'
import { en, NS, zh } from '../src/client/locales.ts'

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1] as string).sort()

describe('skin dictionaries', () => {
  it('registers under the settings.skin namespace', () => {
    expect(NS).toBe('settings.skin')
  })

  it('carries the same keys in both languages', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('uses the same placeholders in both languages and never leaves a value empty', () => {
    for (const [key, text] of Object.entries(zh)) {
      expect(placeholders(en[key as keyof typeof en]), key).toEqual(placeholders(text))
      expect(text.trim(), key).not.toBe('')
      expect(en[key as keyof typeof en].trim(), key).not.toBe('')
    }
  })

  it('keeps product copy Chinese in the key-source dictionary', () => {
    for (const [key, text] of Object.entries(zh)) {
      if (key.endsWith('blurValue') || key.endsWith('percent')) continue
      expect(/[\u4e00-\u9fff]/.test(text), key).toBe(true)
    }
  })
})
