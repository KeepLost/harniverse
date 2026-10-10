// @vitest-environment jsdom
// ThemePresenter behavior account: root color-scheme and the palette attribute
// follow active.colorScheme only, token variables replace the previous apply's
// set, theme-color metadata follows the rendered body background, and dispose
// retracts everything the presenter wrote.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { DARK_ATTRIBUTE, ThemePresenter } from '@deepseek-ai/dsh-client-ui-layout/src/client/theme-presenter.ts'

const LIGHT_THEME_COLOR = 'rgb(255, 255, 255)'
const DARK_THEME_COLOR = 'rgb(21, 21, 23)'

function snapshot(colorScheme: 'light' | 'dark', tokens: Record<string, string> = {}): ThemeSnapshot {
  // The presenter must key off colorScheme, not the id — keep them distinct.
  const active = { id: `${colorScheme}-test`, colorScheme, tokens }
  return { preference: colorScheme, fontSize: 16, active, themes: [active], revision: 1 }
}

function clearThemePresentation(): void {
  document.head.querySelectorAll('meta[name="theme-color"], style[data-theme-presenter-test]').forEach((node) => { node.remove() })
}

function themeColorMeta(): HTMLMetaElement | null {
  return document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
}

beforeEach(() => {
  clearThemePresentation()
  document.documentElement.style.removeProperty('color-scheme')
  document.body.removeAttribute(DARK_ATTRIBUTE)
  document.body.removeAttribute('style')
  const style = document.createElement('style')
  style.dataset.themePresenterTest = ''
  style.textContent = `
    body { background-color: ${LIGHT_THEME_COLOR}; }
    body[${DARK_ATTRIBUTE}] { background-color: ${DARK_THEME_COLOR}; }
  `
  document.head.append(style)
})

afterEach(clearThemePresentation)

describe('ThemePresenter', () => {
  it('light scheme sets root color-scheme and leaves the dark attribute absent', () => {
    const presenter = new ThemePresenter()
    presenter.apply(snapshot('light'))
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
    expect(themeColorMeta()?.content).toBe(LIGHT_THEME_COLOR)
  })

  it('dark scheme sets root color-scheme, the attribute, and metadata; switching to light updates one node', () => {
    const presenter = new ThemePresenter()
    presenter.apply(snapshot('dark'))
    const meta = themeColorMeta()
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(true)
    expect(meta?.content).toBe(DARK_THEME_COLOR)
    presenter.apply(snapshot('light'))
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
    expect(themeColorMeta()).toBe(meta)
    expect(meta?.content).toBe(LIGHT_THEME_COLOR)
    expect(document.head.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1)
  })

  it('applies tokens as inline variables and clears the previous set on theme change', () => {
    const presenter = new ThemePresenter()
    presenter.apply(snapshot('dark', { '--dsw-alias-bg': '#111', '--dsw-alias-fg': '#eee' }))
    expect(document.body.style.getPropertyValue('--dsw-alias-bg')).toBe('#111')
    expect(document.body.style.getPropertyValue('--dsw-alias-fg')).toBe('#eee')
    presenter.apply(snapshot('light', { '--dsw-alias-bg': '#fff' }))
    expect(document.body.style.getPropertyValue('--dsw-alias-bg')).toBe('#fff')
    // The old theme's extra variable is gone, not merged.
    expect(document.body.style.getPropertyValue('--dsw-alias-fg')).toBe('')
  })

  it('publishes the content font-size axis and follows font-size changes', () => {
    const presenter = new ThemePresenter()
    presenter.apply(snapshot('light'))
    expect(document.body.style.getPropertyValue('--dsw-content-font-size')).toBe('16px')
    presenter.apply({ ...snapshot('dark'), fontSize: 14 })
    expect(document.body.style.getPropertyValue('--dsw-content-font-size')).toBe('14px')
  })

  it('dispose removes color-scheme, the attribute, and every applied variable, sparing foreign inline styles', () => {
    document.body.style.setProperty('--foreign', 'kept')
    const presenter = new ThemePresenter()
    presenter.apply(snapshot('dark', { '--dsw-alias-bg': '#111' }))
    const meta = themeColorMeta()
    presenter.dispose()
    expect(document.documentElement.style.colorScheme).toBe('')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
    expect(document.body.style.getPropertyValue('--dsw-alias-bg')).toBe('')
    expect(document.body.style.getPropertyValue('--dsw-content-font-size')).toBe('')
    expect(document.body.style.getPropertyValue('--foreign')).toBe('kept')
    expect(meta?.isConnected).toBe(false)
  })
})

describe('ThemePresenter bootstrap handoff', () => {
  const BOOT = 'data-ds-boot-tokens'

  function bootPainted(): void {
    document.body.setAttribute(DARK_ATTRIBUTE, '')
    document.body.setAttribute(BOOT, '--dsw-alias-bg --dsw-alias-fg')
    document.body.style.setProperty('--dsw-alias-bg', '#101014')
    document.body.style.setProperty('--dsw-alias-fg', '#eee')
    document.documentElement.style.colorScheme = 'dark'
  }

  it('keeps the bootstrap paint while the snapshot is pending, then retracts what the next theme leaves unset', () => {
    bootPainted()
    const presenter = new ThemePresenter()
    presenter.apply({ ...snapshot('light'), pending: true })
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(true)
    expect(document.body.style.getPropertyValue('--dsw-alias-bg')).toBe('#101014')
    expect(document.body.hasAttribute(BOOT)).toBe(true)
    // Font size and theme-color metadata still follow the snapshot.
    expect(document.body.style.getPropertyValue('--dsw-content-font-size')).toBe('16px')
    expect(themeColorMeta()?.isConnected).toBe(true)
    // The theme registers: the first full apply adopts the handed-over names.
    presenter.apply(snapshot('dark', { '--dsw-alias-bg': '#0b0b10' }))
    expect(document.body.hasAttribute(BOOT)).toBe(false)
    expect(document.body.style.getPropertyValue('--dsw-alias-bg')).toBe('#0b0b10')
    expect(document.body.style.getPropertyValue('--dsw-alias-fg')).toBe('')
  })

  it('repaints a pending snapshot when no bootstrap paint stands', () => {
    const presenter = new ThemePresenter()
    presenter.apply({ ...snapshot('dark'), pending: true })
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(true)
  })

  it('adopts only custom-property names, once, and leaves variables it was not handed', () => {
    bootPainted()
    document.body.setAttribute(BOOT, '--dsw-alias-bg  color --dsw-alias-bg')
    const presenter = new ThemePresenter()
    presenter.apply(snapshot('dark'))
    expect(document.body.style.getPropertyValue('--dsw-alias-bg')).toBe('')
    expect(document.body.style.getPropertyValue('--dsw-alias-fg')).toBe('#eee')
    presenter.apply(snapshot('dark'))
    expect(document.body.hasAttribute(BOOT)).toBe(false)
    presenter.dispose()
    expect(document.body.style.getPropertyValue('--dsw-alias-fg')).toBe('#eee')
  })
})
