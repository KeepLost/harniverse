import { describe, expect, it } from 'vitest'
import { accentChip, accentHover, accentSoft, HOVER_SHIFT, isSafeColor, mixHex, parseHex, toHex } from '../src/client/color.ts'

describe('colour helpers', () => {
  it('round-trips hex through channels', () => {
    expect(parseHex('#4176e6')).toEqual({ r: 65, g: 118, b: 230 })
    expect(toHex({ r: 65, g: 118, b: 230 })).toBe('#4176e6')
    expect(toHex({ r: 0, g: 5, b: 255 })).toBe('#0005ff')
    expect(Number.isNaN(parseHex('nonsense').r)).toBe(true)
  })

  it('mixes channels linearly and rounds', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
  })

  it('moves the hover accent toward white on light and toward black on dark', () => {
    expect(HOVER_SHIFT).toBe(0.2)
    expect(accentHover('#4176e6', 'light')).toBe('#6791eb')
    expect(accentHover('#4176e6', 'dark')).toBe('#345eb8')
    expect(accentHover('#ffffff', 'light')).toBe('#ffffff')
    expect(accentHover('#000000', 'dark')).toBe('#000000')
  })

  it('keeps the soft accent translucent', () => {
    expect(accentSoft('#4176e6')).toBe('color-mix(in srgb, #4176e6 18%, transparent)')
  })

  it('tints a reference chip a little stronger than the soft state, still translucent', () => {
    expect(accentChip('#4176e6')).toBe('color-mix(in srgb, #4176e6 22%, transparent)')
  })

  it('accepts only colours from the skin grammar', () => {
    for (const ok of [
      '#fff', '#FFFA', '#12ab9f', '#12ab9f80', 'transparent', 'TRANSPARENT', 'rgb(1, 2, 3)', 'rgba(1,2,3,0.5)',
      'rgb(10 20 30)', 'rgb(10 20 30 / 50%)', 'hsl(210, 40%, 50%)', 'hsla(210 40% 50% / .4)', 'rgb(1.5, -2, +3)',
    ]) expect(isSafeColor(ok), ok).toBe(true)
    for (const bad of [
      '', 'red', '#ff', '#fffff', '#ggg', 'url(x)', 'var(--x)', 'calc(1px)', 'color-mix(in srgb, red, blue)',
      'rgb(1, 2)', 'rgb(1, 2, 3, 4, 5)', 'rgb(1,2,3);', 'rgb(1,2,3) !important', 'rgb(1,2,3}', "rgb(1,2,'3')",
      'rgb(1,2,3)\\', `#${'a'.repeat(70)}`,
    ]) expect(isSafeColor(bad), bad).toBe(false)
    expect(isSafeColor(42)).toBe(false)
    expect(isSafeColor(undefined)).toBe(false)
  })
})
