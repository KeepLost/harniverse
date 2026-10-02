import { describe, expect, it } from 'vitest'
import { en, shellCopy, zh } from '../src/locale.ts'

describe('desktop shell copy', () => {
  it('keeps the Chinese table key-complete with the English table', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const value of Object.values(zh)) expect(typeof value).toBe('string')
  })

  it('keeps brand-neutral placeholders shared and interpolates with {name} markers', () => {
    expect(zh.hostPlaceholder).toBe(en.hostPlaceholder)
    for (const table of [en, zh]) {
      expect(table.connectingTo).toContain('{target}')
      expect(table.quitMessage).toContain('{action}')
      expect(table.warnActive).toContain('{sessions}')
      expect(table.warnActive).toContain('{tasks}')
    }
  })

  it('selects Chinese only for zh locales and defaults to English', () => {
    expect(shellCopy('zh-CN')).toBe(zh)
    expect(shellCopy('zh_TW')).toBe(zh)
    expect(shellCopy('zh')).toBe(zh)
    expect(shellCopy('en-US')).toBe(en)
    expect(shellCopy('ja')).toBe(en)
    expect(shellCopy(undefined)).toBe(en)
  })
})
