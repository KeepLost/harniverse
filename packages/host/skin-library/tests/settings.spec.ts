/** The `ui-skin` settings section: defaults and field constraints. */

import { describe, expect, it } from 'vitest'
import { SKIN_MATERIALS, UI_SKIN_NAMESPACE, UI_THEME_NAMESPACE, UiSkinSettingsSchema, type UiSkinSettings } from '../src/settings.ts'

const DEFAULTS = {
  accent: '',
  wallpaper: '',
  wallpaperBlur: 0,
  panelOpacity: 0.82,
  composerOpacity: 0.9,
  popoverOpacity: 0.96,
  material: 'off',
}

function accepts(patch: Record<string, unknown>): boolean {
  try {
    UiSkinSettingsSchema({ ...DEFAULTS, ...patch } as UiSkinSettings)
    return true
  } catch {
    // The schema throws on a violated constraint; that is the "rejects" answer.
    return false
  }
}

describe('ui-skin settings', () => {
  it('names the namespaces', () => {
    expect(UI_SKIN_NAMESPACE).toBe('ui-skin')
    expect(UI_THEME_NAMESPACE).toBe('ui-theme')
    expect(SKIN_MATERIALS).toEqual(['off', 'frosted', 'liquid'])
  })

  it('resolves an empty section to the contract defaults', () => {
    // A stored section is untyped input; the schema fills what it omits.
    expect(UiSkinSettingsSchema({} as UiSkinSettings)).toEqual(DEFAULTS)
  })

  it('accepts the documented value space', () => {
    expect(accepts({ accent: '#5e6ad2' })).toBe(true)
    expect(accepts({ accent: '#5E6AD2' })).toBe(true)
    expect(accepts({ wallpaper: 'a'.repeat(64) })).toBe(true)
    expect(accepts({ wallpaper: '0123456789abcdef'.repeat(4) })).toBe(true)
    for (const wallpaperBlur of [0, 1, 20, 40]) expect(accepts({ wallpaperBlur }), String(wallpaperBlur)).toBe(true)
    for (const panelOpacity of [0.4, 0.41, 0.82, 1]) expect(accepts({ panelOpacity }), String(panelOpacity)).toBe(true)
    for (const composerOpacity of [0.4, 0.9, 1]) expect(accepts({ composerOpacity }), String(composerOpacity)).toBe(true)
    for (const popoverOpacity of [0.6, 0.96, 1]) expect(accepts({ popoverOpacity }), String(popoverOpacity)).toBe(true)
    for (const material of SKIN_MATERIALS) expect(accepts({ material }), material).toBe(true)
  })

  it('rejects values outside it', () => {
    for (const accent of ['#fff', '#gggggg', 'red', '5e6ad2', '#5e6ad2ff', ' #5e6ad2', 'rgb(1, 2, 3)', 3]) {
      expect(accepts({ accent }), String(accent)).toBe(false)
    }
    for (const wallpaper of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), `${'a'.repeat(63)}g`, '../x', 5]) {
      expect(accepts({ wallpaper }), String(wallpaper)).toBe(false)
    }
    for (const wallpaperBlur of [-1, 41, 0.5, '8']) expect(accepts({ wallpaperBlur }), String(wallpaperBlur)).toBe(false)
    for (const panelOpacity of [0.39, 1.01, 0.825, '0.8']) expect(accepts({ panelOpacity }), String(panelOpacity)).toBe(false)
    for (const composerOpacity of [0.39, 1.01, 0.905]) expect(accepts({ composerOpacity }), String(composerOpacity)).toBe(false)
    for (const popoverOpacity of [0.5, 0.59, 1.01, 0.965]) expect(accepts({ popoverOpacity }), String(popoverOpacity)).toBe(false)
    for (const material of ['glass', 'Off', '', 1]) expect(accepts({ material }), String(material)).toBe(false)
  })
})
