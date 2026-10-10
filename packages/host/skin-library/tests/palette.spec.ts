/** The built-in catalog: identity, contrast, allowlist conformity, and agreement with the shipped CSS. */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILTIN_SKINS, BUILTIN_SKIN_IDS, builtinSkin } from '../src/palette.ts'
import { CORE_TOKENS, MAX_PACK_TOKENS, SKINNABLE_TOKENS, isSkinColor, parseSkinPack, serializeSkinPack } from '../src/pack.ts'

const STYLES = join(import.meta.dirname, '../../../client/ui-theme/src/styles')

/** WCAG relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
}

/** WCAG contrast ratio between two `#rrggbb` colours. */
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light! + 0.05) / (dark! + 0.05)
}

describe('built-in skins', () => {
  it('ships the eight dream-skin palettes in gallery order', () => {
    expect(BUILTIN_SKINS.map(skin => [skin.id, skin.colorScheme])).toEqual([
      ['abyss', 'dark'], ['aurora', 'dark'], ['nebula', 'dark'], ['ember', 'dark'], ['midnight', 'dark'],
      ['ivory', 'light'], ['mist', 'light'], ['rose', 'light'],
    ])
    expect([...BUILTIN_SKIN_IDS]).toEqual(BUILTIN_SKINS.map(skin => skin.id))
    expect(builtinSkin('mist')).toBe(BUILTIN_SKINS[6])
    expect(builtinSkin('unknown')).toBeUndefined()
  })

  it.each(BUILTIN_SKINS.map(skin => [skin.id, skin] as const))('%s is complete and well formed', (_id, skin) => {
    expect(skin.source).toBe('builtin')
    expect(skin.name.zh).not.toBe('')
    expect(skin.name.en).not.toBe('')
    for (const token of CORE_TOKENS) expect(skin.tokens[token], token).toBeDefined()
    for (const [name, value] of Object.entries(skin.tokens)) {
      expect(SKINNABLE_TOKENS, name).toContain(name)
      expect(isSkinColor(value), `${name}: ${value}`).toBe(true)
    }
    expect(Object.keys(skin.tokens).length).toBeLessThanOrEqual(MAX_PACK_TOKENS)
    expect(skin.accent).toMatch(/^#[0-9a-f]{6}$/)
    expect(skin.tokens['--dsw-accent']).toBe(skin.accent)
    expect(skin.background?.layers.length).toBeGreaterThan(0)
  })

  it.each(BUILTIN_SKINS.map(skin => [skin.id, skin] as const))('%s keeps brand-primary as label ink', (_id, skin) => {
    expect(skin.tokens['--dsw-alias-brand-primary']).toBe(skin.tokens['--dsw-alias-label-primary'])
  })

  it.each(BUILTIN_SKINS.map(skin => [skin.id, skin] as const))('%s meets the contrast floor on its base surface', (_id, skin) => {
    const base = skin.tokens['--dsw-alias-bg-base']!
    expect(contrast(skin.tokens['--dsw-alias-label-primary']!, base)).toBeGreaterThanOrEqual(7)
    expect(contrast(skin.tokens['--dsw-alias-label-secondary']!, base)).toBeGreaterThanOrEqual(4.5)
  })

  it.each(BUILTIN_SKINS.map(skin => [skin.id, skin] as const))('%s survives the pack validator when serialized under another id', (id, skin) => {
    const text = serializeSkinPack({ ...skin, id: `${id}-copy`, source: 'pack' })
    const parsed = parseSkinPack(text)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.skin).toEqual({ ...skin, id: `${id}-copy`, source: 'pack' })
    expect(parseSkinPack(serializeSkinPack(skin)).ok).toBe(false)
  })

  it('computes contrast the WCAG way', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
  })
})

describe('skinnable-token allowlist', () => {
  it('lists each token once, all as --dsw custom properties', () => {
    expect(new Set(SKINNABLE_TOKENS).size).toBe(SKINNABLE_TOKENS.length)
    for (const token of SKINNABLE_TOKENS) expect(token).toMatch(/^--dsw-[a-z0-9-]+$/)
    for (const token of CORE_TOKENS) expect(SKINNABLE_TOKENS).toContain(token)
  })

  it('names only tokens the shipped theme stylesheets declare', () => {
    const declared = new Set<string>()
    const sheets = readdirSync(STYLES).filter(file => file.endsWith('.css'))
    expect(sheets).toEqual(expect.arrayContaining(['design-platform.css', 'skin-seams.css']))
    for (const sheet of sheets) {
      for (const match of readFileSync(join(STYLES, sheet), 'utf8').matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)) declared.add(match[1]!)
    }
    expect(SKINNABLE_TOKENS.filter(token => !declared.has(token))).toEqual([])
    for (const accent of ['--dsw-accent', '--dsw-accent-hover', '--dsw-accent-soft']) {
      expect(readFileSync(join(STYLES, 'design-platform.css'), 'utf8')).toContain(`${accent}:`)
    }
  })
})
