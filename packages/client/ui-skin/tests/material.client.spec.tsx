// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MaterialRow, type MaterialRowProps } from '../src/client/MaterialRow.tsx'
import { DEFAULT_SETTINGS } from '../src/client/settings.ts'
import { zh } from '../src/client/locales.ts'
import { HASH_A } from './fixtures.client.ts'
import { skinSource, t } from './component-bench.client.ts'

afterEach(cleanup)

const WALLPAPER = { kind: 'wallpaper', hash: HASH_A, blur: 0 } as const

function mount(patch: Parameters<typeof skinSource>[0] = {}) {
  const source = skinSource({ backdrop: WALLPAPER, ...patch })
  const setSetting = vi.fn()
  render(<MaterialRow {...{ t, useSkin: source.useSkin, setSetting } as unknown as MaterialRowProps} />)
  return { ...source, setSetting }
}

const segments = () => within(screen.getByRole('radiogroup', { name: zh['material.label'] })).getAllByRole<HTMLButtonElement>('radio')
const slider = (label: string) => screen.getByLabelText<HTMLInputElement>(label)

describe('MaterialRow', () => {
  it('offers off, frosted, and liquid glass with the saved one checked', () => {
    const m = mount({ settings: { ...DEFAULT_SETTINGS, material: 'frosted' } })
    expect(segments().map(segment => segment.textContent)).toEqual([zh['material.off'], zh['material.frosted'], zh['material.liquid']])
    expect(segments().map(segment => segment.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    fireEvent.click(segments()[2]!)
    expect(m.setSetting).toHaveBeenCalledWith('material', 'liquid')
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('shows the three opacities as whole percentages within their ranges', () => {
    mount()
    expect(slider(zh['material.panel']).value).toBe('82')
    expect(slider(zh['material.panel']).min).toBe('40')
    expect(slider(zh['material.composer']).value).toBe('90')
    expect(slider(zh['material.popover']).value).toBe('96')
    expect(slider(zh['material.popover']).min).toBe('60')
    expect(slider(zh['material.popover']).max).toBe('100')
    expect(within(slider(zh['material.panel']).closest('label')!).getByText('82%')).toBeTruthy()
  })

  it('writes an opacity as a fraction', () => {
    const m = mount()
    fireEvent.change(slider(zh['material.panel']), { target: { value: '55' } })
    expect(m.setSetting).toHaveBeenLastCalledWith('panelOpacity', 0.55)
    fireEvent.change(slider(zh['material.composer']), { target: { value: '70' } })
    expect(m.setSetting).toHaveBeenLastCalledWith('composerOpacity', 0.7)
    fireEvent.change(slider(zh['material.popover']), { target: { value: '99' } })
    expect(m.setSetting).toHaveBeenLastCalledWith('popoverOpacity', 0.99)
  })

  it('explains that opacity needs a backdrop to show through', () => {
    mount({ backdrop: { kind: 'none' } })
    expect(screen.getByRole('note').textContent).toBe(zh['material.noBackdrop'])
    expect(segments().every(segment => !segment.disabled)).toBe(true)
  })

  it.each([
    ['reducedTransparency', { reducedTransparency: true, highContrast: false }],
    ['highContrast', { reducedTransparency: false, highContrast: true }],
  ])('disables everything and says why when the system asks for %s', (_name, environment) => {
    const m = mount({ environment, backdrop: { kind: 'none' } })
    expect(screen.getByRole('note').textContent).toBe(zh['material.reduced'])
    expect(segments().every(segment => segment.disabled)).toBe(true)
    for (const label of [zh['material.panel'], zh['material.composer'], zh['material.popover']]) expect(slider(label).disabled).toBe(true)
    fireEvent.click(segments()[1]!)
    expect(m.setSetting).not.toHaveBeenCalled()
  })

  it('shows the saved state read-only with the permission hint', () => {
    const m = mount({
      access: { status: 'ready', writable: false, denied: false },
      settings: { ...DEFAULT_SETTINGS, material: 'liquid', panelOpacity: 0.5 },
    })
    expect(screen.getByRole('note').textContent).toBe(zh['access.readOnly'])
    expect(segments().map(segment => segment.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true'])
    expect(slider(zh['material.panel']).value).toBe('50')
    expect(segments().every(segment => segment.disabled)).toBe(true)
    expect(slider(zh['material.panel']).disabled).toBe(true)
    expect(m.setSetting).not.toHaveBeenCalled()
  })

  it('puts the system request ahead of the permission hint', () => {
    mount({
      access: { status: 'ready', writable: false, denied: false },
      environment: { reducedTransparency: true, highContrast: false },
    })
    expect(screen.getByRole('note').textContent).toBe(zh['material.reduced'])
  })
})
