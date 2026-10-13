import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { accentHover } from '../src/client/color.ts'
import { computeOverrides, MATERIAL_FILTERS, OVERRIDE_SOURCE } from '../src/client/overrides.ts'
import { DEFAULT_SETTINGS, type SkinSettings } from '../src/client/settings.ts'

const settings = (patch: Partial<SkinSettings> = {}): SkinSettings => ({ ...DEFAULT_SETTINGS, ...patch })
const both = (value: string) => ({ light: value, dark: value })
const DIALOG_AT_75 = 'color-mix(in srgb, var(--dsw-opaque-dialog, var(--dsw-alias-bg-layer-2)) 75%, transparent)'

describe('override layer', () => {
  it('is empty without an accent and without a backdrop', () => {
    expect(computeOverrides({ settings: settings(), backdropActive: false, forcedOpaque: false })).toEqual({})
    expect(OVERRIDE_SOURCE).toBe('ui-skin')
  })

  it('overrides the accent family as a unit, with per-mode hover and a translucent soft tint', () => {
    const layer = computeOverrides({ settings: settings({ accent: '#4176e6' }), backdropActive: false, forcedOpaque: false })
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
    const layer = computeOverrides({ settings: settings({ material: 'liquid' }), backdropActive: false, forcedOpaque: false })
    expect(layer).toEqual({})
  })

  it('rebinds each surface over the alias it replaces at its own opacity', () => {
    const layer = computeOverrides({
      settings: settings({ panelOpacity: 0.82, composerOpacity: 0.9, popoverOpacity: 0.96, dialogOpacity: 0.75 }),
      backdropActive: true,
      forcedOpaque: false,
    })
    expect(layer).toEqual({
      '--dsw-surface-pane': both('color-mix(in srgb, var(--dsw-alias-bg-base) 82%, transparent)'),
      '--dsw-surface-sidebar': both('color-mix(in srgb, var(--dsw-specific-sidebar-fill) 82%, transparent)'),
      '--dsw-surface-composer': both('color-mix(in srgb, var(--dsw-specific-input-major) 90%, transparent)'),
      '--dsw-surface-popover': both('color-mix(in srgb, var(--dsw-specific-menu) 96%, transparent)'),
      '--dsw-surface-dialog': both(DIALOG_AT_75),
    })
  })

  it('mixes the dialog over the opaque companion of its alias, so 100% is opaque under any skin alpha', () => {
    const layer = computeOverrides({ settings: settings(), backdropActive: true, forcedOpaque: false })
    expect(settings().dialogOpacity).toBe(1)
    expect(layer['--dsw-surface-dialog']).toEqual(both(
      'color-mix(in srgb, var(--dsw-opaque-dialog, var(--dsw-alias-bg-layer-2)) 100%, transparent)',
    ))
  })

  it('leaves the dialog on its alias without a backdrop, whatever the opacity', () => {
    const layer = computeOverrides({ settings: settings({ dialogOpacity: 0.7 }), backdropActive: false, forcedOpaque: false })
    expect(layer).toEqual({})
  })

  it('binds the pane, sidebar, popover, and dialog to their opaque companions while the system forces opaque rendering', () => {
    const forced = computeOverrides({ settings: settings({ material: 'liquid' }), backdropActive: false, forcedOpaque: true })
    expect(forced).toEqual({
      '--dsw-surface-pane': both('var(--dsw-opaque-pane, var(--dsw-alias-bg-base))'),
      '--dsw-surface-sidebar': both('var(--dsw-opaque-sidebar, var(--dsw-specific-sidebar-fill))'),
      '--dsw-surface-popover': both('var(--dsw-opaque-popover, var(--dsw-specific-menu))'),
      '--dsw-surface-dialog': both('var(--dsw-opaque-dialog, var(--dsw-alias-bg-layer-2))'),
    })
    expect(forced['--dsw-surface-composer']).toBeUndefined()
  })

  it('lets a forced-opaque request win over an active backdrop and still carries the accent', () => {
    const layer = computeOverrides({
      settings: settings({ accent: '#112233', material: 'frosted', panelOpacity: 0.5, dialogOpacity: 0.6 }),
      backdropActive: true,
      forcedOpaque: true,
    })
    expect(layer['--dsw-accent']).toEqual(both('#112233'))
    expect(layer['--dsw-surface-pane']).toEqual(both('var(--dsw-opaque-pane, var(--dsw-alias-bg-base))'))
    expect(layer['--dsw-surface-dialog']).toEqual(both('var(--dsw-opaque-dialog, var(--dsw-alias-bg-layer-2))'))
    expect(Object.keys(layer).filter(name => name.startsWith('--dsw-material'))).toEqual([])
    expect(JSON.stringify(layer)).not.toContain('color-mix(in srgb, var(--dsw-opaque')
  })

  it('reads every companion with a fallback to its alias, so an engine without relative colour never loses the surface', () => {
    const layers = [
      computeOverrides({ settings: settings(), backdropActive: true, forcedOpaque: false }),
      computeOverrides({ settings: settings(), backdropActive: false, forcedOpaque: true }),
    ]
    for (const layer of layers) {
      const text = JSON.stringify(layer)
      const reads = text.match(/--dsw-opaque-[a-z]+/g) ?? []
      expect(reads.length).toBeGreaterThan(0)
      expect(text.match(/--dsw-opaque-[a-z]+, var\(--dsw-/g)).toHaveLength(reads.length)
    }
  })

  it('never reads the surface token it sets', () => {
    const layer = computeOverrides({ settings: settings({ material: 'frosted', accent: '#112233' }), backdropActive: true, forcedOpaque: false })
    for (const [name, modes] of Object.entries(layer)) {
      expect(modes.light, name).not.toContain(`var(${name})`)
      expect(modes.dark, name).not.toContain(`var(${name})`)
    }
  })

  it('prints fractional opacities without float noise', () => {
    const layer = computeOverrides({ settings: settings({ panelOpacity: 0.4 + 0.07 }), backdropActive: true, forcedOpaque: false })
    expect(layer['--dsw-surface-pane']?.light).toContain(' 47%,')
    const fine = computeOverrides({ settings: settings({ panelOpacity: 0.8234 }), backdropActive: true, forcedOpaque: false })
    expect(fine['--dsw-surface-pane']?.light).toContain(' 82.34%,')
  })

  it('sets the four material filters only for a glass material over a backdrop', () => {
    const off = computeOverrides({ settings: settings({ material: 'off' }), backdropActive: true, forcedOpaque: false })
    expect(Object.keys(off).filter(name => name.startsWith('--dsw-material'))).toEqual([])
    for (const material of ['frosted', 'liquid'] as const) {
      const layer = computeOverrides({ settings: settings({ material }), backdropActive: true, forcedOpaque: false })
      for (const name of [
        '--dsw-material-panel-filter', '--dsw-material-composer-filter', '--dsw-material-popover-filter', '--dsw-material-dialog-filter',
      ]) {
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
    const layer = computeOverrides({ settings: settings({ accent: '#112233', material: 'liquid' }), backdropActive: true, forcedOpaque: false })
    const forced = computeOverrides({ settings: settings(), backdropActive: false, forcedOpaque: true })
    const referenced = [layer, forced].flatMap(l => Object.values(l))
      .flatMap(modes => [...modes.light.matchAll(/var\((--[a-z0-9-]+)[,)]/g)].map(m => m[1]!))
    expect(Object.keys(layer).length).toBe(13)
    expect(referenced).toContain('--dsw-opaque-dialog')
    for (const name of [...Object.keys(layer), ...Object.keys(forced), ...referenced]) expect(declared.has(name), name).toBe(true)
  })
})
