// @vitest-environment jsdom
/** The Appearance section column: it renders the item slot and its glyph is the shared light icon. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { IconLightOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { AppearanceSection } from '../src/client/AppearanceSection.tsx'
import type { AppearanceSectionComponentProps } from '../src/client/AppearanceSection.tsx'
import { AppearanceNavIcon } from '../src/client/NavIcon.tsx'

afterEach(cleanup)

describe('AppearanceSection', () => {
  it('renders the item slot inside the section column', () => {
    const renderSlot = vi.fn(() => <div data-slot="settings.appearance.item"><p>row</p></div>)
    const { container } = render(<AppearanceSection {...({ renderSlot } as unknown as AppearanceSectionComponentProps)} />)
    expect(renderSlot).toHaveBeenCalledWith('settings.appearance.item', {})
    expect(container.querySelector('[data-slot="settings.appearance.item"] p')?.textContent).toBe('row')
  })
})

describe('AppearanceNavIcon', () => {
  it('draws the IconLightOutline16 glyph at the 16px nav size', () => {
    const glyph = render(<AppearanceNavIcon />).container
    const svg = glyph.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('16')
    expect(svg?.getAttribute('height')).toBe('16')
    expect(glyph.innerHTML).toBe(render(<IconLightOutline16 size={16} />).container.innerHTML)
  })
})
