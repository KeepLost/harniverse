// @vitest-environment jsdom
/**
 * Composition specs: the real slot registry, renderer, locale seat, and theme
 * service around the plugin's `apply`, with only the `skinLibrary` Remote and
 * the `ui-skin` settings scope stubbed. Registrations leave with the plugin fiber.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime, stubSettingsScope, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import type { SkinSettings } from '../src/client/settings.ts'
import { WRITE_DELAY_MS } from '../src/client/writer.ts'
import { ok } from './controller-bench.client.ts'
import { HASH_A, snapshot } from './fixtures.client.ts'

usePinnedBrowserLanguages('zh')

const SETTINGS: SkinSettings = {
  accent: '', wallpaper: '', wallpaperBlur: 0, panelOpacity: 0.82, composerOpacity: 0.9, popoverOpacity: 0.96, material: 'off',
}

const created: string[] = []
const revoked: string[] = []

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: () => {
      const url = `blob:wallpaper-${String(created.length + 1)}`
      created.push(url)
      return url
    },
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: (url: string) => { revoked.push(url) } })
})

const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  cleanup()
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  created.length = 0
  revoked.length = 0
  vi.unstubAllGlobals()
  Reflect.deleteProperty(URL, 'createObjectURL')
  Reflect.deleteProperty(URL, 'revokeObjectURL')
})

async function bench(options: { list?: ReturnType<typeof ok<ReturnType<typeof snapshot>>> } = {}) {
  const runtime = await SlotTestRuntime.create()
  disposers.push(() => runtime.dispose())
  const remote = {
    list: vi.fn(async () => options.list ?? ok(snapshot())),
    readWallpaper: vi.fn(async () => ok({ mime: 'image/png' as const, contentBase64: 'AAAA' })),
    importPack: vi.fn(),
    removePack: vi.fn(async () => ok(true)),
    putWallpaper: vi.fn(),
    removeWallpaper: vi.fn(async () => ok(true)),
  }
  const skinScope = stubSettingsScope<SkinSettings>()
  skinScope.publish({ status: 'ready', value: SETTINGS, writable: true })
  runtime.provide('remote', {})
  runtime.provide('remote.skinLibrary', remote)
  runtime.provide('settingsScope', { bind: () => skinScope.scope } as never)
  const themeScope = stubSettingsScope<{ preference: string; fontSize: number }>()
  const theme = new ThemeRuntime(runtime.ctx, themeScope.scope)
  runtime.provide('theme', theme)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.provide('locale', locale)
  runtime.slots.installLocale(locale)
  const plugin = await runtime.mount({ apply, inject })
  await runtime.declare({
    'shell.backdrop': { kind: 'list', scope: 'root' },
    'settings.appearance.item': { kind: 'list', scope: 'root' },
  })
  await waitFor(() => { expect(remote.list).toHaveBeenCalled() })
  await act(async () => {})
  return { runtime, remote, skinScope, theme, locale, plugin }
}

describe('ui-skin apply', () => {
  it('declares the services it drives', () => {
    expect(inject).toEqual(['slots', 'locale', 'theme', 'remote', 'remote.skinLibrary', 'settingsScope'])
  })

  it('registers the backdrop and the five Appearance rows at their contract ids and orders', async () => {
    const b = await bench()
    expect(b.runtime.slots.entries('settings.appearance.item').map(entry => [entry.options.id, entry.options.order]))
      .toEqual([['skins', 30], ['accent', 40], ['wallpaper', 50], ['material', 60], ['packs', 70]])
    expect(b.runtime.slots.entries('shell.backdrop').map(entry => [entry.options.id, entry.options.order])).toEqual([['skin', 0]])
    expect(b.runtime.slots.entries('settings.appearance.item').every(entry => entry.locale === 'settings.skin')).toBe(true)
  })

  it('registers each catalog skin as a theme the gallery can select', async () => {
    const b = await bench()
    expect(b.theme.getTheme().themes.map(theme => theme.id)).toEqual(['light', 'dark', 'skin:abyss', 'skin:ivory'])
    const view = b.runtime.renderSlot('settings.appearance.item', {})
    const abyss = view.view.getByRole('radio', { name: /abyss中文/ })
    fireEvent.click(abyss)
    expect(b.theme.getTheme().preference).toBe('skin:abyss')
    expect(b.theme.getTheme().active.tokens['--dsw-alias-bg-base']).toBe('#101014')
    expect(b.theme.getTheme().active.colorScheme).toBe('dark')
    await waitFor(() => { expect(abyss.getAttribute('aria-checked')).toBe('true') })
  })

  it('overrides the accent family from the settings scope and retracts it on reset', async () => {
    const b = await bench()
    expect(b.theme.getTheme().active.tokens['--dsw-accent']).toBeUndefined()
    act(() => { b.skinScope.publish({ value: { ...SETTINGS, accent: '#123456' } }) })
    const tokens = b.theme.getTheme().active.tokens
    expect(tokens['--dsw-accent']).toBe('#123456')
    expect(tokens['--dsw-accent-soft']).toBe('color-mix(in srgb, #123456 18%, transparent)')
    act(() => { b.skinScope.publish({ value: SETTINGS }) })
    expect(b.theme.getTheme().active.tokens['--dsw-accent']).toBeUndefined()
  })

  it('writes an accent picked in the row to the scope once it rests', async () => {
    const b = await bench()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const view = b.runtime.renderSlot('settings.appearance.item', {})
      fireEvent.click(view.view.getByRole('button', { name: '强调色 #ec4899' }))
      expect(b.theme.getTheme().active.tokens['--dsw-accent']).toBe('#ec4899')
      await act(async () => { await vi.advanceTimersByTimeAsync(WRITE_DELAY_MS) })
      expect(b.skinScope.set).toHaveBeenCalledWith('accent', '#ec4899')
    } finally {
      vi.useRealTimers()
    }
  })

  it('paints the stored wallpaper behind the frame with translucent surfaces, and revokes its URL on unload', async () => {
    const b = await bench()
    act(() => { b.skinScope.publish({ value: { ...SETTINGS, wallpaper: HASH_A, wallpaperBlur: 8, material: 'frosted' } }) })
    const backdrop = b.runtime.renderSlot('shell.backdrop', {})
    await waitFor(() => { expect(backdrop.container.querySelector('[data-backdrop="wallpaper"]')).not.toBeNull() })
    await waitFor(() => {
      const layer = backdrop.container.querySelector('[data-backdrop="wallpaper"]') as HTMLElement
      expect(layer.style.getPropertyValue('--dsh-skin-image')).toBe('url("blob:wallpaper-1")')
    })
    const tokens = b.theme.getTheme().active.tokens
    expect(tokens['--dsw-surface-pane']).toBe('color-mix(in srgb, var(--dsw-alias-bg-base) 82%, transparent)')
    expect(tokens['--dsw-material-panel-filter']).toBe('blur(16px) saturate(1.4)')
    expect(b.remote.readWallpaper).toHaveBeenCalledWith(HASH_A)
    await b.plugin.dispose()
    expect(b.theme.getTheme().active.tokens['--dsw-surface-pane']).toBeUndefined()
    await waitFor(() => { expect(revoked).toEqual(['blob:wallpaper-1']) })
  })

  it('draws a skin gradient as the backdrop while that skin is selected', async () => {
    const b = await bench()
    const backdrop = b.runtime.renderSlot('shell.backdrop', {})
    expect(backdrop.container.querySelector('[data-backdrop]')).toBeNull()
    act(() => { b.theme.setTheme('skin:abyss') })
    await waitFor(() => { expect(backdrop.container.querySelector('[data-backdrop="gradient"]')).not.toBeNull() })
    expect(b.remote.readWallpaper).not.toHaveBeenCalled()
  })

  it('follows the operating system’s reduced-transparency request live', async () => {
    const listeners = new Map<string, Set<() => void>>()
    let reduced = false
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() { return query.includes('reduced-transparency') && reduced },
      addEventListener: (_type: string, listener: () => void) => {
        listeners.set(query, (listeners.get(query) ?? new Set()).add(listener))
      },
      removeEventListener: (_type: string, listener: () => void) => { listeners.get(query)?.delete(listener) },
    }))
    const b = await bench()
    act(() => { b.skinScope.publish({ value: { ...SETTINGS, wallpaper: HASH_A } }) })
    expect(b.theme.getTheme().active.tokens['--dsw-surface-pane']).toBeDefined()
    act(() => {
      reduced = true
      for (const listener of [...listeners.get('(prefers-reduced-transparency: reduce)') ?? []]) listener()
    })
    expect(b.theme.getTheme().active.tokens['--dsw-surface-pane']).toBeUndefined()
    await b.plugin.dispose()
    expect(listeners.get('(prefers-reduced-transparency: reduce)')?.size).toBe(0)
    expect(listeners.get('(prefers-contrast: more)')?.size).toBe(0)
  })

  it('names skins in the switched language', async () => {
    const b = await bench()
    const view = b.runtime.renderSlot('settings.appearance.item', {})
    expect(view.view.getByRole('radio', { name: /abyss中文/ })).toBeTruthy()
    await act(async () => { b.locale.setLocale('en') })
    expect(view.view.getByRole('radio', { name: /abyss en/ })).toBeTruthy()
    expect(view.view.getByText(en['gallery.title'])).toBeTruthy()
    await act(async () => { b.locale.setLocale('zh') })
    expect(view.view.getByText(zh['gallery.title'])).toBeTruthy()
  })

  it('re-reads the catalog when the Appearance section opens', async () => {
    const b = await bench()
    expect(b.remote.list).toHaveBeenCalledTimes(1)
    b.remote.list.mockResolvedValueOnce(ok(snapshot({ skins: [snapshot().skins[0]!] })))
    b.runtime.renderSlot('settings.appearance.item', {})
    await waitFor(() => { expect(b.theme.getTheme().themes.map(theme => theme.id)).toEqual(['light', 'dark', 'skin:abyss']) })
    expect(b.remote.list).toHaveBeenCalledTimes(2)
  })

  it('re-reads the catalog when the connection is re-established', async () => {
    const b = await bench()
    expect(b.remote.list).toHaveBeenCalledTimes(1)
    b.remote.list.mockResolvedValueOnce(ok(snapshot({ skins: [snapshot().skins[0]!] })))
    await act(async () => { b.runtime.ctx.emit('connection/reset') })
    await waitFor(() => { expect(b.theme.getTheme().themes.map(theme => theme.id)).toEqual(['light', 'dark', 'skin:abyss']) })
  })

  it('keeps the skin preference through a catalog read that drops the skin, and resumes it when the skin returns', async () => {
    const b = await bench()
    act(() => { b.theme.setTheme('skin:abyss') })
    b.remote.list.mockResolvedValueOnce(ok(snapshot({ skins: [snapshot().skins[1]!] })))
    b.runtime.renderSlot('settings.appearance.item', {})
    await waitFor(() => { expect(b.theme.getTheme().themes.map(theme => theme.id)).toEqual(['light', 'dark', 'skin:ivory']) })
    expect(b.theme.getTheme()).toMatchObject({ preference: 'skin:abyss', active: { id: 'light' } })
    await act(async () => { b.runtime.ctx.emit('connection/reset') })
    await waitFor(() => { expect(b.theme.getTheme().active.id).toBe('skin:abyss') })
    expect(b.theme.getTheme().preference).toBe('skin:abyss')
  })

  it('leaves nothing behind when the plugin unloads', async () => {
    const b = await bench()
    act(() => { b.skinScope.publish({ value: { ...SETTINGS, accent: '#123456' } }) })
    act(() => { b.theme.setTheme('skin:abyss') })
    await b.plugin.dispose()
    // The preference outlives the unloaded plugin; the system palette renders until a skin plugin registers it again.
    expect(b.theme.getTheme()).toMatchObject({ preference: 'skin:abyss', active: { id: 'light' } })
    expect(b.runtime.slots.entries('settings.appearance.item')).toEqual([])
    expect(b.runtime.slots.entries('shell.backdrop')).toEqual([])
    expect(b.theme.getTheme().themes.map(theme => theme.id)).toEqual(['light', 'dark'])
    expect(b.theme.getTheme().active.tokens['--dsw-accent']).toBeUndefined()
    expect(b.skinScope.listenerCount()).toBe(0)
    // Events after unload reach no stale listener.
    b.runtime.ctx.emit('connection/reset')
    expect(b.remote.list).toHaveBeenCalledTimes(1)
  })

  it('logs and stays empty when the catalog cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = await bench({ list: { ok: false, error: { code: 'internal', message: 'down' } } as never })
    expect(runtime.theme.getTheme().themes.map(theme => theme.id)).toEqual(['light', 'dark'])
    expect(warn).toHaveBeenCalledWith('[ui-skin] skin library could not be read:', { code: 'internal', message: 'down' })
    warn.mockRestore()
  })
})
