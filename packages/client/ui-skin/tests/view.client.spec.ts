import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/client/settings.ts'
import {
  activeSkinOf, canWrite, DEFAULT_LIMITS, INITIAL_VIEW, isForcedOpaque, NO_BACKDROP, resolveBackdrop,
  type BackdropInput,
} from '../src/client/view.ts'
import { GRADIENT, HASH_A, libraryView, skin, wallpaper } from './fixtures.client.ts'

const open = { reducedTransparency: false, highContrast: false }

function input(patch: Partial<BackdropInput> = {}): BackdropInput {
  return { settings: DEFAULT_SETTINGS, library: libraryView(), activeId: 'light', environment: open, ...patch }
}

describe('view helpers', () => {
  it('starts empty, loading, and opaque', () => {
    expect(INITIAL_VIEW.library).toMatchObject({ status: 'loading', skins: [], wallpapers: [], rejected: [] })
    expect(INITIAL_VIEW.library.limits).toEqual(DEFAULT_LIMITS)
    expect(DEFAULT_LIMITS).toEqual({ maxPackBytes: 262144, maxWallpaperBytes: 8388608, maxWallpapers: 24 })
    expect(INITIAL_VIEW.backdrop).toBe(NO_BACKDROP)
    expect(canWrite(INITIAL_VIEW.access)).toBe(false)
  })

  it('writes only when the scope is ready, writable, and not refused', () => {
    expect(canWrite({ status: 'ready', writable: true, denied: false })).toBe(true)
    expect(canWrite({ status: 'ready', writable: false, denied: false })).toBe(false)
    expect(canWrite({ status: 'ready', writable: true, denied: true })).toBe(false)
    expect(canWrite({ status: 'unavailable', writable: true, denied: false })).toBe(false)
    expect(canWrite({ status: 'loading', writable: true, denied: false })).toBe(false)
  })

  it('forces opaque on reduced transparency or high contrast', () => {
    expect(isForcedOpaque(open)).toBe(false)
    expect(isForcedOpaque({ reducedTransparency: true, highContrast: false })).toBe(true)
    expect(isForcedOpaque({ reducedTransparency: false, highContrast: true })).toBe(true)
  })

  it('finds the catalog skin behind the active theme id', () => {
    const library = libraryView()
    expect(activeSkinOf(library, 'skin:abyss')?.id).toBe('abyss')
    expect(activeSkinOf(library, 'dark')).toBeUndefined()
    expect(activeSkinOf(library, 'skin:missing')).toBeUndefined()
  })

  it('prefers a stored wallpaper over the skin gradient', () => {
    const settings = { ...DEFAULT_SETTINGS, wallpaper: HASH_A, wallpaperBlur: 6 }
    expect(resolveBackdrop(input({ settings, activeId: 'skin:abyss' }))).toEqual({ kind: 'wallpaper', hash: HASH_A, blur: 6 })
  })

  it('ignores a wallpaper the catalog no longer holds', () => {
    const settings = { ...DEFAULT_SETTINGS, wallpaper: 'c'.repeat(64) }
    expect(resolveBackdrop(input({ settings }))).toBe(NO_BACKDROP)
    expect(resolveBackdrop(input({ settings, activeId: 'skin:abyss' }))).toMatchObject({ kind: 'gradient' })
  })

  it('falls back to the active skin gradient and otherwise to nothing', () => {
    expect(resolveBackdrop(input({ activeId: 'skin:abyss' }))).toEqual({ kind: 'gradient', background: GRADIENT })
    expect(resolveBackdrop(input({ activeId: 'skin:ivory' }))).toBe(NO_BACKDROP)
    expect(resolveBackdrop(input({ activeId: 'dark' }))).toBe(NO_BACKDROP)
  })

  it('treats a gradient with no usable layer as no backdrop', () => {
    const broken = skin('broken', { background: { kind: 'gradient', layers: [{ type: 'linear', angle: 1, stops: [['url(x)', 0], ['#000', 1]] }] } })
    expect(resolveBackdrop(input({ library: libraryView({ skins: [broken] }), activeId: 'skin:broken' }))).toBe(NO_BACKDROP)
  })

  it('shows no backdrop at all when the environment forces opaque surfaces', () => {
    const settings = { ...DEFAULT_SETTINGS, wallpaper: HASH_A }
    const library = libraryView({ wallpapers: [wallpaper(HASH_A)] })
    expect(resolveBackdrop(input({ settings, library, activeId: 'skin:abyss', environment: { ...open, reducedTransparency: true } }))).toBe(NO_BACKDROP)
    expect(resolveBackdrop(input({ settings, library, activeId: 'skin:abyss', environment: { ...open, highContrast: true } }))).toBe(NO_BACKDROP)
  })
})
