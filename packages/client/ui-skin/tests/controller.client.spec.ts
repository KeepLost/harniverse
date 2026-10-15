import { describe, expect, it, vi } from 'vitest'
import { accentHover } from '../src/client/color.ts'
import type { SkinSettings } from '../src/client/settings.ts'
import { WRITE_DELAY_MS } from '../src/client/writer.ts'
import { fail, makeBench, ok, ready } from './controller-bench.client.ts'
import { GRADIENT, HASH_A, HASH_B, skin, snapshot, wallpaper } from './fixtures.client.ts'

describe('SkinController mirroring', () => {
  it('publishes the first view, reads the catalog, and registers each skin as a theme', async () => {
    const b = makeBench()
    expect(b.controller.view.getSnapshot().library.status).toBe('loading')
    await b.controller.start()
    const view = b.controller.view.getSnapshot()
    expect(view.library.status).toBe('ready')
    expect(view.library.skins.map(s => s.id)).toEqual(['abyss', 'ivory'])
    expect([...b.theme.registered.keys()]).toEqual(['skin:abyss', 'skin:ivory'])
    expect(view.locale).toBe('zh')
    expect(view.theme).toEqual({ preference: 'system', activeId: 'light' })
    expect(b.theme.layer).toBeUndefined()
    expect(b.theme.overrideTokens).not.toHaveBeenCalled()
  })

  it('keeps the view and slice identities when nothing moved', async () => {
    const b = makeBench()
    await b.controller.start()
    const before = b.controller.view.getSnapshot()
    b.controller.sync()
    const after = b.controller.view.getSnapshot()
    expect(after).toBe(before)
    ready(b)
    const ready1 = b.controller.view.getSnapshot()
    expect(ready1.access).toEqual({ status: 'ready', writable: true, denied: false })
    expect(ready1.theme).toBe(before.theme)
    expect(ready1.library).toBe(before.library)
  })

  it('leaves the catalog empty and logs when the first read fails', async () => {
    const b = makeBench({ list: fail('host unreachable') })
    await b.controller.start()
    const view = b.controller.view.getSnapshot()
    expect(view.library).toMatchObject({ status: 'error', skins: [], wallpapers: [] })
    expect(b.theme.register).not.toHaveBeenCalled()
    expect(b.deps.warn).toHaveBeenCalledExactlyOnceWith('skin library could not be read', { code: 'internal', message: 'host unreachable' })
  })

  it('keeps the last good catalog when a later read fails', async () => {
    const b = makeBench()
    await b.controller.start()
    b.remote.list.mockResolvedValueOnce(fail('blip'))
    await b.controller.refresh()
    const view = b.controller.view.getSnapshot()
    expect(view.library.status).toBe('error')
    expect(view.library.skins).toHaveLength(2)
    expect(b.theme.registered.size).toBe(2)
  })

  it('re-registers only the skins whose definition changed and drops the ones that left', async () => {
    const b = makeBench()
    await b.controller.start()
    b.remote.list.mockResolvedValueOnce(ok(snapshot({
      skins: [skin('abyss', { tokens: { ...skin('abyss').tokens, '--dsw-alias-bg-base': '#000001' } })],
    })))
    await b.controller.refresh()
    expect([...b.theme.registered.keys()]).toEqual(['skin:abyss'])
    expect(b.theme.registered.get('skin:abyss')?.tokens['--dsw-alias-bg-base']).toBe('#000001')
  })

  it('lets a newer read supersede an older one still in flight', async () => {
    const b = makeBench()
    let release!: (value: ReturnType<typeof ok<ReturnType<typeof snapshot>>>) => void
    b.remote.list.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const stale = b.controller.refresh()
    await b.controller.refresh()
    release(ok(snapshot({ skins: [skin('stale')] })))
    await stale
    expect(b.controller.view.getSnapshot().library.skins.map(s => s.id)).toEqual(['abyss', 'ivory'])
  })

  it('reports a skin another plugin already occupies and keeps the rest', async () => {
    const b = makeBench()
    b.theme.registered.set('skin:abyss', { id: 'skin:abyss', colorScheme: 'dark', tokens: {} })
    await b.controller.start()
    expect(b.deps.warn).toHaveBeenCalledWith('skin theme "skin:abyss" was not registered', expect.any(Error))
    expect(b.theme.registered.has('skin:ivory')).toBe(true)
  })

  it('mirrors the settings scope, normalised, and its access state', async () => {
    const b = makeBench()
    await b.controller.start()
    ready(b, { accent: '#112233', wallpaperBlur: 7, material: 'frosted' })
    const view = b.controller.view.getSnapshot()
    expect(view.settings).toMatchObject({ accent: '#112233', wallpaperBlur: 7, material: 'frosted' })
    b.scope.publish({ status: 'unavailable', value: undefined, writable: false })
    expect(b.controller.view.getSnapshot().settings.accent).toBe('')
    expect(b.controller.view.getSnapshot().access).toEqual({ status: 'unavailable', writable: false, denied: false })
  })

  it('keeps the last shown wallpaper through the settings gap an authentication reset opens', async () => {
    const b = makeBench()
    await b.controller.start()
    ready(b, { wallpaper: HASH_A, wallpaperBlur: 7 })
    expect(b.controller.view.getSnapshot().backdrop).toEqual({ kind: 'wallpaper', hash: HASH_A, blur: 7 })
    // The scope re-derives with no section yet — exactly the shape a key exchange or re-authentication
    // leaves behind while `settings.describe` is fenced and rerun.
    b.scope.publish({ status: 'loading', value: undefined, writable: false })
    expect(b.controller.view.getSnapshot().backdrop).toEqual({ kind: 'wallpaper', hash: HASH_A, blur: 7 })
    expect(b.controller.view.getSnapshot().settings.wallpaper).toBe('')
  })

  it('returns to the authoritative section once the scope re-reads it', async () => {
    const b = makeBench()
    await b.controller.start()
    ready(b, { wallpaper: HASH_A, wallpaperBlur: 7 })
    b.scope.publish({ status: 'loading', value: undefined, writable: false })
    ready(b, { wallpaper: '' })
    expect(b.controller.view.getSnapshot().backdrop.kind).not.toBe('wallpaper')
    // A later gap retains nothing, because the standing section chose no wallpaper.
    b.scope.publish({ status: 'loading', value: undefined, writable: false })
    expect(b.controller.view.getSnapshot().backdrop.kind).not.toBe('wallpaper')
  })

  it('drops the retained wallpaper when the catalog loses it during the gap', async () => {
    const b = makeBench()
    await b.controller.start()
    ready(b, { wallpaper: HASH_A })
    b.scope.publish({ status: 'loading', value: undefined, writable: false })
    b.remote.list.mockResolvedValueOnce(ok(snapshot({ wallpapers: [wallpaper(HASH_B)] })))
    await b.controller.refresh()
    expect(b.controller.view.getSnapshot().backdrop.kind).not.toBe('wallpaper')
  })

  it('follows the theme selection and the product language', async () => {
    const b = makeBench()
    await b.controller.start()
    b.theme.setTheme('skin:abyss')
    expect(b.controller.view.getSnapshot().theme).toEqual({ preference: 'skin:abyss', activeId: 'skin:abyss' })
    b.locale.active = 'en'
    b.controller.sync()
    expect(b.controller.view.getSnapshot().locale).toBe('en')
  })

  it('keeps a skin preference while its theme is absent and resumes it when the skin is back', async () => {
    const b = makeBench()
    await b.controller.start()
    b.theme.setTheme('skin:abyss')
    expect(b.controller.view.getSnapshot().backdrop.kind).toBe('gradient')
    b.remote.list.mockResolvedValueOnce(ok(snapshot({ skins: [skin('ivory')] })))
    await b.controller.refresh()
    // The preference stays; the system palette renders (and no skin backdrop) until the skin registers again.
    expect(b.theme.preference).toBe('skin:abyss')
    expect(b.controller.view.getSnapshot().theme).toEqual({ preference: 'skin:abyss', activeId: 'light' })
    expect(b.controller.view.getSnapshot().backdrop.kind).toBe('none')
    await b.controller.refresh()
    expect(b.controller.view.getSnapshot().theme).toEqual({ preference: 'skin:abyss', activeId: 'skin:abyss' })
    expect(b.controller.view.getSnapshot().backdrop.kind).toBe('gradient')
  })

  it('keeps the preference when the selected skin is re-registered with a changed definition', async () => {
    const b = makeBench()
    await b.controller.start()
    b.theme.setTheme('skin:abyss')
    b.remote.list.mockResolvedValueOnce(ok(snapshot({
      skins: [skin('abyss', { background: GRADIENT, tokens: { ...skin('abyss').tokens, '--dsw-alias-bg-base': '#000001' } })],
    })))
    await b.controller.refresh()
    expect(b.theme.registered.get('skin:abyss')?.tokens['--dsw-alias-bg-base']).toBe('#000001')
    expect(b.controller.view.getSnapshot().theme).toEqual({ preference: 'skin:abyss', activeId: 'skin:abyss' })
  })

  it('warns instead of throwing when the theme to select is not registered', async () => {
    const b = makeBench()
    await b.controller.start()
    b.controller.setTheme('skin:ghost')
    expect(b.deps.warn).toHaveBeenCalledWith('theme "skin:ghost" could not be selected', expect.any(Error))
    expect(b.theme.preference).toBe('system')
  })
})

