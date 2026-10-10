// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ACCENT_PRESETS, AccentRow, type AccentRowProps } from '../src/client/AccentRow.tsx'
import { DEFAULT_SETTINGS } from '../src/client/settings.ts'
import { zh } from '../src/client/locales.ts'
import { libraryView, skin } from './fixtures.client.ts'
import { skinSource, t } from './component-bench.client.ts'

afterEach(cleanup)

function mount(patch: Parameters<typeof skinSource>[0] = {}) {
  const source = skinSource(patch)
  const setSetting = vi.fn()
  render(<AccentRow {...{ t, useSkin: source.useSkin, setSetting } as unknown as AccentRowProps} />)
  return { ...source, setSetting }
}

const swatches = () => within(screen.getByRole('group', { name: zh['accent.presets'] })).getAllByRole('button')
const picker = () => screen.getByLabelText<HTMLInputElement>(zh['accent.custom'])

describe('AccentRow', () => {
  it('offers twelve presets that write the accent', () => {
    const m = mount()
    expect(ACCENT_PRESETS).toHaveLength(12)
    expect(swatches()).toHaveLength(12)
    expect(swatches()[1]?.getAttribute('aria-label')).toBe('强调色 #0ea5e9')
    fireEvent.click(swatches()[1]!)
    expect(m.setSetting).toHaveBeenCalledWith('accent', '#0ea5e9')
  })

  it('presses the swatch that matches the saved accent', () => {
    mount({ settings: { ...DEFAULT_SETTINGS, accent: '#14b8a6' } })
    expect(swatches().map(swatch => swatch.getAttribute('aria-pressed'))).toEqual(
      ACCENT_PRESETS.map(color => String(color === '#14b8a6')),
    )
    expect(picker().value).toBe('#14b8a6')
  })

  it('starts the picker on the product blue while no accent is saved', () => {
    mount()
    expect(picker().value).toBe('#4176e6')
  })

  it('starts the picker on the active skin’s own accent while no accent is saved', () => {
    const library = libraryView({ skins: [skin('abyss', { accent: '#8b7bd8' })] })
    mount({ library, theme: { preference: 'skin:abyss', activeId: 'skin:abyss' } })
    expect(picker().value).toBe('#8b7bd8')
  })

  it('falls back to the product blue for a skin that suggests no accent', () => {
    const library = libraryView({ skins: [skin('plain', { accent: undefined })] })
    mount({ library, theme: { preference: 'skin:plain', activeId: 'skin:plain' } })
    expect(picker().value).toBe('#4176e6')
  })

  it('writes the colour the picker reports', () => {
    const m = mount()
    fireEvent.change(picker(), { target: { value: '#123456' } })
    expect(m.setSetting).toHaveBeenCalledWith('accent', '#123456')
  })

  it('resets to the skin’s own accent', () => {
    const m = mount({ settings: { ...DEFAULT_SETTINGS, accent: '#14b8a6' } })
    fireEvent.click(screen.getByRole('button', { name: zh['accent.reset'] }))
    expect(m.setSetting).toHaveBeenCalledWith('accent', '')
  })

  it('has nothing to reset while no accent is saved', () => {
    mount()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['accent.reset'] }).disabled).toBe(true)
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('shows the state read-only, with every control disabled and a hint', () => {
    const m = mount({
      access: { status: 'ready', writable: false, denied: false },
      settings: { ...DEFAULT_SETTINGS, accent: '#14b8a6' },
    })
    expect(screen.getByRole('note').textContent).toBe(zh['access.readOnly'])
    expect(swatches().every(swatch => (swatch as HTMLButtonElement).disabled)).toBe(true)
    expect(swatches().find(swatch => swatch.getAttribute('aria-pressed') === 'true')).toBeDefined()
    expect(picker().disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['accent.reset'] }).disabled).toBe(true)
    fireEvent.click(swatches()[0]!)
    expect(m.setSetting).not.toHaveBeenCalled()
  })
})
