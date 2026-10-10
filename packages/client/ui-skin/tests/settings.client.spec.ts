import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS, isHexColor, isWallpaperHash, MATERIALS, normalizeSettings, RANGES,
} from '../src/client/settings.ts'

const HASH = 'a'.repeat(64)

describe('skin settings', () => {
  it('answers the Host defaults when the section is absent', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS).toEqual({
      accent: '', wallpaper: '', wallpaperBlur: 0, panelOpacity: 0.82, composerOpacity: 0.9,
      popoverOpacity: 0.96, material: 'off',
    })
  })

  it('keeps every valid field verbatim', () => {
    const section = {
      accent: '#12ab9f', wallpaper: HASH, wallpaperBlur: 12, panelOpacity: 0.7, composerOpacity: 0.55,
      popoverOpacity: 0.8, material: 'liquid',
    }
    expect(normalizeSettings(section)).toEqual(section)
  })

  it('falls back per field instead of discarding the section', () => {
    expect(normalizeSettings({
      accent: 'red', wallpaper: 'nothex', wallpaperBlur: 'wide', panelOpacity: Number.NaN, composerOpacity: null,
      popoverOpacity: Infinity, material: 'chrome',
    })).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({ accent: '#ABCDEF', wallpaper: HASH.toUpperCase() }))
      .toMatchObject({ accent: '', wallpaper: '' })
  })

  it('clamps numbers into the Host ranges and rounds the blur to whole pixels', () => {
    expect(normalizeSettings({ wallpaperBlur: 99, panelOpacity: 0.1, composerOpacity: 7, popoverOpacity: 0.2 }))
      .toMatchObject({
        wallpaperBlur: RANGES.wallpaperBlur.max, panelOpacity: RANGES.panelOpacity.min,
        composerOpacity: RANGES.composerOpacity.max, popoverOpacity: RANGES.popoverOpacity.min,
      })
    expect(normalizeSettings({ wallpaperBlur: -3 }).wallpaperBlur).toBe(0)
    expect(normalizeSettings({ wallpaperBlur: 7.6 }).wallpaperBlur).toBe(8)
  })

  it('recognises each material and only those', () => {
    for (const material of MATERIALS) expect(normalizeSettings({ material }).material).toBe(material)
    expect(MATERIALS).toEqual(['off', 'frosted', 'liquid'])
  })

  it('narrows accent and wallpaper text exactly', () => {
    expect(isHexColor('#00ff7f')).toBe(true)
    expect(isHexColor('#00ff7')).toBe(false)
    expect(isHexColor('#00FF7F')).toBe(false)
    expect(isHexColor(12)).toBe(false)
    expect(isWallpaperHash(HASH)).toBe(true)
    expect(isWallpaperHash(HASH.slice(1))).toBe(false)
    expect(isWallpaperHash(undefined)).toBe(false)
  })
})
