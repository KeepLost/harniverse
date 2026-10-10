// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { SkinGallery, type SkinGalleryProps } from '../src/client/SkinGallery.tsx'
import { en, zh } from '../src/client/locales.ts'
import { en as themeEn, zh as themeZh } from '@deepseek-ai/dsh-client-ui-theme/src/client/locales.ts'
import { t, skinSource } from './component-bench.client.ts'
import { libraryView, skin } from './fixtures.client.ts'

afterEach(cleanup)

function mount(patch: Parameters<typeof skinSource>[0] = {}) {
  const source = skinSource(patch)
  const setTheme = vi.fn()
  const refresh = vi.fn(async () => {})
  const props = { t, useSkin: source.useSkin, setTheme, refresh } as unknown as SkinGalleryProps
  render(<SkinGallery {...props} />)
  return { ...source, setTheme, refresh }
}

const cards = () => within(screen.getByRole('radiogroup', { name: zh['gallery.label'] })).getAllByRole('radio')

const withPack = () => libraryView({ skins: [...libraryView().skins, skin('mine', { source: 'pack', colorScheme: 'light' })] })

describe('SkinGallery', () => {
  it('lists only catalog skins, built-ins first and imported packs after, without any color-mode card', () => {
    mount({ library: withPack() })
    expect(cards().map(card => card.textContent)).toEqual([
      `abyss中文${zh['gallery.scheme.dark']}`,
      `ivory中文${zh['gallery.scheme.light']}`,
      `mine中文${zh['gallery.scheme.light']} · ${zh['gallery.imported']}`,
    ])
  })

  it('checks the card of the persisted skin preference and makes it the tab stop', () => {
    mount({ theme: { preference: 'skin:ivory', activeId: 'skin:ivory' } })
    expect(cards().map(card => card.getAttribute('aria-checked'))).toEqual(['false', 'true'])
    expect(cards().map(card => card.tabIndex)).toEqual([-1, 0])
  })

  it.each([
    ['system', 'light'],
    ['light', 'light'],
    ['dark', 'dark'],
    ['skin:ghost', 'light'],
  ])('checks no card while the preference is %s, and makes the first card the tab stop', (preference, activeId) => {
    mount({ theme: { preference, activeId } })
    expect(cards().map(card => card.getAttribute('aria-checked'))).toEqual(['false', 'false'])
    expect(cards().map(card => card.tabIndex)).toEqual([0, -1])
  })

  it('re-reads the catalog once when the row opens', () => {
    const m = mount()
    expect(m.refresh).toHaveBeenCalledOnce()
    act(() => { m.update({ locale: 'en' }) })
    expect(m.refresh).toHaveBeenCalledOnce()
  })

  it('selects the skin theme of a clicked card', () => {
    const m = mount()
    fireEvent.click(cards()[0]!)
    expect(m.setTheme).toHaveBeenCalledWith('skin:abyss')
    fireEvent.click(cards()[1]!)
    expect(m.setTheme).toHaveBeenLastCalledWith('skin:ivory')
  })

  it('moves focus and selection with the arrow keys, wrapping at both ends', () => {
    const m = mount({ library: withPack() })
    const all = cards()
    const press = (index: number, key: string) => { fireEvent.keyDown(all[index]!, { key }) }

    press(2, 'ArrowRight')
    expect(document.activeElement).toBe(all[0])
    expect(m.setTheme).toHaveBeenLastCalledWith('skin:abyss')
    press(0, 'ArrowLeft')
    expect(document.activeElement).toBe(all[2])
    expect(m.setTheme).toHaveBeenLastCalledWith('skin:mine')
    press(0, 'ArrowDown')
    expect(document.activeElement).toBe(all[1])
    expect(m.setTheme).toHaveBeenLastCalledWith('skin:ivory')
    press(2, 'ArrowUp')
    expect(document.activeElement).toBe(all[1])
    expect(m.setTheme).toHaveBeenLastCalledWith('skin:ivory')
    press(1, 'Home')
    expect(m.setTheme).toHaveBeenLastCalledWith('skin:abyss')
    press(1, 'End')
    expect(m.setTheme).toHaveBeenLastCalledWith('skin:mine')
    press(2, 'ArrowDown')
    expect(m.setTheme).toHaveBeenLastCalledWith('skin:abyss')
    press(0, 'ArrowUp')
    expect(m.setTheme).toHaveBeenLastCalledWith('skin:mine')
  })

  it('ignores keys that are not navigation', () => {
    const m = mount()
    fireEvent.keyDown(cards()[1]!, { key: 'Tab' })
    fireEvent.keyDown(cards()[1]!, { key: 'a' })
    expect(m.setTheme).not.toHaveBeenCalled()
  })

  it('names skins in the active language and marks imported packs', () => {
    mount({
      locale: 'en',
      library: libraryView({ skins: [skin('mine', { source: 'pack' })] }),
    })
    expect(cards().at(-1)?.textContent).toBe(`mine en${zh['gallery.scheme.dark']} · ${zh['gallery.imported']}`)
  })

  it('paints each skin card from the skin’s own tokens', () => {
    mount()
    const preview = cards()[0]!.querySelector('span[aria-hidden="true"]') as HTMLElement
    expect(preview.style.getPropertyValue('--dsh-skin-pv-bg')).toBe('#101014')
    expect(preview.style.getPropertyValue('--dsh-skin-pv-accent')).toBe('#5e6ad2')
    expect(preview.style.getPropertyValue('--dsh-skin-pv-image')).toContain('radial-gradient')
    const plain = cards()[1]!.querySelector('span[aria-hidden="true"]') as HTMLElement
    expect(plain.style.getPropertyValue('--dsh-skin-pv-image')).toBe('')
  })

  it('tells the user a skin replaces the color mode, in both languages', () => {
    mount()
    expect(screen.getByText(zh['gallery.desc'])).toBeTruthy()
    expect(zh['gallery.desc']).toContain(themeZh['appearance.title'])
    expect(en['gallery.desc']).toContain(themeEn['appearance.title'])
  })

  it('says the choice is local only while settings cannot be saved', () => {
    const m = mount({ access: { status: 'ready', writable: false, denied: false } })
    expect(screen.getByRole('note').textContent).toBe(zh['gallery.localOnly'])
    // Choosing still works: the theme stays in memory for the open page.
    fireEvent.click(cards()[1]!)
    expect(m.setTheme).toHaveBeenCalledWith('skin:ivory')
  })

  it('shows no notice while settings can be saved', () => {
    mount()
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('shows no radio group while the catalog is empty, says so when it cannot be read, and follows later updates', () => {
    const m = mount({ library: libraryView({ status: 'error', skins: [] }) })
    expect(screen.getByRole('status').textContent).toBe(zh['gallery.unavailable'])
    expect(screen.queryByRole('radiogroup')).toBeNull()
    act(() => { m.update({ library: libraryView() }) })
    expect(screen.queryByRole('status')).toBeNull()
    expect(cards()).toHaveLength(2)
  })
})