describe('SkinController override layer', () => {
  it('applies the accent family once, without echoing into a loop, and removes it on reset', async () => {
    const b = makeBench()
    await b.controller.start()
    ready(b, { accent: '#4176e6' })
    expect(b.theme.overrideTokens).toHaveBeenCalledOnce()
    expect(b.theme.overrideTokens.mock.calls[0]?.[0]).toBe('ui-skin')
    expect(b.theme.layer?.['--dsw-accent']).toEqual({ light: '#4176e6', dark: '#4176e6' })
    expect(b.theme.layer?.['--dsw-accent-hover']?.dark).toBe(accentHover('#4176e6', 'dark'))
    b.controller.sync()
    expect(b.theme.overrideTokens).toHaveBeenCalledOnce()
    ready(b, { accent: '#ff0000' })
    expect(b.theme.overrideTokens).toHaveBeenCalledTimes(2)
    ready(b, { accent: '' })
    expect(b.theme.layer).toBeUndefined()
    b.controller.sync()
    expect(b.theme.overrideTokens).toHaveBeenCalledTimes(2)
  })

  it('makes the surfaces translucent while a stored wallpaper or a skin gradient paints', async () => {
    const b = makeBench({ list: ok(snapshot()) })
    await b.controller.start()
    ready(b, { wallpaper: HASH_A, wallpaperBlur: 9, panelOpacity: 0.7, material: 'liquid' })
    expect(b.controller.view.getSnapshot().backdrop).toEqual({ kind: 'wallpaper', hash: HASH_A, blur: 9 })
    expect(b.theme.layer?.['--dsw-surface-pane']?.light).toBe('color-mix(in srgb, var(--dsw-alias-bg-base) 70%, transparent)')
    expect(b.theme.layer?.['--dsw-material-popover-filter']?.dark).toBe('blur(28px) saturate(1.8) brightness(1.05)')
    ready(b, { wallpaper: '' })
    expect(b.theme.layer).toBeUndefined()
    b.theme.setTheme('skin:abyss')
    expect(b.controller.view.getSnapshot().backdrop).toEqual({ kind: 'gradient', background: GRADIENT })
    expect(b.theme.layer).toBeDefined()
    b.theme.setTheme('skin:ivory')
    expect(b.controller.view.getSnapshot().backdrop.kind).toBe('none')
    expect(b.theme.layer).toBeUndefined()
  })

  it('binds the surfaces to their opaque forms and drops glass the moment the system asks for reduced transparency or high contrast', async () => {
    const b = makeBench()
    await b.controller.start()
    ready(b, { wallpaper: HASH_A, material: 'frosted', dialogOpacity: 0.7 })
    expect(b.theme.layer?.['--dsw-material-panel-filter']).toBeDefined()
    expect(b.theme.layer?.['--dsw-material-dialog-filter']).toBeDefined()
    expect(b.theme.layer?.['--dsw-surface-dialog']?.light).toContain('70%')
    for (const environment of [{ reducedTransparency: true }, { highContrast: true }]) {
      b.environment.set({ reducedTransparency: false, highContrast: false, ...environment })
      expect(b.controller.view.getSnapshot().backdrop.kind).toBe('none')
      expect(Object.keys(b.theme.layer ?? {}).sort()).toEqual([
        '--dsw-surface-dialog', '--dsw-surface-pane', '--dsw-surface-popover', '--dsw-surface-sidebar',
      ])
      expect(b.theme.layer?.['--dsw-surface-dialog']?.dark).toBe('var(--dsw-opaque-dialog, var(--dsw-alias-bg-layer-2))')
    }
    b.environment.set({ reducedTransparency: false, highContrast: false })
    expect(b.theme.layer?.['--dsw-surface-pane']?.light).toContain('color-mix(')
    expect(b.theme.layer?.['--dsw-material-dialog-filter']).toBeDefined()
  })

  it('leaves the surfaces on their aliases when nothing paints behind and nothing is forced', async () => {
    const b = makeBench()
    await b.controller.start()
    ready(b, { dialogOpacity: 0.7 })
    expect(b.theme.layer).toBeUndefined()
  })

  it('keeps surfaces opaque for a wallpaper the catalog does not hold', async () => {
    const b = makeBench({ list: ok(snapshot({ wallpapers: [wallpaper('c'.repeat(64))] })) })
    await b.controller.start()
    ready(b, { wallpaper: HASH_A })
    expect(b.controller.view.getSnapshot().backdrop.kind).toBe('none')
    expect(b.theme.layer).toBeUndefined()
  })
})

