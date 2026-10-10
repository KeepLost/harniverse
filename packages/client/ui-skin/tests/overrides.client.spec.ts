import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { accentHover } from '../src/client/color.ts'
import { computeOverrides, MATERIAL_FILTERS, OVERRIDE_SOURCE } from '../src/client/overrides.ts'
import { DEFAULT_SETTINGS, type SkinSettings } from '../src/client/settings.ts'

const settings = (patch: Partial<SkinSettings> = {}): SkinSettings => ({ ...DEFAULT_SETTINGS, ...patch })

describe('override layer', () => {
  it('is empty without an accent and without a backdrop', () => {
    expect(computeOverrides({ settings: settings(), backdropActive: false })).toEqual({})
    expect(OVERRIDE_SOURCE).toBe('ui-skin')
  })

  it('overrides the accent family as a unit, with per-mode hover and a translucent soft tint', () => {
    const layer = computeOverrides({ settings: settings({ accent: '#4176e6' }), backdropActive: false })
    expect(Object.keys(layer)).toEqual(['--dsw-accent', '--dsw-accent-hover', '--dsw-accent-soft', '--dsw-accent-chip'])
    expect(layer['--dsw-accent']).toEqual({ light: '#4176e6', dark: '#4176e6' })
    expect(layer['--dsw-accent-hover']).toEqual({
      light: accentHover('#4176e6', 'light'), dark: accentHover('#4176e6', 'dark'),
    })
    expect(layer['--dsw-accent-soft']).toEqual({
      light: 'color-mix(in srgb, #4176e6 18%, transparent)', dark: 'color-mix(in srgb, #4176e6 18%, transparent)',
    })
    expect(layer['--dsw-accent-chip']).toEqual({
      light: 'color-mix(in srgb, #4176e6 22%, transparent)', dark: 'color-mix(in srgb, #4176e6 22%, transparent)',
    })
  })

  it('leaves surfaces opaque (no override) while no backdrop paints', () => {
    const layer = computeOverrides({ settings: settings({ material: 'liquid' }), backdropActive: false })
    expect(layer).toEqual({})
  })

  it('rebinds each surface over the alias it replaces at its own opacity', () => {
    const layer = computeOverrides({
      settings: settings({ panelOpacity: 0.82, composerOpacity: 0.9, popoverOpacity: 0.96 }),
      backdropActive: true,
    })
    const both = (value: string) => ({ light: value, dark: value })
    expect(layer).toEqual({
      '--dsw-surface-pane': both('color-mix(in srgb, var(--dsw-alias-bg-base) 82%, transparent)'),
      '--dsw-surface-sidebar': both('color-mix(in srgb, var(--dsw-specific-sidebar-fill) 82%, transparent)'),
      '--dsw-surface-composer': both('color-mix(in srgb, var(--dsw-specific-input-major) 90%, transparent)'),
      '--dsw-surface-popover': both('color-mix(in srgb, var(--dsw-specific-menu) 96%, transparent)'),
    })
  })

  it('never reads the surface token it sets', () => {
    const layer = computeOverrides({ settings: settings({ material: 'frosted', accent: '#112233' }), backdropActive: true })
    for (const [name, modes] of Object.entries(layer)) {
      expect(modes.light, name).not.toContain(`var(${name})`)
      expect(modes.dark, name).not.toContain(`var(${name})`)
    }
  })

  it('prints fractional opacities without float noise', () => {
    const layer = computeOverrides({ settings: settings({ panelOpacity: 0.4 + 0.07 }), backdropActive: true })
    expect(layer['--dsw-surface-pane']?.light).toContain(' 47%,')
    const fine = computeOverrides({ settings: settings({ panelOpacity: 0.8234 }), backdropActive: true })
    expect(fine['--dsw-surface-pane']?.light).toContain(' 82.34%,')
  })

  it('sets the three material filters only for a glass material over a backdrop', () => {
    const off = computeOverrides({ settings: settings({ material: 'off' }), backdropActive: true })
    expect(Object.keys(off).filter(name => name.startsWith('--dsw-material'))).toEqual([])
    for (const material of ['frosted', 'liquid'] as const) {
      const layer = computeOverrides({ settings: settings({ material }), backdropActive: true })
      for (const name of ['--dsw-material-panel-filter', '--dsw-material-composer-filter', '--dsw-material-popover-filter']) {
        expect(layer[name]).toEqual({ light: MATERIAL_FILTERS[material], dark: MATERIAL_FILTERS[material] })
      }
    }
    expect(MATERIAL_FILTERS).toEqual({
      frosted: 'blur(16px) saturate(1.4)',
      liquid: 'blur(28px) saturate(1.8) brightness(1.05)',
    })
  })

  it('only targets tokens the theme sheets declare', () => {
    const styles = join(import.meta.dirname, '../../ui-theme/src/styles')
    const declared = new Set<string>()
    for (const file of readdirSync(styles).filter(name => name.endsWith('.css'))) {
      for (const [, name] of readFileSync(join(styles, file), 'utf8').matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) declared.add(name!)
    }
    const layer = computeOverrides({ settings: settings({ accent: '#112233', material: 'liquid' }), backdropActive: true })
    const referenced = Object.values(layer).flatMap(modes => [...modes.light.matchAll(/var\((--[a-z0-9-]+)\)/g)].map(m => m[1]!))
    expect(Object.keys(layer).length).toBe(11)
    for (const name of [...Object.keys(layer), ...referenced]) expect(declared.has(name), name).toBe(true)
  })
})
