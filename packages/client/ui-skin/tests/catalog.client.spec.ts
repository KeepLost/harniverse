import { describe, expect, it, vi } from 'vitest'
import type { ThemeDefinition } from '@deepseek-ai/dsh-client-ui-theme/client'
import {
  SKIN_THEME_PREFIX, SkinThemeRegistry, skinDefinition, skinDisplayName, skinThemeId, skinTokens,
} from '../src/client/catalog.ts'
import { accentHover, accentSoft } from '../src/client/color.ts'
import { skin } from './fixtures.client.ts'

describe('skin themes', () => {
  it('derives ids and display names', () => {
    expect(SKIN_THEME_PREFIX).toBe('skin:')
    expect(skinThemeId('abyss')).toBe('skin:abyss')
    expect(skinDisplayName(skin('abyss'), 'en')).toBe('abyss en')
    expect(skinDisplayName(skin('abyss'), 'zh')).toBe('abyss中文')
  })

  it('keeps the skin tokens and completes the accent family from the skin accent', () => {
    const tokens = skinTokens(skin('a', { tokens: { '--dsw-accent': '#112233', '--dsw-alias-bg-base': '#000000' } }))
    expect(tokens).toEqual({
      '--dsw-accent': '#112233',
      '--dsw-alias-bg-base': '#000000',
      '--dsw-accent-hover': accentHover('#112233', 'dark'),
      '--dsw-accent-soft': accentSoft('#112233'),
    })
    const light = skinTokens(skin('a', { colorScheme: 'light', tokens: { '--dsw-accent': '#112233' } }))
    expect(light['--dsw-accent-hover']).toBe(accentHover('#112233', 'light'))
  })

  it('never overwrites an accent token the pack set itself', () => {
    const tokens = skinTokens(skin('a', {
      tokens: { '--dsw-accent': '#112233', '--dsw-accent-hover': '#aaaaaa', '--dsw-accent-soft': '#bbbbbb' },
    }))
    expect(tokens).toEqual({ '--dsw-accent': '#112233', '--dsw-accent-hover': '#aaaaaa', '--dsw-accent-soft': '#bbbbbb' })
  })

  it('falls back to the skin accent field when the tokens carry none', () => {
    expect(skinTokens(skin('a', { accent: '#445566', tokens: {} }))).toEqual({
      '--dsw-accent': '#445566',
      '--dsw-accent-hover': accentHover('#445566', 'dark'),
      '--dsw-accent-soft': accentSoft('#445566'),
    })
  })

  it('leaves the accent family alone when there is no hex accent to derive from', () => {
    expect(skinTokens(skin('a', { accent: undefined, tokens: { '--dsw-alias-bg-base': '#000000' } })))
      .toEqual({ '--dsw-alias-bg-base': '#000000' })
    expect(skinTokens(skin('a', { tokens: { '--dsw-accent': 'rgb(1, 2, 3)' } }))).toEqual({ '--dsw-accent': 'rgb(1, 2, 3)' })
  })

  it('leaves out any token that is not a design-system name with a grammar colour', () => {
    const tokens = skinTokens(skin('a', {
      tokens: {
        '--dsw-alias-bg-base': '#000000',
        '--dsw-alias-bg-layer-1': 'url(https://example.test/pixel.png)',
        '--dsw-alias-label-primary': 'var(--dsw-alias-bg-base)',
        'background-image': '#ffffff',
        '--evil': '#ffffff',
        '--dsw-UPPER': '#ffffff',
      },
      accent: undefined,
    }))
    expect(tokens).toEqual({ '--dsw-alias-bg-base': '#000000' })
  })

  it('builds the theme definition from the colour scheme', () => {
    const definition = skinDefinition(skin('abyss', { colorScheme: 'light' }))
    expect(definition).toMatchObject({ id: 'skin:abyss', colorScheme: 'light' })
    expect(definition.tokens['--dsw-alias-bg-base']).toBe('#101014')
  })
})

function registryBench() {
  const live = new Map<string, ThemeDefinition>()
  const disposers: Record<string, ReturnType<typeof vi.fn>> = {}
  const register = vi.fn((definition: ThemeDefinition) => {
    if (live.has(definition.id)) throw new Error(`theme "${definition.id}" is already registered`)
    live.set(definition.id, definition)
    const dispose = vi.fn(() => { live.delete(definition.id) })
    disposers[definition.id] = dispose
    return dispose
  })
  const report = vi.fn()
  return { registry: new SkinThemeRegistry(register, report), register, report, live, disposers }
}

describe('SkinThemeRegistry', () => {
  it('registers each skin once and ignores an unchanged catalog', () => {
    const b = registryBench()
    b.registry.sync([skin('a'), skin('b')])
    expect([...b.live.keys()]).toEqual(['skin:a', 'skin:b'])
    b.registry.sync([skin('a'), skin('b')])
    expect(b.register).toHaveBeenCalledTimes(2)
  })

  it('retires a skin that left the catalog and re-registers one whose definition moved', () => {
    const b = registryBench()
    b.registry.sync([skin('a'), skin('b')])
    b.registry.sync([skin('a', { tokens: { ...skin('a').tokens, '--dsw-alias-bg-base': '#000001' } })])
    expect(b.disposers['skin:b']).toHaveBeenCalledOnce()
    expect(b.live.has('skin:b')).toBe(false)
    expect(b.register).toHaveBeenCalledTimes(3)
    expect(b.live.get('skin:a')?.tokens['--dsw-alias-bg-base']).toBe('#000001')
  })

  it('reports a skin whose id another plugin already occupies and keeps going', () => {
    const b = registryBench()
    b.live.set('skin:a', { id: 'skin:a', colorScheme: 'dark', tokens: {} })
    b.registry.sync([skin('a'), skin('b')])
    expect(b.report).toHaveBeenCalledWith('skin theme "skin:a" was not registered', expect.any(Error))
    expect(b.live.has('skin:b')).toBe(true)
  })

  it('retires everything on dispose', () => {
    const b = registryBench()
    b.registry.sync([skin('a'), skin('b')])
    b.registry.dispose()
    expect(b.live.size).toBe(0)
    b.registry.dispose()
  })
})