describe('SkinController staged edits', () => {
  it('shows an edit and its live preview at once and writes it once the input rests', async () => {
    vi.useFakeTimers()
    try {
      const b = makeBench()
      await b.controller.start()
      ready(b)
      b.controller.setSetting('accent', '#abcdef')
      expect(b.controller.view.getSnapshot().settings.accent).toBe('#abcdef')
      expect(b.theme.layer?.['--dsw-accent']?.light).toBe('#abcdef')
      expect(b.scope.set).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(WRITE_DELAY_MS)
      expect(b.scope.set).toHaveBeenCalledExactlyOnceWith('accent', '#abcdef')
      // Host acceptance replaces the overlay.
      b.scope.publish({ value: { accent: '#abcdef', wallpaper: '', wallpaperBlur: 0, panelOpacity: 0.82, composerOpacity: 0.9, bubbleOpacity: 0.85, popoverOpacity: 0.96, dialogOpacity: 1, material: 'off' } })
      expect(b.controller.view.getSnapshot().settings.accent).toBe('#abcdef')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stages the dialog opacity, previews it over a backdrop, and writes it once the input rests', async () => {
    vi.useFakeTimers()
    try {
      const b = makeBench({ list: ok(snapshot()) })
      await b.controller.start()
      ready(b, { wallpaper: HASH_A })
      expect(b.controller.view.getSnapshot().settings.dialogOpacity).toBe(1)
      b.controller.setSetting('dialogOpacity', 0.8)
      expect(b.controller.view.getSnapshot().settings.dialogOpacity).toBe(0.8)
      expect(b.theme.layer?.['--dsw-surface-dialog']?.light).toContain(' 80%, transparent)')
      expect(b.scope.set).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(WRITE_DELAY_MS)
      expect(b.scope.set).toHaveBeenCalledExactlyOnceWith('dialogOpacity', 0.8)
    } finally {
      vi.useRealTimers()
    }
  })

  it('loads a stored section that predates the dialog opacity as fully opaque', async () => {
    const b = makeBench({ list: ok(snapshot()) })
    await b.controller.start()
    b.scope.publish({
      status: 'ready',
      writable: true,
      // A document written before the dialog slider existed carries no such field.
      value: { accent: '', wallpaper: HASH_A, wallpaperBlur: 0, panelOpacity: 0.7, composerOpacity: 0.9, popoverOpacity: 0.96, material: 'off' } as Omit<SkinSettings, 'dialogOpacity'> as SkinSettings,
    })
    expect(b.controller.view.getSnapshot().settings.dialogOpacity).toBe(1)
    expect(b.theme.layer?.['--dsw-surface-dialog']?.light).toContain(' 100%, transparent)')
  })

  it('refuses edits while the scope cannot write', async () => {
    const b = makeBench()
    await b.controller.start()
    b.controller.setSetting('accent', '#abcdef')
    ready(b, {}, false)
    b.controller.setSetting('accent', '#abcdef')
    expect(b.controller.view.getSnapshot().settings.accent).toBe('')
    expect(b.scope.set).not.toHaveBeenCalled()
  })
})

describe('SkinController disposal', () => {
  it('releases every registration, listener, layer, and URL', async () => {
    const b = makeBench()
    await b.controller.start()
    ready(b, { accent: '#112233' })
    expect(b.theme.layer).toBeDefined()
    expect(b.scope.listenerCount()).toBe(1)
    expect(b.environment.listeners.size).toBe(1)
    b.remote.readWallpaper.mockResolvedValue(ok({ mime: 'image/png', contentBase64: 'AAAA' }))
    expect(await b.controller.acquireWallpaper('h')).toBe('blob:wp')
    b.controller.dispose()
    await vi.waitFor(() => { expect(b.deps.urls.revoke).toHaveBeenCalledExactlyOnceWith('blob:wp') })
    expect(b.theme.registered.size).toBe(0)
    expect(b.theme.layer).toBeUndefined()
    expect(b.scope.listenerCount()).toBe(0)
    expect(b.environment.listeners.size).toBe(0)
    const frozen = b.controller.view.getSnapshot()
    b.controller.sync()
    expect(b.controller.view.getSnapshot()).toBe(frozen)
    expect(await b.controller.acquireWallpaper('late')).toBeUndefined()
  })

  it('discards a catalog read that finishes after disposal', async () => {
    const b = makeBench()
    let release!: (value: ReturnType<typeof ok<ReturnType<typeof snapshot>>>) => void
    b.remote.list.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const pending = b.controller.start()
    b.controller.dispose()
    release(ok(snapshot()))
    await pending
    expect(b.theme.register).not.toHaveBeenCalled()
    expect(b.controller.view.getSnapshot().library.status).toBe('loading')
  })
})
